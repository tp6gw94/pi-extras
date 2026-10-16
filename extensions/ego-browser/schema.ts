import { Type, type Static } from "typebox";
import type { JsonValue } from "@earendil-works/pi-ai";

const str = Type.String({ minLength: 1 });
const kind = Type.Union([Type.Literal("navigate"), Type.Literal("click"), Type.Literal("fill"), Type.Literal("select"), Type.Literal("press")]);
const key = Type.Union([Type.Literal("Enter"), Type.Literal("Tab"), Type.Literal("Escape")]);
const target = Type.Union([Type.Object({ ref: str }), Type.Object({ selector: str })]);
export const ConditionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("url"), equals: str }),
  Type.Object({ kind: Type.Literal("visible"), selector: str }),
  Type.Object({ kind: Type.Literal("value"), selector: str, equals: Type.String() }),
  Type.Object({ kind: Type.Literal("text"), selector: str, includes: str }),
]);
const check = Type.Object({ id: str, condition: ConditionSchema });
const candidateAction = Type.Union([
  Type.Object({ kind: Type.Literal("click"), selector: str }),
  Type.Object({ kind: Type.Literal("fill"), selector: str, textKey: str }),
  Type.Object({ kind: Type.Literal("select"), selector: str, textKey: str }),
  Type.Object({ kind: Type.Literal("press"), selector: str, key }),
]);
const manualAction = Type.Union([
  Type.Object({ kind: Type.Literal("navigate"), url: str }),
  Type.Object({ kind: Type.Literal("click"), target }),
  Type.Object({ kind: Type.Literal("fill"), target, textKey: str }),
  Type.Object({ kind: Type.Literal("select"), target, textKey: str }),
  Type.Object({ kind: Type.Literal("press"), target, key }),
]);
const candidate = Type.Object({
  id: Type.String({ pattern: "^(?!DONE$|STOP$)[A-Za-z0-9_-]+$" }),
  action: candidateAction,
  after: ConditionSchema,
});
const contract = Type.Object({
  goal: str,
  allowedOrigins: Type.Array(str, { minItems: 1 }),
  allowedActions: Type.Array(kind, { minItems: 1 }),
  text: Type.Record(Type.String(), Type.String()),
  evidenceDir: str,
  deadline: str,
  maxActions: Type.Integer({ minimum: 1, maximum: 100 }),
});
const page = Type.String({ pattern: "^p[1-9][0-9]*$" });
export const RequestSchema = Type.Union([
  Type.Object({
    op: Type.Literal("begin"),
    space: Type.Union([Type.Object({ attach: Type.Integer({ minimum: 1 }) }), Type.Object({ create: str })]),
    contract,
  }),
  Type.Object({ op: Type.Literal("observe"), task: str, page, checks: Type.Optional(Type.Array(check, { maxItems: 32 })), screenshot: Type.Optional(Type.Literal("now")) }),
  Type.Object({ op: Type.Literal("act"), task: str, page, observation: Type.Optional(str), action: manualAction, after: ConditionSchema }),
  Type.Object({
    op: Type.Literal("run"),
    task: str,
    page,
    goal: str,
    candidates: Type.Array(candidate, { minItems: 1, maxItems: 32 }),
    checks: Type.Array(check, { minItems: 1, maxItems: 32 }),
    budget: Type.Object({ maxActions: Type.Integer({ minimum: 1, maximum: 100 }), timeoutMs: Type.Integer({ minimum: 1, maximum: 300000 }) }),
    screenshot: Type.Optional(Type.Literal("final")),
  }),
  Type.Object({ op: Type.Literal("finish"), task: str, reviewedObservation: str }),
  Type.Object({ op: Type.Literal("release"), task: str }),
]);
export const ToolParametersSchema = Type.Object({ request: RequestSchema });
export type Request = Static<typeof RequestSchema>;
export type Condition = Static<typeof ConditionSchema>;
export type Contract = Static<typeof contract>;
export type Candidate = Static<typeof candidate>;
export type Check = Static<typeof check>;
export type Action = Static<typeof manualAction> | Static<typeof candidateAction>;
export type CheckResult = { id: string; status: "pass" | "fail"; actual: JsonValue; expected: Condition };
export type Facts = { url: string; documentId: string; controls: Record<string, { eligible: boolean; [key: string]: JsonValue }>; checks: CheckResult[] };
export type Observation = { id: string; page: string; url: string; snapshotPath: string; screenshotPath?: string; facts: Facts };
export type RoundDiagnostics = { resultPath: string; stage: string; after?: CheckResult[]; innerIssue?: string; transportIssue?: string };
export type Report = { diagnostics?: RoundDiagnostics; task: string; spaceId?: number; reason: string; actionsUsed: number; classifierCalls: number; checks: CheckResult[]; observation?: Observation; tracePath: string; mayHaveLateEffects: boolean; issues: string[] };
const diagnostics = Type.Object({ resultPath: Type.String(), stage: Type.String(), after: Type.Optional(Type.Array(Type.Object({ id: Type.String(), status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]), actual: Type.Unknown(), expected: ConditionSchema }))), innerIssue: Type.Optional(Type.String()), transportIssue: Type.Optional(Type.String()) });
export const ReportSchema = Type.Object({ diagnostics: Type.Optional(diagnostics), task: Type.String(), reason: Type.String(), actionsUsed: Type.Number(), classifierCalls: Type.Number(), checks: Type.Array(Type.Unknown()), tracePath: Type.String(), mayHaveLateEffects: Type.Boolean(), issues: Type.Array(Type.String()), spaceId: Type.Optional(Type.Number()), observation: Type.Optional(Type.Unknown()) });
