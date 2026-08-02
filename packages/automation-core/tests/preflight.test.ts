import { describe, expect, it } from "vitest";
import { AutomationPreflightError, preflightAutomation } from "../src/index.js";
import { clickStep, navigateStep, workflowWith } from "./fixtures.js";

describe("preflightAutomation", () => {
  it("selects a range and uses the workflow start URL for a non-navigation first step", () => {
    const first = navigateStep(0);
    first.enabled = false;
    const preflight = preflightAutomation(workflowWith([first, clickStep(1)]), "step-1");

    expect(preflight.startIndex).toBe(1);
    expect(preflight.totalSteps).toBe(1);
    expect(preflight.bootstrapUrl).toBe("https://example.com/start");
  });

  it("does not bootstrap before an enabled navigation step", () => {
    expect(preflightAutomation(workflowWith([navigateStep()])).bootstrapUrl).toBeUndefined();
  });

  it("falls back to recorded page context when the workflow start URL is unavailable", () => {
    const workflow = workflowWith([clickStep()]);
    delete workflow.source.startUrl;

    expect(preflightAutomation(workflow).bootstrapUrl).toBe("https://example.com/form");
  });

  it("rejects duplicate step IDs, missing starts, empty enabled ranges, and missing HTTP context", () => {
    const duplicate = clickStep(1);
    duplicate.id = "step-0";
    expect(() => preflightAutomation(workflowWith([clickStep(), duplicate]))).toThrow(
      AutomationPreflightError,
    );
    expect(() => preflightAutomation(workflowWith([clickStep()]), "missing")).toThrow(
      /selected automation step/i,
    );

    const disabled = clickStep();
    disabled.enabled = false;
    expect(() => preflightAutomation(workflowWith([disabled]))).toThrow(/no enabled steps/i);

    const noContext = clickStep();
    noContext.page.url = "about:blank";
    const workflow = workflowWith([noContext]);
    delete workflow.source.startUrl;
    expect(() => preflightAutomation(workflow)).toThrow(/HTTP page URL/i);
  });
});
