import "dotenv/config";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { Client, Wallet } from "xrpl";
import { executePlan } from "../execute/executor.js";
import { AuditLog, readRun } from "../shared/audit.js";
import type { Mandate } from "../shared/types.js";
import { runAgentLoop } from "./agent.js";
import { connectMcp } from "./mcpClient.js";
import { payForResource } from "./pay.js";
import { validatePlan } from "./planValidator.js";
import { SpendTracker, policyFromEnv } from "./spendPolicy.js";

const mandatePath = process.argv[2];
if (!mandatePath) throw new Error("usage: tsx src/buyer/index.ts <mandate.json>");
const seed = process.env.XRPL_BUYER_SEED;
if (!seed) throw new Error("XRPL_BUYER_SEED is required");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const mandate = JSON.parse(readFileSync(mandatePath, "utf8")) as Mandate;
const sellerBaseUrl = process.env.SELLER_BASE_URL ?? "http://127.0.0.1:8080";
const network = process.env.XRPL_NETWORK ?? "xrpl:1";
const wallet = Wallet.fromSeed(seed);
const policy = policyFromEnv(process.env);
const tracker = new SpendTracker(policy);
const audit = new AuditLog("runs");
const openai = new OpenAI();

// Execution moves real capital, so it stays opt-in rather than defaulting on.
const shouldExecute = process.env.BUYER_EXECUTE === "true";

console.log(`run ${audit.runId}`);
console.log(`buyer wallet ${wallet.classicAddress} on ${network}`);
console.log(`spend policy ${policy.maxDropsPerRequest} drops/request, ${policy.maxDropsPerSession} drops/session`);
console.log(`execution ${shouldExecute ? "ENABLED" : "disabled (set BUYER_EXECUTE=true to allocate)"}`);

const mcp = await connectMcp(`${sellerBaseUrl}/mcp`);
let decision: Awaited<ReturnType<typeof runAgentLoop>>;
try {
  decision = await runAgentLoop(
    {
      responses: openai.responses,
      model: process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
      mcp,
      pay: (input) => payForResource({ wallet, network, tracker, audit }, input),
      audit,
      log: (line) => console.log(line),
      spendSummary: `up to ${policy.maxDropsPerRequest} drops per request and ${policy.maxDropsPerSession} drops per run`,
    },
    mandate,
  );
} catch (err) {
  audit.append({ type: "error", message: err instanceof Error ? err.message : String(err) });
  throw err;
} finally {
  await mcp.close();
}

console.log("");
console.log(`decision: ${decision.action}`);
console.log(`rationale: ${decision.rationale}`);
console.log(`spent ${tracker.spentDrops} drops`);

if (decision.plan) {
  // The seller is a paid counterparty, not a trusted component: re-check every
  // mandate constraint here before anything is signed.
  const verdict = validatePlan(decision.plan, mandate, { network });
  if (!verdict.ok) {
    audit.append({ type: "plan_rejected", planId: decision.plan.planId, violations: verdict.violations });
    console.log(`plan ${decision.plan.planId} REJECTED:`);
    for (const v of verdict.violations) console.log(`  - ${v}`);
  } else if (!shouldExecute) {
    console.log(`plan ${decision.plan.planId} validated (${decision.plan.legs.length} legs) — not executed, BUYER_EXECUTE is not true`);
  } else {
    const ws = process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233";
    const client = new Client(ws);
    await client.connect();
    try {
      const report = await executePlan({ client, wallet, audit, log: (l) => console.log(l) }, decision.plan);
      console.log(`execution ${report.status}: ${report.validatedHashes.length} of ${decision.plan.legs.length} legs validated`);
      for (const leg of report.legs) {
        console.log(`  leg ${leg.seq} ${leg.kind} ${leg.status}${leg.explorer ? ` ${leg.explorer}` : ""}${leg.message ? ` (${leg.message})` : ""}`);
      }
    } finally {
      await client.disconnect();
    }
  }
}

for (const r of readRun("runs", audit.runId)) {
  if (r.event.type === "payment_settled") console.log(`payment ${r.event.transaction} ${r.event.explorer}`);
}
console.log(`audit ${audit.path}`);
process.exitCode = decision.action === "no_decision" ? 1 : 0;
