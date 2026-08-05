export type AutomationPhase = "acting" | "asserting" | "settling" | "waiting";

export interface AutomationAttempt {
  kind: string;
  reason: string;
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

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AutomationCancelledError();
}

export async function cancellableSleep(
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
    );
  }
  throwIfCancelled(signal);
}
