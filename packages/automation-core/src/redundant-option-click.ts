import { locatorCandidatesForTarget, type WorkflowStep } from "./workflow.js";

const optionRoles = new Set(["option", "menuitemradio"]);

function normalizeLabel(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function isOptionLikeTarget(step: WorkflowStep & { type: "click" }): boolean {
  if (step.target.tagName?.toLocaleLowerCase() === "option") return true;
  return locatorCandidatesForTarget(step.target).some(
    (candidate) =>
      candidate.kind === "role" && optionRoles.has(candidate.value.toLocaleLowerCase()),
  );
}

function optionClickLabels(step: WorkflowStep & { type: "click" }): string[] {
  const labels = [step.name];
  for (const candidate of locatorCandidatesForTarget(step.target)) {
    if (candidate.kind === "role" && optionRoles.has(candidate.value.toLocaleLowerCase())) {
      if (candidate.name) labels.push(candidate.name);
    } else if (candidate.kind === "accessibleName" || candidate.kind === "text") {
      labels.push(candidate.value);
    }
  }
  return labels.map(normalizeLabel).filter(Boolean);
}

export function isRedundantOptionClickBeforeSelect(
  click: WorkflowStep | undefined,
  select: WorkflowStep | undefined,
): boolean {
  if (!click || click.type !== "click" || !select || select.type !== "select") return false;
  if (!click.enabled || !select.enabled || click.waitAfter) return false;
  if (click.metadata.origin !== "recorded" || select.metadata.origin !== "recorded") return false;
  if (click.page.id !== select.page.id || click.page.url !== select.page.url) return false;
  if (click.target.frameUrl !== select.target.frameUrl || !isOptionLikeTarget(click)) return false;

  const selectedLabel = normalizeLabel(select.payload.label);
  return Boolean(selectedLabel) && optionClickLabels(click).includes(selectedLabel);
}
