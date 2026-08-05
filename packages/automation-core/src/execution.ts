import type { Locator, Page, Request } from "playwright-core";
import {
  locatorCandidatesForTarget,
  orderLocatorCandidates,
  type ElementTarget,
  type WorkflowStep,
} from "./workflow.js";
import {
  AutomationCancelledError,
  AutomationExecutionError,
  cancellableSleep,
  throwIfCancelled,
  type AutomationAttempt,
  type AutomationPhase,
} from "./execution-errors.js";
import {
  AUTOMATION_STEP_TIMEOUT_MS,
  locatorFor,
  resolveFrame,
} from "./target-resolution.js";
import { executeStepAction, type ActionResult } from "./step-actions.js";

export { AutomationCancelledError, AutomationExecutionError } from "./execution-errors.js";
export type { AutomationAttempt, AutomationPhase } from "./execution-errors.js";
export { AUTOMATION_STEP_TIMEOUT_MS, resolveTarget } from "./target-resolution.js";
export type { ResolvedTarget } from "./target-resolution.js";
export { applyPositionBefore, executeStepAction } from "./step-actions.js";
export type { ActionResult } from "./step-actions.js";

export const UI_SETTLE_QUIET_MS = 200;
export const UI_SETTLE_MAX_MS = 5_000;
export const WAIT_CONDITION_STABLE_MS = 300;
const waitPollMs = 50;

export class AutomationExecutor {
  private readonly activeRequests = new Set<Request>();
  private lastNetworkActivity = 0;
  private networkTracked = false;

  constructor(
    private readonly page: Page,
    private readonly signal?: AbortSignal,
    private readonly stepTimeoutMs = AUTOMATION_STEP_TIMEOUT_MS,
  ) {}

  private readonly onRequest = (request: Request): void => {
    if (["eventsource", "websocket"].includes(request.resourceType())) return;
    this.activeRequests.add(request);
    this.lastNetworkActivity = Date.now();
  };

  private readonly onRequestDone = (request: Request): void => {
    if (!this.activeRequests.delete(request)) return;
    this.lastNetworkActivity = Date.now();
  };

  private startActivityTracking(): void {
    if (this.networkTracked) return;
    const events = this.page as unknown as {
      on?: (event: string, listener: (request: Request) => void) => void;
      off?: (event: string, listener: (request: Request) => void) => void;
    };
    if (typeof events.on !== "function" || typeof events.off !== "function") return;
    events.on("request", this.onRequest);
    events.on("requestfinished", this.onRequestDone);
    events.on("requestfailed", this.onRequestDone);
    this.networkTracked = true;
  }

  dispose(): void {
    if (!this.networkTracked) return;
    this.page.off("request", this.onRequest);
    this.page.off("requestfinished", this.onRequestDone);
    this.page.off("requestfailed", this.onRequestDone);
    this.activeRequests.clear();
    this.networkTracked = false;
  }

  async openInitialPage(url: string): Promise<void> {
    this.startActivityTracking();
    throwIfCancelled(this.signal);
    try {
      this.lastNetworkActivity = Date.now();
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.stepTimeoutMs,
      });
      throwIfCancelled(this.signal);
      await this.waitForAutomaticSettle();
    } catch (error) {
      if (error instanceof AutomationCancelledError || error instanceof AutomationExecutionError) {
        throw error;
      }
      throw new AutomationExecutionError("The initial automation page could not be opened.");
    }
  }

  private async resetDomActivity(): Promise<boolean> {
    if (typeof (this.page as unknown as { evaluate?: unknown }).evaluate !== "function") return false;
    try {
      await this.page.evaluate(() => {
        type MutationState = { lastMutation: number; observer: MutationObserver };
        const host = window as Window & { __relayAutomationMutationState?: MutationState };
        const existing = host.__relayAutomationMutationState;
        if (existing) {
          existing.lastMutation = performance.now();
          return;
        }
        const state: MutationState = {
          lastMutation: performance.now(),
          observer: new MutationObserver(() => {
            state.lastMutation = performance.now();
          }),
        };
        state.observer.observe(document.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        host.__relayAutomationMutationState = state;
      });
      return true;
    } catch {
      return false;
    }
  }

  private async domIsQuiet(): Promise<boolean | null> {
    try {
      const result = await this.page.evaluate((quietMs) => {
        const host = window as Window & {
          __relayAutomationMutationState?: { lastMutation: number };
        };
        const state = host.__relayAutomationMutationState;
        return Boolean(state && performance.now() - state.lastMutation >= quietMs);
      }, UI_SETTLE_QUIET_MS);
      return typeof result === "boolean" ? result : null;
    } catch {
      return null;
    }
  }

  private async waitForAutomaticSettle(): Promise<void> {
    const evaluateAvailable =
      typeof (this.page as unknown as { evaluate?: unknown }).evaluate === "function";
    if (!evaluateAvailable && !this.networkTracked) return;
    const deadline = Date.now() + UI_SETTLE_MAX_MS;
    if (typeof (this.page as unknown as { waitForLoadState?: unknown }).waitForLoadState === "function") {
      try {
        await this.page.waitForLoadState("domcontentloaded", { timeout: UI_SETTLE_MAX_MS });
      } catch {
        // The quietness checks below remain useful when a load-state wait times out.
      }
    }
    throwIfCancelled(this.signal);
    let domTracked = await this.resetDomActivity();
    this.lastNetworkActivity = Math.max(this.lastNetworkActivity, Date.now());
    while (Date.now() < deadline) {
      throwIfCancelled(this.signal);
      const domState = domTracked ? await this.domIsQuiet() : null;
      if (domState === null) domTracked = false;
      const domQuiet = !domTracked || domState === true;
      const networkQuiet =
        !this.networkTracked ||
        (this.activeRequests.size === 0 &&
          Date.now() - this.lastNetworkActivity >= UI_SETTLE_QUIET_MS);
      if (domQuiet && networkQuiet) return;
      await cancellableSleep(Math.min(waitPollMs, Math.max(0, deadline - Date.now())), this.signal);
    }
  }

  private async locatorHasVisibleMatch(locator: Locator, count: number): Promise<boolean> {
    for (let index = 0; index < count; index += 1) {
      const candidate = count === 1 ? locator : locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async waitConditionState(
    target: ElementTarget,
    state: "visible" | "hidden",
    recordedPageUrl: string,
  ): Promise<void> {
    const deadline = Date.now() + this.stepTimeoutMs;
    let stableSince: number | null = null;
    let attempts: AutomationAttempt[] = [];
    while (Date.now() < deadline) {
      throwIfCancelled(this.signal);
      const nextAttempts: AutomationAttempt[] = [];
      let anyVisible = false;
      let frameAvailable = true;
      let candidateEvaluated = false;
      try {
        const frame = resolveFrame(this.page, target.frameUrl, recordedPageUrl);
        for (const candidate of orderLocatorCandidates(locatorCandidatesForTarget(target))) {
          try {
            const locator = locatorFor(frame, candidate);
            const count = await locator.count();
            candidateEvaluated = true;
            const visible = count > 0 && (await this.locatorHasVisibleMatch(locator, count));
            anyVisible ||= visible;
            nextAttempts.push({
              kind: candidate.kind,
              reason: visible
                ? `Matched ${count} visible element${count === 1 ? "" : "s"}.`
                : count
                  ? "Matches are hidden."
                  : "No match.",
            });
          } catch {
            nextAttempts.push({ kind: candidate.kind, reason: "Locator could not be evaluated." });
          }
        }
      } catch (error) {
        frameAvailable = false;
        nextAttempts.push({
          kind: "frame",
          reason:
            error instanceof AutomationExecutionError
              ? error.attempts[0]?.reason ?? "Recorded frame URL was not found."
              : "Recorded frame URL was not found.",
        });
      }
      attempts = nextAttempts;
      const satisfied =
        frameAvailable && candidateEvaluated && (state === "visible" ? anyVisible : !anyVisible);
      if (satisfied) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= WAIT_CONDITION_STABLE_MS) return;
      } else {
        stableSince = null;
      }
      await cancellableSleep(waitPollMs, this.signal);
    }
    throw new AutomationExecutionError(
      `Wait condition did not remain ${state} within the configured timeout.`,
      attempts,
    );
  }

  async runStep(
    step: WorkflowStep,
    onPhase?: (phase: AutomationPhase) => void,
  ): Promise<ActionResult> {
    this.startActivityTracking();
    let phase: AutomationPhase = step.type === "assertion" ? "asserting" : "acting";
    const enterPhase = (next: AutomationPhase) => {
      phase = next;
      onPhase?.(next);
    };
    try {
      enterPhase(phase);
      this.lastNetworkActivity = Date.now();
      const result = await executeStepAction(
        this.page,
        step,
        this.signal,
        this.stepTimeoutMs,
      );
      if (step.type === "assertion") {
        throwIfCancelled(this.signal);
        return result;
      }
      enterPhase("settling");
      await this.waitForAutomaticSettle();
      if (step.waitAfter?.delayMs) {
        enterPhase("waiting");
        await cancellableSleep(step.waitAfter.delayMs, this.signal);
      }
      if (step.waitAfter?.condition) {
        enterPhase("waiting");
        await this.waitConditionState(
          step.waitAfter.condition.target,
          step.waitAfter.condition.state,
          step.page.url,
        );
      }
      throwIfCancelled(this.signal);
      return result;
    } catch (error) {
      if (error instanceof AutomationCancelledError) throw error;
      if (error instanceof AutomationExecutionError) {
        throw new AutomationExecutionError(error.message, error.attempts, phase);
      }
      const message =
        phase === "asserting"
          ? "The automation assertion did not pass."
          : phase === "acting"
          ? "The automation action could not be completed."
          : phase === "settling"
            ? "The page did not settle after the automation action."
            : "The post-action wait could not be completed.";
      throw new AutomationExecutionError(message, [], phase);
    }
  }
}
