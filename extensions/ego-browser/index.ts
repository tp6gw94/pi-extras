import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolParametersSchema, ReportSchema } from "./schema.ts";
import { createRuntime, type Classify } from "./runtime.ts";

const successReasons = ["begun", "observed", "acted", "checks_passed", "finished", "released"];

const sumUsage = (usage: NonNullable<ClassifierResult["usage"]>[]) =>
  usage.reduce((sum, item) => ({
    input: sum.input + item.input,
    output: sum.output + item.output,
    cacheRead: sum.cacheRead + item.cacheRead,
    cacheWrite: sum.cacheWrite + item.cacheWrite,
    totalTokens: sum.totalTokens + item.totalTokens,
    cost: {
      input: sum.cost.input + item.cost.input,
      output: sum.cost.output + item.cost.output,
      cacheRead: sum.cost.cacheRead + item.cost.cacheRead,
      cacheWrite: sum.cost.cacheWrite + item.cost.cacheWrite,
      total: sum.cost.total + item.cost.total,
    },
  }));

export default function (pi: ExtensionAPI) {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const runtime = createRuntime();

  pi.on("resources_discover", () => ({ skillPaths: [join(extensionDir, "skills", "ego-browser-tools", "SKILL.md")] }));

  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });

  pi.registerTool({
    name: "ego_browser",
    label: "Ego Browser",
    description: "Operate one Ego-owned TaskSpace with bounded manual actions or classifier-selected native DOM actions. Begin a contract, observe evidence, act or run, then explicitly finish after reviewing passing checks or release the local lease without closing the browser. Frozen observe retains ownership and scope guards. Release stopped tasks so their leases do not block the next task. Release does not clear uncertain effects. No arbitrary JavaScript.",
    parameters: ToolParametersSchema,
    outputSchema: ReportSchema,
    exposure: "direct",
    executionMode: "sequential",
    annotations: { destructiveHint: true, openWorldHint: true },
    promptGuidelines: ["Use ego_browser directly, not shell browser scripts. Reuse the assigned space and page. Read evidence before finish. Never claim or take over ownership. Origin restrictions are not a network sandbox."],
    async execute(_id, { request }, signal, _update, ctx) {
      const classify: Classify = async (context, classifySignal, timeoutMs) => {
        const provider = process.env.PI_EGO_CLASSIFIER_PROVIDER ?? "typesafe";
        const id = process.env.PI_EGO_CLASSIFIER_MODEL ?? "jev-latest";
        const model = ctx.modelRegistry.findOfType("classifier", provider, id);
        if (!model) throw new Error(`Classifier ${provider}/${id} is unavailable`);
        return ctx.modelRegistry.classify(model, context, { signal: classifySignal, timeoutMs, maxRetries: 0 });
      };
      const { report, usage } = await runtime.execute(request, signal ?? new AbortController().signal, classify);
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
        details: report,
        structuredContent: JSON.parse(JSON.stringify(report)),
        isError: !successReasons.includes(report.reason),
        usage: usage.length ? sumUsage(usage) : undefined,
      };
    },
  });
}
