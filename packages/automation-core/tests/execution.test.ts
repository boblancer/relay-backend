import { describe, expect, it, vi } from "vitest";
import type { Frame, Locator, Page } from "playwright-core";
import type { WorkflowStep } from "../src/index.js";
import {
  AutomationCancelledError,
  AutomationExecutionError,
  applyPositionBefore,
  executeStepAction,
  resolveTarget,
} from "../src/execution.js";
import { isRedundantOptionClickBeforeSelect } from "../src/redundant-option-click.js";

const recordedAt = "2026-07-31T12:00:00Z";
const target = { candidates: [{ kind: "testId" as const, value: "target", exact: true }] };

function baseStep(order: number) {
  return {
    id: `step-${order}`,
    order,
    name: `Step ${order}`,
    enabled: true,
    page: { id: "page", url: "https://example.com/form" },
    target,
    metadata: { recordedAt, origin: "recorded" as const, sensitive: false },
  };
}

function automationPage() {
  const locator = {
    check: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    count: vi.fn(async () => 1),
    evaluate: vi.fn(async () => true),
    fill: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    innerText: vi.fn(async () => "Ready   FOR\nreview"),
    isVisible: vi.fn(async () => true),
    press: vi.fn(async () => undefined),
    pressSequentially: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => ["value"]),
    uncheck: vi.fn(async () => undefined),
  } as unknown as Locator;
  const frame = {
    evaluate: vi.fn(async () => undefined),
    getByLabel: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByTestId: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
    url: vi.fn(() => "https://example.com/form"),
  } as unknown as Frame;
  const page = {
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async () => null),
    mainFrame: vi.fn(() => frame),
  } as unknown as Page;
  return { frame, locator, page };
}

describe("executeStepAction", () => {
  it("executes every canonical action", async () => {
    const steps: WorkflowStep[] = [
      {
        ...baseStep(0),
        type: "navigate",
        payload: { url: "https://example.com/form" },
      },
      { ...baseStep(1), type: "click" },
      {
        ...baseStep(2),
        type: "fill",
        payload: { value: "resolved value" },
        parameterBinding: { source: "runtime" },
      },
      { ...baseStep(3), type: "set_date", payload: { value: "2026-07-31" } },
      {
        ...baseStep(4),
        type: "select",
        payload: { value: "one", label: "One" },
      },
      { ...baseStep(5), type: "check" },
      { ...baseStep(6), type: "uncheck" },
      {
        ...baseStep(7),
        type: "keypress",
        payload: { key: "Enter", modifiers: ["Control"] },
      },
      { ...baseStep(8), type: "submit" },
    ];
    const { locator, page } = automationPage();

    for (const step of steps) await executeStepAction(page, step);

    expect(page.goto).toHaveBeenCalledOnce();
    expect(locator.click).toHaveBeenCalledOnce();
    expect(locator.fill).toHaveBeenNthCalledWith(1, "resolved value", expect.anything());
    expect(locator.fill).toHaveBeenNthCalledWith(2, "2026-07-31", expect.anything());
    expect(locator.selectOption).toHaveBeenCalledWith({ value: "one" }, expect.anything());
    expect(locator.check).toHaveBeenCalledOnce();
    expect(locator.uncheck).toHaveBeenCalledOnce();
    expect(locator.press).toHaveBeenCalledWith("Control+Enter", expect.anything());
    expect(locator.evaluate).toHaveBeenCalledOnce();
  });

  it("falls back to a select label when selecting by value fails", async () => {
    const { locator, page } = automationPage();
    vi.mocked(locator.selectOption)
      .mockRejectedValueOnce(new Error("value unavailable"))
      .mockResolvedValueOnce(["one"]);

    await executeStepAction(page, {
      ...baseStep(0),
      type: "select",
      payload: { value: "unknown", label: "One" },
    });

    expect(locator.selectOption).toHaveBeenLastCalledWith({ label: "One" }, expect.anything());
  });

  it("types naturally into combobox fills without changing ordinary fills", async () => {
    const { locator, page } = automationPage();
    const ordinary: WorkflowStep = {
      ...baseStep(0),
      type: "fill",
      payload: { value: "ordinary value" },
      parameterBinding: { source: "recorded" },
    };
    const combobox: WorkflowStep = {
      ...baseStep(1),
      type: "fill",
      target: {
        candidates: [{ kind: "role", value: "combobox", name: "Location", exact: true }],
      },
      payload: { value: "typed value" },
      parameterBinding: { source: "recorded" },
    };

    await executeStepAction(page, ordinary);
    await executeStepAction(page, combobox);

    expect(locator.fill).toHaveBeenCalledOnce();
    expect(locator.fill).toHaveBeenCalledWith("ordinary value", expect.anything());
    expect(locator.focus).toHaveBeenCalledOnce();
    expect(locator.press).toHaveBeenNthCalledWith(1, "ControlOrMeta+A", expect.anything());
    expect(locator.press).toHaveBeenNthCalledWith(2, "Backspace", expect.anything());
    expect(locator.pressSequentially).toHaveBeenCalledWith(
      "typed value",
      expect.objectContaining({ delay: 20 }),
    );
  });

  it("restores the recorded frame position before resolving the action", async () => {
    const { frame, page } = automationPage();

    await executeStepAction(page, {
      ...baseStep(0),
      type: "click",
      position: { x: 40, y: 120 },
    });

    expect(frame.evaluate).toHaveBeenCalledWith(expect.any(Function), { x: 40, y: 120 });
  });

  it("never exposes action, target, or payload values in failures", async () => {
    const { locator, page } = automationPage();
    vi.mocked(locator.click).mockRejectedValue(
      new Error("secret-selector secret-payload https://private.example.test"),
    );

    const error = await executeStepAction(page, {
      ...baseStep(0),
      type: "click",
      target: { candidates: [{ kind: "css", value: "secret-selector", exact: true }] },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AutomationExecutionError);
    expect(JSON.stringify(error)).not.toMatch(/secret-selector|secret-payload|private\.example/);
    expect((error as Error).message).toBe("The automation action could not be completed.");
  });

  it("evaluates visible and normalized text assertions", async () => {
    const { locator, page } = automationPage();
    const visible: WorkflowStep = {
      ...baseStep(0),
      type: "assertion",
      expectation: { kind: "visible" },
    };
    const text: WorkflowStep = {
      ...baseStep(1),
      type: "assertion",
      expectation: { kind: "text_contains", expected: "ready for REVIEW" },
    };

    await expect(executeStepAction(page, visible)).resolves.toMatchObject({
      locatorKind: "testId",
    });
    await expect(executeStepAction(page, text)).resolves.toMatchObject({
      locatorKind: "testId",
    });
    expect(locator.innerText).toHaveBeenCalledOnce();
  });

  it("returns a fixed privacy-safe failure when assertion text does not match", async () => {
    const { locator, page } = automationPage();
    vi.mocked(locator.innerText).mockResolvedValue("private observed page content");

    const error = await executeStepAction(page, {
      ...baseStep(0),
      type: "assertion",
      expectation: { kind: "text_contains", expected: "private expected content" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AutomationExecutionError);
    expect((error as Error).message).toBe("The automation assertion did not pass.");
    expect(JSON.stringify(error)).not.toMatch(/private expected|private observed/);
  });

  it.each([
    { count: 0, visible: true, reason: "No match." },
    { count: 2, visible: true, reason: "Matched 2 elements." },
    { count: 1, visible: false, reason: "The only match is not visible." },
  ])("fails an unresolved assertion once without retrying", async ({ count, visible, reason }) => {
    const { locator, page } = automationPage();
    vi.mocked(locator.count).mockResolvedValue(count);
    vi.mocked(locator.isVisible).mockResolvedValue(visible);

    await expect(
      executeStepAction(page, {
        ...baseStep(0),
        type: "assertion",
        expectation: { kind: "visible" },
      }),
    ).rejects.toMatchObject({
      message: "The automation assertion did not pass.",
      attempts: [{ kind: "testId", reason }],
    });
    expect(locator.count).toHaveBeenCalledOnce();
  });

  it("honors cancellation before evaluating an assertion", async () => {
    const controller = new AbortController();
    controller.abort();
    const { locator, page } = automationPage();

    await expect(
      executeStepAction(
        page,
        {
          ...baseStep(0),
          type: "assertion",
          expectation: { kind: "visible" },
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(AutomationCancelledError);
    expect(locator.count).not.toHaveBeenCalled();
  });
});

describe("target and frame resolution", () => {
  it("uses the main frame when its exact URL matches the recording", async () => {
    const { frame, locator, page } = automationPage();

    const resolved = await resolveTarget(
      page,
      { ...target, frameUrl: frame.url() },
      "https://different.example.test/page",
    );

    expect(resolved.locator).toBe(locator);
    expect(page.frames).not.toHaveBeenCalled();
  });

  it("matches a child frame by exact URL before normalizing it", async () => {
    const { locator } = automationPage();
    const mainFrame = { url: vi.fn(() => "https://example.com/form") } as unknown as Frame;
    const childFrame = {
      getByTestId: vi.fn(() => locator),
      url: vi.fn(() => "https://widgets.example.com/embed?token=exact"),
    } as unknown as Frame;
    const page = {
      frames: vi.fn(() => [mainFrame, childFrame]),
      mainFrame: vi.fn(() => mainFrame),
    } as unknown as Page;

    const resolved = await resolveTarget(page, {
      ...target,
      frameUrl: "https://widgets.example.com/embed?token=exact",
    });

    expect(resolved.locator).toBe(locator);
  });

  it("tries candidates in priority order until one uniquely resolves", async () => {
    const { frame, locator, page } = automationPage();
    const missing = {
      count: vi.fn(async () => 0),
      isVisible: vi.fn(async () => false),
    } as unknown as Locator;
    vi.mocked(frame.getByTestId).mockReturnValue(missing);

    const resolved = await resolveTarget(page, {
      candidates: [
        { kind: "css", value: "#target", exact: true },
        { kind: "testId", value: "target", exact: true },
      ],
    });

    expect(resolved.locator).toBe(locator);
    expect(resolved.kind).toBe("css");
    expect(resolved.attempts).toEqual([{ kind: "testId", reason: "No match." }]);
  });

  it.each([
    { tagName: "button" },
    { tagName: "input", inputType: "email" },
  ])(
    "falls back when a unique visible match has the wrong recorded fingerprint",
    async (observedFingerprint) => {
      const { frame, locator, page } = automationPage();
      const wrongElement = {
        count: vi.fn(async () => 1),
        evaluate: vi.fn(async () => observedFingerprint),
        isVisible: vi.fn(async () => true),
      } as unknown as Locator;
      vi.mocked(locator.evaluate).mockResolvedValue({ tagName: "input", inputType: "text" });
      vi.mocked(frame.getByRole).mockReturnValue(wrongElement);

      const resolved = await resolveTarget(page, {
        tagName: "input",
        inputType: "text",
        candidates: [
          { kind: "role", value: "textbox", exact: true },
          { kind: "css", value: "input", exact: true },
        ],
      });

      expect(resolved.locator).toBe(locator);
      expect(resolved.kind).toBe("css");
      expect(resolved.attempts).toEqual([
        {
          kind: "role",
          reason: "The matched element does not match the recorded element fingerprint.",
        },
      ]);
    },
  );

  it("honors cancellation while validating a recorded fingerprint", async () => {
    const controller = new AbortController();
    const { locator, page } = automationPage();
    vi.mocked(locator.evaluate).mockImplementation(async () => {
      controller.abort();
      return { tagName: "input", inputType: "text" };
    });

    await expect(
      resolveTarget(
        page,
        { ...target, tagName: "input", inputType: "text" },
        undefined,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(AutomationCancelledError);
  });

  it("matches a child frame by normalized origin and path", async () => {
    const { locator } = automationPage();
    const mainFrame = { url: vi.fn(() => "https://example.com/form") } as unknown as Frame;
    const childFrame = {
      getByTestId: vi.fn(() => locator),
      url: vi.fn(() => "https://widgets.example.com/embed/?token=new#current"),
    } as unknown as Frame;
    const page = {
      frames: vi.fn(() => [mainFrame, childFrame]),
      mainFrame: vi.fn(() => mainFrame),
    } as unknown as Page;

    const resolved = await resolveTarget(
      page,
      { ...target, frameUrl: "https://widgets.example.com/embed?token=old" },
      "https://example.com/form",
    );

    expect(resolved.locator).toBe(locator);
  });

  it("returns safe diagnostics for an unavailable frame", async () => {
    const { frame, page } = automationPage();
    await expect(
      resolveTarget(
        page,
        { ...target, frameUrl: "https://secret-frame.example.test/embed" },
        frame.url(),
      ),
    ).rejects.toMatchObject({
      message: "The recorded frame is not available on this page.",
      attempts: [{ kind: "frame", reason: "Recorded frame URL was not found." }],
    });
  });

  it("rejects ambiguous exact child-frame matches", async () => {
    const mainFrame = { url: vi.fn(() => "https://example.com/form") } as unknown as Frame;
    const childFrames = [1, 2].map(
      () =>
        ({ url: vi.fn(() => "https://widgets.example.com/embed?token=exact") }) as unknown as Frame,
    );
    const page = {
      frames: vi.fn(() => [mainFrame, ...childFrames]),
      mainFrame: vi.fn(() => mainFrame),
    } as unknown as Page;

    await expect(
      resolveTarget(page, {
        ...target,
        frameUrl: "https://widgets.example.com/embed?token=exact",
      }),
    ).rejects.toMatchObject({
      message: "Multiple frames match the recorded frame URL.",
      attempts: [{ kind: "frame", reason: "Recorded frame URL matched multiple frames." }],
    });
  });

  it("rejects ambiguous normalized child-frame matches", async () => {
    const mainFrame = { url: vi.fn(() => "https://example.com/form") } as unknown as Frame;
    const childFrames = ["new", "current"].map(
      (token) =>
        ({
          url: vi.fn(() => `https://widgets.example.com/embed/?token=${token}`),
        }) as unknown as Frame,
    );
    const page = {
      frames: vi.fn(() => [mainFrame, ...childFrames]),
      mainFrame: vi.fn(() => mainFrame),
    } as unknown as Page;

    await expect(
      resolveTarget(page, {
        ...target,
        frameUrl: "https://widgets.example.com/embed?token=recorded",
      }),
    ).rejects.toMatchObject({
      message: "Multiple frames match the recorded frame address.",
      attempts: [
        { kind: "frame", reason: "Recorded frame origin and path matched multiple frames." },
      ],
    });
  });
});

describe("applyPositionBefore", () => {
  it("is a no-op when a step has no recorded position", async () => {
    const { frame, page } = automationPage();
    await applyPositionBefore(page, { ...baseStep(0), type: "click" });
    expect(frame.evaluate).not.toHaveBeenCalled();
  });
});

describe("redundant recorded option clicks", () => {
  it("skips only an option click immediately followed by its semantic select", () => {
    const click: WorkflowStep = {
      ...baseStep(0),
      type: "click",
      name: "Illinois",
      target: {
        tagName: "option",
        candidates: [{ kind: "role", value: "option", name: "Illinois", exact: true }],
      },
    };
    const select: WorkflowStep = {
      ...baseStep(1),
      type: "select",
      payload: { value: "IL", label: "Illinois" },
    };

    expect(isRedundantOptionClickBeforeSelect(click, select)).toBe(true);
    expect(
      isRedundantOptionClickBeforeSelect(
        { ...click, metadata: { ...click.metadata, origin: "manual" } },
        select,
      ),
    ).toBe(false);
    expect(
      isRedundantOptionClickBeforeSelect(click, {
        ...select,
        payload: { value: "CA", label: "California" },
      }),
    ).toBe(false);
  });
});
