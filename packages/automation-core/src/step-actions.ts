import type { Page } from "playwright-core";
import { locatorCandidatesForTarget, type WorkflowStep } from "./workflow.js";
import {
  AutomationCancelledError,
  AutomationExecutionError,
  throwIfCancelled,
  type AutomationAttempt,
} from "./execution-errors.js";
import {
  AUTOMATION_STEP_TIMEOUT_MS,
  attemptTargetResolution,
  resolveFrame,
  resolveTarget,
} from "./target-resolution.js";

export interface ActionResult {
  locatorKind?: string;
  attempts: AutomationAttempt[];
}

function normalizeAssertionText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
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
  try {
    await applyPositionBefore(page, step, signal);
    throwIfCancelled(signal);
    if (step.type === "navigate") {
      await page.goto(step.payload.url, {
        waitUntil: "domcontentloaded",
        timeout: stepTimeoutMs,
      });
      throwIfCancelled(signal);
      return { attempts: [] };
    }

    if (step.type === "assertion") {
      const attempt = await attemptTargetResolution(page, step.target, step.page.url, signal);
      if (!attempt.resolved) {
        throw new AutomationExecutionError(
          "The automation assertion did not pass.",
          attempt.attempts,
        );
      }
      if (step.expectation.kind === "text_contains") {
        const observed = normalizeAssertionText(await attempt.resolved.locator.innerText());
        const expected = normalizeAssertionText(step.expectation.expected);
        if (!observed.includes(expected)) {
          throw new AutomationExecutionError(
            "The automation assertion did not pass.",
            attempt.resolved.attempts,
          );
        }
      }
      throwIfCancelled(signal);
      return {
        locatorKind: attempt.resolved.kind,
        attempts: attempt.resolved.attempts,
      };
    }

    const resolved = await resolveTarget(page, step.target, step.page.url, signal, stepTimeoutMs);
    const options = { timeout: stepTimeoutMs };
    switch (step.type) {
      case "click":
        await resolved.locator.click(options);
        break;
      case "fill":
        if (
          locatorCandidatesForTarget(step.target).some(
            (candidate) => candidate.kind === "role" && candidate.value === "combobox",
          )
        ) {
          await resolved.locator.focus(options);
          await resolved.locator.press("ControlOrMeta+A", options);
          await resolved.locator.press("Backspace", options);
          await resolved.locator.pressSequentially(step.payload.value, {
            ...options,
            delay: 20,
          });
          break;
        }
        await resolved.locator.fill(step.payload.value, options);
        break;
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
    if (error instanceof AutomationCancelledError) throw error;
    if (step.type === "assertion") {
      throw new AutomationExecutionError(
        "The automation assertion did not pass.",
        error instanceof AutomationExecutionError ? error.attempts : [],
      );
    }
    if (error instanceof AutomationExecutionError) throw error;
    throw new AutomationExecutionError("The automation action could not be completed.");
  }
}
