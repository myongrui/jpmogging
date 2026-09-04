import type OpenAI from "openai";
import type { AuditLog } from "../shared/audit.js";
import type { AllocationResult, Mandate } from "../shared/types.js";
import { mcpToolsToOpenAiTools, type McpBridge } from "./mcpClient.js";
import type { PayOutcome } from "./pay.js";

export interface AgentDeps {
  responses: { create(params: OpenAI.Responses.ResponseCreateParamsNonStreaming): Promise<OpenAI.Responses.Response> };
  model: string;
  mcp: McpBridge;
  pay(input: { resource: string; body: unknown }): Promise<PayOutcome>;
  audit: AuditLog;
  maxTurns?: number;
  log?: (line: string) => void;
  spendSummary?: string;
}

const LOCAL_TOOLS: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "pay_for_resource",
    description: "Pay for a payment_required resource with x402 on XRPL testnet and return its body. Only call this after a tool returned status payment_required and you judged the analysis worth its price.",
    parameters: {
      type: "object",
      properties: {
        resource: { type: "string", description: "The resource URL from the payment_required envelope" },
        body: { type: "object", description: "The exact input echoed in the envelope", additionalProperties: true },
      },
      required: ["resource", "body"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: "function",
    name: "record_decision",
    description: "Record the final treasury decision. Call exactly once when you have decided. This ends the session.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Concrete next action, e.g. 'allocate 25% to XRP/RLUSD, hold 75% liquid'" },
        rationale: { type: "string", description: "Why, citing the purchased analysis and the mandate constraints" },
      },
      required: ["action", "rationale"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export function SYSTEM_INSTRUCTIONS(mandate: Mandate, spendSummary: string): string {
  return [
    "You are an autonomous treasury agent for a payments business holding RLUSD on the XRP Ledger.",
    "Your objective is to decide what to do with temporarily idle capital under a strict mandate.",
    `Mandate: ${JSON.stringify(mandate)}.`,
    "You do not have your own market data. External financial-intelligence tools are available via MCP; some are paid via x402.",
    `Spend policy: ${spendSummary}. Never attempt a payment above these limits.`,
    "Workflow: inspect the free tools first, decide whether paid analysis is worth its price for this mandate, pay only if so, then interpret the result against the mandate and record one concrete decision with record_decision.",
    "If a payment is declined or fails, do not retry more than once; decide with the information you have.",
    "Be concise. Do not narrate; act through tools.",
  ].join(" ");
}

export async function runAgentLoop(deps: AgentDeps, mandate: Mandate): Promise<{ action: string; rationale: string }> {
  const log = deps.log ?? (() => {});
  const maxTurns = deps.maxTurns ?? 8;
  deps.audit.append({ type: "mandate", mandate });

  const mcpTools = await deps.mcp.listTools();
  deps.audit.append({ type: "discovery", tools: mcpTools.map((t) => t.name) });
  log(`discovered MCP tools: ${mcpTools.map((t) => t.name).join(", ")}`);
  const tools = [...mcpToolsToOpenAiTools(mcpTools), ...LOCAL_TOOLS];
  const mcpNames = new Set(mcpTools.map((t) => t.name));

  const input: OpenAI.Responses.ResponseInput = [
    { role: "user", content: `Here is my mandate: ${JSON.stringify(mandate)}. Decide what to do with this capital.` },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await deps.responses.create({
      model: deps.model,
      instructions: SYSTEM_INSTRUCTIONS(mandate, deps.spendSummary ?? "limits are enforced by the wallet"),
      input,
      tools,
      reasoning: { effort: "low" },
    });
    input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));

    const calls = response.output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call");
    if (calls.length === 0 && response.output_text) log(`model: ${response.output_text}`);

    for (const call of calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        deps.audit.append({ type: "error", message: `invalid arguments for ${call.name}` });
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "invalid JSON arguments" }) });
        continue;
      }
      deps.audit.append({ type: "tool_call", name: call.name, args });
      log(`tool_call ${call.name} ${JSON.stringify(args)}`);

      if (call.name === "record_decision") {
        const decision = { action: String(args.action), rationale: String(args.rationale) };
        deps.audit.append({ type: "decision", ...decision });
        log(`decision: ${decision.action}`);
        return decision;
      }

      let result: unknown;
      try {
        if (call.name === "pay_for_resource") {
          const outcome = await deps.pay({ resource: String(args.resource), body: args.body });
          if (outcome.status === "paid") deps.audit.append({ type: "result", result: outcome.body as AllocationResult });
          result = outcome;
        } else if (mcpNames.has(call.name)) {
          result = await deps.mcp.callTool(call.name, args);
        } else {
          result = { error: `unknown tool ${call.name}` };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.audit.append({ type: "error", message: `${call.name} failed: ${message}` });
        result = { error: message };
      }

      deps.audit.append({ type: "tool_result", name: call.name, result });
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  deps.audit.append({ type: "error", message: `no decision after ${maxTurns} turns` });
  return { action: "no_decision", rationale: "turn limit reached" };
}
