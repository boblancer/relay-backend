import { z } from "zod";

export const locatorKinds = [
  "testId",
  "role",
  "accessibleName",
  "label",
  "text",
  "css",
  "xpath",
] as const;

export type LocatorKind = (typeof locatorKinds)[number];

export interface LocatorCandidate {
  kind: LocatorKind;
  value: string;
  name?: string;
  exact: boolean;
  unique?: boolean;
}

export interface ElementTarget {
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  tagName?: string;
  inputType?: string;
  frameUrl?: string;
  candidates?: LocatorCandidate[];
}

export interface ReplayWait {
  delayMs?: number;
  condition?: {
    state: "visible" | "hidden";
    target: ElementTarget;
  };
}

export const MAX_ASSERTION_TEXT_LENGTH = 1_000;

export type ParameterBinding =
  | { source: "recorded" }
  | { source: "fixed"; value: string }
  | {
      source: "profile";
      field:
        | "identity.fullName"
        | "identity.email"
        | "location.countryRegion"
        | "location.postalCode";
    }
  | { source: "runtime" };

interface StepBase {
  id: string;
  order: number;
  name: string;
  enabled: boolean;
  page: { id: string; url: string; title?: string };
  target?: ElementTarget;
  position?: { x: number; y: number; frameUrl?: string };
  metadata: {
    recordedAt: string;
    origin: "recorded" | "manual";
    sensitive: boolean;
  };
}

interface ActionStepBase extends StepBase {
  waitAfter?: ReplayWait;
}

interface ElementStepBase extends StepBase {
  target: ElementTarget;
}

interface ElementActionStepBase extends ActionStepBase {
  target: ElementTarget;
}

export type WorkflowStep =
  | (ActionStepBase & { type: "navigate"; payload: { url: string } })
  | (ElementActionStepBase & { type: "click"; payload?: Record<string, never> })
  | (ElementActionStepBase & {
      type: "fill";
      payload: { value: string };
      parameterBinding: ParameterBinding;
    })
  | (ElementActionStepBase & { type: "set_date"; payload: { value: string } })
  | (ElementActionStepBase & {
      type: "select";
      payload: { value: string; label?: string };
    })
  | (ElementActionStepBase & { type: "check"; payload?: Record<string, never> })
  | (ElementActionStepBase & { type: "uncheck"; payload?: Record<string, never> })
  | (ElementActionStepBase & {
      type: "keypress";
      payload: { key: string; modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> };
    })
  | (ElementActionStepBase & { type: "submit"; payload?: Record<string, never> })
  | (ElementStepBase & {
      type: "assertion";
      expectation:
        | { kind: "visible" }
        | { kind: "text_contains"; expected: string };
      waitAfter?: never;
    });

export interface Workflow {
  schemaVersion: string;
  id: string;
  name: string;
  status: "draft" | "complete";
  revision: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  source: {
    provider: "browserbase";
    sessionId: string;
    startUrl?: string;
  };
  steps: WorkflowStep[];
}

export function locatorCandidatesForTarget(target: ElementTarget): LocatorCandidate[] {
  const candidates = [...(target.candidates ?? [])];
  if (target.selector) candidates.push({ kind: "css", value: target.selector, exact: true });
  if (target.role) {
    candidates.push({ kind: "role", value: target.role, name: target.name, exact: true });
  } else if (target.name) {
    candidates.push({ kind: "accessibleName", value: target.name, exact: true });
  }
  if (target.text) candidates.push({ kind: "text", value: target.text, exact: true });

  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.kind === candidate.kind &&
          other.value === candidate.value &&
          other.name === candidate.name,
      ) === index,
  );
}

const locatorPriority = new Map(locatorKinds.map((kind, index) => [kind, index]));

export function orderLocatorCandidates(candidates: LocatorCandidate[]): LocatorCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      (locatorPriority.get(left.kind) ?? 99) - (locatorPriority.get(right.kind) ?? 99),
  );
}

const LocatorCandidateSchema = z
  .object({
    kind: z.enum(locatorKinds),
    value: z.string().min(1),
    name: z.string().optional(),
    exact: z.boolean().default(true),
    unique: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<LocatorCandidate>;

export const ElementTargetSchema = z
  .object({
    selector: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    tagName: z.string().optional(),
    inputType: z.string().optional(),
    frameUrl: z.string().optional(),
    candidates: z.array(LocatorCandidateSchema).optional(),
  })
  .strict() satisfies z.ZodType<ElementTarget>;

const ReplayableElementTargetSchema = ElementTargetSchema.refine(
  (target) => locatorCandidatesForTarget(target).length > 0,
  "Element actions need at least one locator.",
);

const ReplayWaitSchema = z
  .object({
    delayMs: z.number().int().min(0).max(30_000).optional(),
    condition: z
      .object({
        state: z.enum(["visible", "hidden"]),
        target: ReplayableElementTargetSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (wait) => (wait.delayMs ?? 0) > 0 || Boolean(wait.condition),
    "Configure a delay or element condition for this automation wait.",
  ) satisfies z.ZodType<ReplayWait>;

const PageDescriptorSchema = z
  .object({ id: z.string().min(1), url: z.string(), title: z.string().optional() })
  .strict();

const StepMetadataSchema = z
  .object({
    recordedAt: z.string().datetime({ offset: true }),
    origin: z.enum(["recorded", "manual"]),
    sensitive: z.boolean(),
  })
  .strict();

const StepBaseSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  page: PageDescriptorSchema,
  target: ElementTargetSchema.optional(),
  position: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      frameUrl: z.string().optional(),
    })
    .strict()
    .optional(),
  metadata: StepMetadataSchema,
});

const ActionStepBaseSchema = StepBaseSchema.extend({ waitAfter: ReplayWaitSchema.optional() });

const ElementStepBaseSchema = StepBaseSchema.extend({ target: ReplayableElementTargetSchema });

const ElementActionStepBaseSchema = ActionStepBaseSchema.extend({
  target: ReplayableElementTargetSchema,
});

const ParameterBindingSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("recorded") }).strict(),
  z.object({ source: z.literal("fixed"), value: z.string().max(10_000) }).strict(),
  z
    .object({
      source: z.literal("profile"),
      field: z.enum([
        "identity.fullName",
        "identity.email",
        "location.countryRegion",
        "location.postalCode",
      ]),
    })
    .strict(),
  z.object({ source: z.literal("runtime") }).strict(),
]);

const EmptyPayloadSchema = z.object({}).strict();

const WorkflowStepSchema = z.discriminatedUnion("type", [
  ActionStepBaseSchema.extend({
    type: z.literal("navigate"),
    payload: z.object({ url: z.string().min(1) }).strict(),
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("click"),
    payload: EmptyPayloadSchema.optional(),
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("fill"),
    payload: z.object({ value: z.string() }).strict(),
    parameterBinding: ParameterBindingSchema,
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("set_date"),
    payload: z.object({ value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("select"),
    payload: z.object({ value: z.string(), label: z.string().optional() }).strict(),
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("check"),
    payload: EmptyPayloadSchema.optional(),
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("uncheck"),
    payload: EmptyPayloadSchema.optional(),
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("keypress"),
    payload: z
      .object({
        key: z.string().min(1),
        modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])),
      })
      .strict(),
  }).strict(),
  ElementActionStepBaseSchema.extend({
    type: z.literal("submit"),
    payload: EmptyPayloadSchema.optional(),
  }).strict(),
  ElementStepBaseSchema.extend({
    type: z.literal("assertion"),
    expectation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("visible") }).strict(),
      z
        .object({
          kind: z.literal("text_contains"),
          expected: z
            .string()
            .max(MAX_ASSERTION_TEXT_LENGTH)
            .refine((value) => value.trim().length > 0),
        })
        .strict(),
    ]),
  }).strict(),
]);

export const WorkflowSchema = z
  .object({
    schemaVersion: z.string(),
    id: z.string().uuid(),
    name: z.string().trim().min(1),
    status: z.enum(["draft", "complete"]),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).optional(),
    source: z
      .object({
        provider: z.literal("browserbase"),
        sessionId: z.string(),
        startUrl: z.string().optional(),
      })
      .strict(),
    steps: z.array(WorkflowStepSchema),
  })
  .strict() satisfies z.ZodType<Workflow>;
