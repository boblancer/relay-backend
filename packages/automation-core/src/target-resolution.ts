import type { Frame, Locator, Page } from "playwright-core";
import {
  locatorCandidatesForTarget,
  orderLocatorCandidates,
  type ElementTarget,
  type LocatorCandidate,
} from "./workflow.js";
import {
  AutomationCancelledError,
  AutomationExecutionError,
  cancellableSleep,
  throwIfCancelled,
  type AutomationAttempt,
} from "./execution-errors.js";

export const AUTOMATION_STEP_TIMEOUT_MS = 15_000;

export interface ResolvedTarget {
  locator: Locator;
  kind: string;
  attempts: AutomationAttempt[];
}

export interface TargetResolutionAttempt {
  resolved?: ResolvedTarget;
  attempts: AutomationAttempt[];
}

export function locatorFor(frame: Frame, candidate: LocatorCandidate): Locator {
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

export function resolveFrame(page: Page, frameUrl?: string, recordedPageUrl?: string): Frame {
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

type ElementFingerprint = { tagName: string; inputType?: string };

async function matchesRecordedFingerprint(
  locator: Locator,
  target: ElementTarget,
): Promise<boolean> {
  const expectedTagName = target.tagName?.toLowerCase();
  const expectedInputType = target.inputType?.toLowerCase();
  if (!expectedTagName && !expectedInputType) return true;
  const observed = await locator.evaluate((element): ElementFingerprint => {
    const tagName = element.tagName.toLowerCase();
    return {
      tagName,
      ...(tagName === "input"
        ? { inputType: (element as HTMLInputElement).type.toLowerCase() }
        : {}),
    };
  });
  if (expectedTagName && observed.tagName !== expectedTagName) return false;
  return !expectedInputType || observed.inputType === expectedInputType;
}

export async function attemptTargetResolution(
  page: Page,
  target: ElementTarget,
  recordedPageUrl?: string,
  signal?: AbortSignal,
): Promise<TargetResolutionAttempt> {
  const frame = resolveFrame(page, target.frameUrl, recordedPageUrl);
  const attempts: AutomationAttempt[] = [];
  const candidates = orderLocatorCandidates(locatorCandidatesForTarget(target));
  throwIfCancelled(signal);
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
      const visible = await locator.isVisible();
      throwIfCancelled(signal);
      if (!visible) {
        attempts.push({ kind: candidate.kind, reason: "The only match is not visible." });
        continue;
      }
      const fingerprintMatches = await matchesRecordedFingerprint(locator, target);
      throwIfCancelled(signal);
      if (!fingerprintMatches) {
        attempts.push({
          kind: candidate.kind,
          reason: "The matched element does not match the recorded element fingerprint.",
        });
        continue;
      }
      return { resolved: { locator, kind: candidate.kind, attempts: [...attempts] }, attempts };
    } catch (error) {
      if (error instanceof AutomationCancelledError) throw error;
      attempts.push({ kind: candidate.kind, reason: "Locator could not be evaluated." });
    }
  }
  return { attempts };
}

export async function resolveTarget(
  page: Page,
  target: ElementTarget,
  recordedPageUrl?: string,
  signal?: AbortSignal,
  stepTimeoutMs = AUTOMATION_STEP_TIMEOUT_MS,
): Promise<ResolvedTarget> {
  const deadline = Date.now() + stepTimeoutMs;
  let attempts: AutomationAttempt[] = [];
  do {
    const attempt = await attemptTargetResolution(page, target, recordedPageUrl, signal);
    attempts = attempt.attempts;
    if (attempt.resolved) return attempt.resolved;
    await cancellableSleep(250, signal);
  } while (Date.now() < deadline);

  throw new AutomationExecutionError(
    "No locator resolved to one visible element within the configured timeout.",
    attempts,
  );
}
