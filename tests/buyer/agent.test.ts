import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../../src/buyer/agent.js";
import { AuditLog, readRun } from "../../src/shared/audit.js";
import type { Mandate } from "../../src/shared/types.js";

const mandate: Mandate = { asset: "RLUSD", amount: 100000, horizon_hours: 72, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 };

function call(name: string, args: unknown, id: string) {
  return { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: "completed" };
}

function scriptedResponses(turns: unknown[][]) {
  let i = 0;
  const seenInputs: unknown[] = [];
  const seenInstructions: unknown[] = [];
  return {
    seenInputs,
    seenInstructions,
    responses: {
      create: async (params: any) => {
        seenInputs.push(params.input);
        seenInstructions.push(params.instructions);
        const output = turns[i++] ?? [];
        return { output, output_text: "" } as any;
      },
    },
  };
}

const mcp = {
  listTools: async () => [
    { name: "list_opportunities", description: "free", inputSchema: { type: "object", properties: {} } },
    { name: "optimize_allocation", description: "paid", inputSchema: { type: "object", properties: { amount: { type: "number" } } } },
  ],
  callTool: async (name: string) =>
    name === "list_opportunities" ? [{ pairLabel: "XRP/RLUSD" }] : { status: "payment_required", resource: "http://s/api/optimize_allocation", price_drops: "500000" },
  close: async () => {},
};

describe("runAgentLoop", () => {
  it("discovers tools, pays when asked, and ends on record_decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const audit = new AuditLog(dir, "run");
    const paid: unknown[] = [];
    const pay = async (input: { resource: string; body: unknown }) => {
      paid.push(input);
      return { status: "paid" as const, transaction: "TX", payer: "rBuyer", explorer: "https://testnet.xrpl.org/transactions/TX", body: { recommendation: "XRP/RLUSD" } };
    };
    const { responses, seenInputs } = scriptedResponses([
      [call("list_opportunities", {}, "1")],
      [call("optimize_allocation", mandate, "2")],
      [call("pay_for_resource", { resource: "http://s/api/optimize_allocation", body: mandate }, "3")],
      [call("record_decision", { action: "allocate 25% to XRP/RLUSD", rationale: "meets mandate" }, "4")],
    ]);

    const out = await runAgentLoop({ responses, model: "test", mcp, pay, audit }, mandate);
    expect(out).toEqual({ action: "allocate 25% to XRP/RLUSD", rationale: "meets mandate" });
    expect(paid).toEqual([{ resource: "http://s/api/optimize_allocation", body: mandate }]);
    expect(readRun(dir, "run").map((r) => r.event.type)).toEqual([
      "mandate", "discovery",
      "tool_call", "tool_result",
      "tool_call", "tool_result",
      "tool_call", "result", "tool_result",
      "tool_call", "decision",
    ]);
    const last = seenInputs.at(-1) as any[];
    expect(last.filter((i) => i.type === "function_call_output")).toHaveLength(3);
  });

  it("stops after maxTurns without a decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const audit = new AuditLog(dir, "run");
    const { responses } = scriptedResponses([[call("list_opportunities", {}, "1")], [call("list_opportunities", {}, "2")]]);
    const out = await runAgentLoop({ responses, model: "test", mcp, pay: async () => ({ status: "failed" as const, reason: "x" }), audit, maxTurns: 2 }, mandate);
    expect(out.action).toBe("no_decision");
    expect(readRun(dir, "run").at(-1)?.event.type).toBe("error");
  });

  it("logs an error and continues when the model emits malformed arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const audit = new AuditLog(dir, "run");
    const malformedCall = { type: "function_call", id: "fc_1", call_id: "1", name: "list_opportunities", arguments: "{not json", status: "completed" };
    const { responses, seenInputs } = scriptedResponses([
      [malformedCall],
      [call("record_decision", { action: "hold", rationale: "bad args" }, "2")],
    ]);

    const out = await runAgentLoop({ responses, model: "test", mcp, pay: async () => ({ status: "failed" as const, reason: "x" }), audit }, mandate);
    expect(out).toEqual({ action: "hold", rationale: "bad args" });
    expect(readRun(dir, "run").map((r) => r.event.type)).toEqual(["mandate", "discovery", "error", "tool_call", "decision"]);
    const second = seenInputs[1] as any[];
    const outputs = second.filter((i) => i.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].output).toBe(JSON.stringify({ error: "invalid JSON arguments" }));
  });

  it("passes the caller's spend summary into the instructions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const audit = new AuditLog(dir, "run");
    const { responses, seenInstructions } = scriptedResponses([
      [call("record_decision", { action: "hold", rationale: "no opportunity" }, "1")],
    ]);

    await runAgentLoop({ responses, model: "test", mcp, pay: async () => ({ status: "failed" as const, reason: "x" }), audit, spendSummary: "max 1000000 drops per request" }, mandate);
    expect(seenInstructions[0]).toContain("max 1000000 drops per request");
  });
});
