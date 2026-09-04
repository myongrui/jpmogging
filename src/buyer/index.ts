import "dotenv/config";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { Wallet } from "xrpl";
import { AuditLog, readRun } from "../shared/audit.js";
import type { Mandate } from "../shared/types.js";
import { runAgentLoop } from "./agent.js";
import { connectMcp } from "./mcpClient.js";
import { payForResource } from "./pay.js";
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

console.log(`run ${audit.runId}`);
console.log(`buyer wallet ${wallet.classicAddress} on ${network}`);
console.log(`spend policy ${policy.maxDropsPerRequest} drops/request, ${policy.maxDropsPerSession} drops/session`);

const mcp = await connectMcp(`${sellerBaseUrl}/mcp`);
const decision = await runAgentLoop(
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
await mcp.close();

console.log("");
console.log(`decision: ${decision.action}`);
console.log(`rationale: ${decision.rationale}`);
console.log(`spent ${tracker.spentDrops} drops`);
for (const r of readRun("runs", audit.runId)) {
  if (r.event.type === "payment_settled") console.log(`payment ${r.event.transaction} ${r.event.explorer}`);
}
console.log(`audit ${audit.path}`);
process.exitCode = decision.action === "no_decision" ? 1 : 0;
