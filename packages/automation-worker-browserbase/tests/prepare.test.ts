import { describe, expect, it } from "vitest";
import { prepareWorkflow, WorkerValidationError } from "../src/prepare.js";
import { completeWorkflow, fillStep } from "./fixtures.js";

describe("prepareWorkflow", () => {
  it("accepts all schema versions and rejects drafts", () => {
    const complete = completeWorkflow([fillStep("recorded", { source: "recorded" })]);

    for (const schemaVersion of ["1.0", "1.3", "1.4", "next"]) {
      expect(prepareWorkflow({ ...complete, schemaVersion }, undefined, {}).workflow.schemaVersion)
        .toBe(schemaVersion);
    }
    expect(() => prepareWorkflow({ ...complete, status: "draft" }, undefined, {})).toThrow(
      expect.objectContaining({ code: "workflow_not_complete" }),
    );
  });

  it("resolves recorded, fixed, profile, and runtime values without mutating the input", () => {
    const workflow = completeWorkflow([
      fillStep("recorded", { source: "recorded" }),
      fillStep("fixed", { source: "fixed", value: "fixed-value" }),
      fillStep("profile", { source: "profile", field: "identity.email" }),
      fillStep("runtime", { source: "runtime" }),
    ]);

    const prepared = prepareWorkflow(workflow, undefined, {
      profile: "profile-value",
      runtime: "runtime-value",
    });

    expect(prepared.workflow.steps.map((step) => (step.type === "fill" ? step.payload.value : null)))
      .toEqual(["recorded-value", "fixed-value", "profile-value", "runtime-value"]);
    expect(workflow.steps.map((step) => (step.type === "fill" ? step.payload.value : null))).toEqual([
      "recorded-value",
      "recorded-value",
      "recorded-value",
      "recorded-value",
    ]);
  });

  it("requires explicit values only for enabled profile and runtime steps in range", () => {
    const before = fillStep("before", { source: "runtime" });
    const selected = fillStep("selected", { source: "recorded" });
    const disabled = fillStep("disabled", { source: "profile", field: "identity.email" }, false);
    const workflow = completeWorkflow([before, selected, disabled]);

    expect(() => prepareWorkflow(workflow, "selected", {})).not.toThrow();
    expect(() => prepareWorkflow(workflow, undefined, {})).toThrow(
      expect.objectContaining({ code: "missing_parameter", stepId: "before" }),
    );
  });

  it("rejects empty, oversized, unknown, and unused explicit values", () => {
    const workflow = completeWorkflow([fillStep("runtime", { source: "runtime" })]);

    expect(() => prepareWorkflow(workflow, undefined, { runtime: "" })).toThrow(
      expect.objectContaining({ code: "invalid_parameter" }),
    );
    expect(() => prepareWorkflow(workflow, undefined, { runtime: "x".repeat(10_001) })).toThrow(
      expect.objectContaining({ code: "invalid_parameter" }),
    );
    expect(() => prepareWorkflow(workflow, undefined, { unknown: "value" })).toThrow(
      expect.objectContaining({ code: "unused_parameter", stepId: "unknown" }),
    );
    expect(() =>
      prepareWorkflow(
        completeWorkflow([fillStep("recorded", { source: "recorded" })]),
        undefined,
        { recorded: "value" },
      ),
    ).toThrow(expect.objectContaining({ code: "unused_parameter", stepId: "recorded" }));
  });

  it("returns safe validation errors for invalid start selections and empty ranges", () => {
    const workflow = completeWorkflow([fillStep("disabled", { source: "recorded" }, false)]);

    expect(() => prepareWorkflow(workflow, "missing", {})).toThrow(
      expect.objectContaining({ code: "invalid_start_step" }),
    );
    expect(() => prepareWorkflow(workflow, undefined, {})).toThrow(
      expect.objectContaining({ code: "no_enabled_steps" }),
    );
    expect(() => prepareWorkflow(workflow, undefined, {})).toThrow(WorkerValidationError);
  });
});
