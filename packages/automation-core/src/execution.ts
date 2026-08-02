import type { Frame, Locator, Page, Request } from "playwright-core";
import {
  locatorCandidatesForTarget,
  orderLocatorCandidates,
  type ElementTarget,
  type LocatorCandidate,
  type WorkflowStep,
} from "./workflow.js";

export const AUTOMATION_STEP_TIMEOUT_MS = 15_000;
export const UI_SETTLE_QUIET_MS = 200;
export const UI_SETTLE_MAX_MS = 5_000;
export const WAIT_CONDITION_STABLE_MS = 300;
const waitPollMs = 50;

export type AutomationPhase = "acting" | "settling" | "waiting";

export interface AutomationAttempt {
  kind: string;
  reason: string;
}

export interface ActionResult {
  locatorKind?: string;
  attempts: AutomationAttempt[];
}

export class AutomationCancelledError extends Error {
  constructor() {
    super("Automation was cancelled.");
    this.name = "AutomationCancelledError";
  }
}

export class AutomationExecutionError extends Error {
  constructor(
    message: string,
    readonly attempts: AutomationAttempt[] = [],
    readonly phase?: AutomationPhase,
  ) {
    super(message);
    this.name = "AutomationExecutionError";
  }
}

export interface ResolvedTarget {
  locator: Locator;
  kind: string;
  attempts: AutomationAttempt[];
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AutomationCancelledError();
}

async function cancellableSleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(waitPollMs, Math.max(0, deadline - Date.now()))),
    );
  }
  throwIfCancelled(signal);
}

function locatorFor(frame: Frame, candidate: LocatorCandidate): Locator {
  switch (candidate.kind) {
    case "testId":
      return frame.getByTestId(candidate.value);
    case "role":
      return frame.getByRole(candidate.value as Parameters<Frame["getByRole"]>[0], {
        name: candidate.name,
        exact: candidate.exact,
      });
    case "accessibleName":
    case "label":
      return frame.getByLabel(candidate.value, { exact: candidate.exact });
    case "text":
      return frame.getByText(candidate.value, { exact: candidate.exact });
    case "css":
      return frame.locator(candidate.value);
    case "xpath":
      return frame.locator(`xpath=${candidate.value}`);
  }
}

function normalizedFrameUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

function resolveFrame(page: Page, frameUrl?: string, recordedPageUrl?: string): Frame {
  const mainFrame = page.mainFrame();
  if (!frameUrl) return mainFrame;

  const recordedFrame = normalizedFrameUrl(frameUrl);
  const recordedPage = recordedPageUrl ? normalizedFrameUrl(recordedPageUrl) : null;
  const currentMain = normalizedFrameUrl(mainFrame.url());
  if (
    (recordedFrame && recordedPage && recordedFrame === recordedPage) ||
    mainFrame.url() === frameUrl ||
    (recordedFrame && currentMain === recordedFrame)
  ) {
    return mainFrame;
  }

  const childFrames = page.frames().filter((candidate) => candidate !== mainFrame);
  const exact = childFrames.filter((candidate) => candidate.url() === frameUrl);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new AutomationExecutionError("Multiple frames match the recorded frame URL.", [
      { kind: "frame", reason: "Recorded frame URL matched multiple frames." },
    ]);
  }
  if (recordedFrame) {
    const normalized = childFrames.filter(
      (candidate) => normalizedFrameUrl(candidate.url()) === recordedFrame,
    );
    if (normalized.length === 1) return normalized[0]!;
    if (normalized.length > 1) {
      throw new AutomationExecutionError("Multiple frames match the recorded frame address.", [
        { kind: "frame", reason: "Recorded frame origin and path matched multiple frames." },
      ]);
    }
  }

  throw new AutomationExecutionError("The recorded frame is not available on this page.", [
    { kind: "frame", reason: "Recorded frame URL was not found." },
  ]);
}

export async function resolveTarget(
  page: Page,
  target: ElementTarget,
  recordedPageUrl?: string,
  signal?: AbortSignal,
  stepTimeoutMs = AUTOMATION_STEP_TIMEOUT_MS,
): Promise<ResolvedTarget> {
  const frame = resolveFrame(page, target.frameUrl, recordedPageUrl);
  const attempts: AutomationAttempt[] = [];
  const candidates = orderLocatorCandidates(locatorCandidatesForTarget(target));
  const deadline = Date.now() + stepTimeoutMs;
  do {
    throwIfCancelled(signal);
    attempts.splice(0);
    for (const candidate of candidates) {
      try {
        const locator = locatorFor(frame, candidate);
        const count = await locator.count();
        throwIfCancelled(signal);
        if (count !== 1) {
          attempts.push({
            kind: candidate.kind,
            reason: count ? `Matched ${count} elements.` : "No match.",
          });
          continue;
        }
        if (!(await locator.isVisible())) {
          attempts.push({ kind: candidate.kind, reason: "The only match is not visible." });
          continue;
        }
        return { locator, kind: candidate.kind, attempts: [...attempts] };
      } catch (error) {
        if (error instanceof AutomationCancelledError) throw error;
        attempts.push({ kind: candidate.kind, reason: "Locator could not be evaluated." });
      }
    }
    await cancellableSleep(250, signal);
  } while (Date.now() < deadline);

  throw new AutomationExecutionError(
    "No locator resolved to one visible element within the configured timeout.",
    attempts,
  );
}

export async function applyPositionBefore(
  page: Page,
  step: WorkflowStep,
  signal?: AbortSignal,
): Promise<void> {
  if (!step.position) return;
  throwIfCancelled(signal);
  const frame = resolveFrame(page, step.position.frameUrl, step.page.url);
  try {
    await frame.evaluate(
      async ({ x, y }) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          window.scrollTo({ left: x, top: y, behavior: "instant" as ScrollBehavior });
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          if (Math.abs(window.scrollX - x) <= 1 && Math.abs(window.scrollY - y) <= 1) break;
        }
      },
      { x: step.position.x, y: step.position.y },
    );
    throwIfCancelled(signal);
  } catch (error) {
    if (error instanceof AutomationCancelledError || error instanceof AutomationExecutionError) {
      throw error;
    }
    throw new AutomationExecutionError("The recorded page position could not be restored.");
  }
}

export async function executeStepAction(
  page: Page,
  step: WorkflowStep,
  signal?: AbortSignal,
  stepTimeoutMs = AUTOMATION_STEP_TIMEOUT_MS,
): Promise<ActionResult> {
  await applyPositionBefore(page, step, signal);
  throwIfCancelled(signal);
  try {
    if (step.type === "navigate") {
      await page.goto(step.payload.url, {
        waitUntil: "domcontentloaded",
        timeout: stepTimeoutMs,
      });
      throwIfCancelled(signal);
      return { attempts: [] };
    }

    const resolved = await resolveTarget(page, step.target, step.page.url, signal, stepTimeoutMs);
    const options = { timeout: stepTimeoutMs };
    switch (step.type) {
      case "click":
        await resolved.locator.click(options);
        break;
      case "fill":
      case "set_date":
        await resolved.locator.fill(step.payload.value, options);
        break;
      case "select":
        try {
          await resolved.locator.selectOption({ value: step.payload.value }, options);
        } catch (error) {
          if (!step.payload.label) throw error;
          await resolved.locator.selectOption({ label: step.payload.label }, options);
        }
        break;
      case "check":
        await resolved.locator.check(options);
        break;
      case "uncheck":
        await resolved.locator.uncheck(options);
        break;
      case "keypress":
        await resolved.locator.press([...step.payload.modifiers, step.payload.key].join("+"), options);
        break;
      case "submit": {
        const submitted = await resolved.locator.evaluate(
          (element) => {
            if (element instanceof HTMLFormElement) {
              element.requestSubmit();
              return true;
            }
            const form = element instanceof HTMLElement ? element.closest("form") : null;
            if (form) form.requestSubmit();
            return Boolean(form);
          },
          undefined,
          options,
        );
        if (!submitted) {
          throw new AutomationExecutionError("The submit target is not inside a form.");
        }
        break;
      }
    }
    throwIfCancelled(signal);
    return { locatorKind: resolved.kind, attempts: resolved.attempts };
  } catch (error) {
    if (error instanceof AutomationCancelledError || error instanceof AutomationExecutionError) {
      throw error;
    }
    throw new AutomationExecutionError("The automation action could not be completed.");
  }
}

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
    let phase: AutomationPhase = "acting";
    const enterPhase = (next: AutomationPhase) => {
      phase = next;
      onPhase?.(next);
    };
    try {
      enterPhase("acting");
      this.lastNetworkActivity = Date.now();
      const result = await executeStepAction(
        this.page,
        step,
        this.signal,
        this.stepTimeoutMs,
      );
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
        phase === "acting"
          ? "The automation action could not be completed."
          : phase === "settling"
            ? "The page did not settle after the automation action."
            : "The post-action wait could not be completed.";
      throw new AutomationExecutionError(message, [], phase);
    }
  }
}
