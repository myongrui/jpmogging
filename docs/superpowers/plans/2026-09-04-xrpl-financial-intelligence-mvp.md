# XRPL Financial Intelligence MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A buyer agent with an RLUSD capital-allocation mandate discovers a paid `optimize_allocation` tool over MCP, pays for it with x402 settled on XRPL testnet, receives a structured allocation built from live mainnet AMM data, and records a decision based on it.

**Architecture:** One TypeScript package with three processes. The **seller** is an Express server exposing a stateless MCP endpoint at `/mcp` (discovery, free teaser tool, and a paid tool that answers `payment_required`) plus an x402-guarded REST resource at `/api/optimize_allocation` that runs the intelligence engine. The **buyer** is a GPT-5.6 Sol tool-use loop whose tool list is built dynamically from MCP `listTools`, plus two local tools: `pay_for_resource` (x402 purchase under a spend policy) and `record_decision`. The **dashboard** serves an audit trail of every run written as JSONL. The **engine** reads live mainnet AMM pools read-only, samples recent trades for volume, scores fee yield, risk, and liquidity, and runs a constrained greedy allocator.

**Tech Stack:** Node 20+, TypeScript 5.9, ESM, Express 5, `@modelcontextprotocol/sdk` 1.30.0, `x402-xrpl` 0.3.2, `xrpl` 4.6.0, `openai` 7.10.0, `zod` 4, Vitest 4, tsx.

**Spec:** `XRPL Financial Intelligence — Developer Context Brief.md` (repo root). Hackathon context: `https://github.com/Singhacks-2026/ripple` (README.md, resources.md).

## Global Constraints

- Node.js 20 or newer. Node 24.19.0 is installed. `"engines": { "node": ">=20" }`.
- Pure ESM: `"type": "module"` in package.json, `.js` suffixes on relative imports.
- Pin `xrpl` to `4.6.0`. `x402-xrpl` depends on `xrpl ^4.5.0`; a second copy breaks `Wallet` typing. After install run `npm ls xrpl` and confirm exactly one copy.
- Pin `@modelcontextprotocol/sdk` to `1.30.0`. Do not use the `@modelcontextprotocol/server` v2 packages.
- Payment asset is **XRP drops on testnet**, network id `xrpl:1`, facilitator `https://xrpl-facilitator-testnet.t54.ai`. RLUSD payment is out of scope.
- The buyer agent must never spend more than `BUYER_MAX_DROPS_PER_REQUEST` (default `1000000` = 1 XRP) per request or `BUYER_MAX_DROPS_PER_SESSION` (default `3000000`) per run (spec §16).
- The service never takes custody of buyer funds; the buyer only recommends and records a decision (spec §15, §23 "Execution" resolved as recommend-only).
- Every run must produce a JSONL audit trail with input parameters, data timestamp, payment tx hash, result, and decision (spec §16).
- Opportunity data is **live mainnet AMM state, read-only**, via the xrpscan pool list for discovery and public mainnet JSON-RPC for state and trade sampling. No mainnet transactions are ever submitted.
- Buyer model: `gpt-5.6-sol` via the OpenAI Responses API, `reasoning.effort: "low"`.
- Code style: no comments, no speculative abstraction, prefer editing existing files (user CLAUDE.md).
- Do not modify `.claude/settings.json` or `hook/`. They hold the hackathon feedback hook.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UpTK3wivTGPp7nhZgbLEtM
  ```

## Stated Assumptions (spec §23 open questions, resolved for the MVP)

| Question | Resolution |
|---|---|
| Buyer persona | A payment/treasury application holding 100,000 RLUSD that must keep 50% liquid for 72 hours. |
| Data | XRP-paired mainnet AMM pools. Yield = trading-fee income from sampled recent volume. |
| Risk model | Transparent rule-based score (Task 3). Documented in README as an MVP heuristic, not a validated model. |
| Pricing | `optimize_allocation` costs 0.5 XRP (`500000` drops). |
| Payment asset | XRP on testnet. |
| Execution | Recommend only. The buyer records a decision; no AMM deposit is submitted. |
| Autonomy | Buyer pays autonomously up to the spend policy; anything above is declined and logged. |

## Verified External Facts

- **x402 headers:** server sends `PAYMENT-REQUIRED` (base64 JSON with `accepts[]`), client retries with `PAYMENT-SIGNATURE`, server returns `PAYMENT-RESPONSE` (base64 JSON `{ success, transaction, network, payer }`).
- **`x402-xrpl/express`:** `requirePayment({ path, price, payToAddress, network, facilitatorUrl, asset: "XRP", resource, description, settle })` returns an Express `RequestHandler`.
- **`x402-xrpl`:** `x402Purchase({ url, method, headers, body, wallet, network, maxValue, paymentRequirementsSelector })` returns `{ status: "success" | "requires_confirmation" | "declined" | "payment_required" | "failed", response?, transaction?, payer?, network?, reason? }`. `defaultPaymentRequirementsSelector(accepts, networkFilter?, schemeFilter?, maxValue?)` picks the requirement. `decodePaymentRequiredHeader`, `decodePaymentResponseHeader` decode the headers.
- **Facilitator:** `GET https://xrpl-facilitator-testnet.t54.ai/supported` returns 200. Root and `/health` return 404. Testnet JSON-RPC `https://s.altnet.rippletest.net:51234/`, WS `wss://s.altnet.rippletest.net:51233`.
- **Mainnet read-only:** JSON-RPC `https://s1.ripple.com:51234/`, WS `wss://s1.ripple.com:51233`. `amm_info` with `amm_account` returns `amm.amount` (XRP drops string), `amm.amount2 {currency, issuer, value}`, `amm.trading_fee` (units of 1/100000), `amm.asset2_frozen`, plus top-level `ledger_index`. `account_tx` with `api_version: 2` returns `transactions[]` each with `tx_json`, `meta`, `hash`, `ledger_index`, `close_time_iso`.
- **xrpscan:** `GET https://api.xrpscan.com/api/v1/amm/pools` returns an array of AMM ledger objects with `Account`, `Asset {currency}`, `Asset2 {currency, issuer}`, `Balance` (number, XRP drops), `TradingFee`, `Asset2Name {name, verified} | null`. The XRP/RLUSD pool is `rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3`, RLUSD issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`, RLUSD hex code `524C555344000000000000000000000000000000`.
- **xrpl.js 4.6:** exports `Client`, `Wallet`, `getBalanceChanges(meta)`, `dropsToXrp`, `xrpToDrops`. `client.fundWallet()` funds a new testnet wallet via faucet.
- **MCP SDK 1.30:** `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StreamableHTTPServerTransport` from `.../server/streamableHttp.js` (stateless with `sessionIdGenerator: undefined`), `Client` from `.../client/index.js`, `StreamableHTTPClientTransport` from `.../client/streamableHttp.js`, `InMemoryTransport.createLinkedPair()` from `.../inMemory.js`. `registerTool(name, { description, inputSchema: ZodRawShape }, handler)`. Import zod as `import * as z from "zod/v4"`.
- **OpenAI 7.10:** `client.responses.create({ model, instructions, input, tools, reasoning: { effort } })`. Function tool shape `{ type: "function", name, description, parameters, strict }`. Output items of `type: "function_call"` carry `call_id`, `name`, `arguments`. Reply by appending `{ type: "function_call_output", call_id, output }` to the accumulated `input` array. Types: `OpenAI.Responses.ResponseInput`, `OpenAI.Responses.FunctionTool`, `OpenAI.Responses.ResponseFunctionToolCall`.
- **Explorer:** `https://testnet.xrpl.org/transactions/<hash>`.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .env.example, .gitignore
mandates/treasury-100k.json          the demo mandate
scripts/setup-wallets.ts             funds seller + buyer testnet wallets, writes .env
src/shared/types.ts                  Mandate, PoolSnapshot, PoolMetrics, AllocationResult, AuditEvent
src/shared/currency.ts               hex currency code → display symbol
src/shared/audit.ts                  AuditLog: append JSONL events per run
src/engine/scoring.ts                feeApy, riskScore, liquidityScore, scorePool (pure)
src/engine/optimizer.ts              optimizeAllocation (pure)
src/engine/xrplData.ts               discoverPools (xrpscan), fetchPoolState (amm_info), sampleVolume (account_tx)
src/engine/engine.ts                 listOpportunities, runAnalysis (orchestration)
src/seller/mcp.ts                    buildMcpServer: list_opportunities (free), optimize_allocation (payment_required)
src/seller/app.ts                    buildSellerApp: /health, /mcp, x402-guarded /api/optimize_allocation
src/seller/index.ts                  seller entry
src/buyer/spendPolicy.ts             SpendTracker
src/buyer/pay.ts                     payForResource via x402Purchase
src/buyer/mcpClient.ts               connectMcp, mcpToolsToOpenAiTools
src/buyer/agent.ts                   runAgentLoop (OpenAI Responses loop, injectable)
src/buyer/index.ts                   buyer entry
src/dashboard/index.ts               dashboard server: /api/runs, /api/runs/:id, static page
src/dashboard/public/index.html      audit timeline UI
tests/**/*.test.ts                   one test file per source module
runs/                                JSONL audit logs (gitignored)
```

---

### Task 1: Project scaffold and shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `src/shared/types.ts`
- Test: `tests/shared/types.test.ts`

**Interfaces:**
- Produces: every type below. All later tasks import from `src/shared/types.ts`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "xrpl-financial-intelligence",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "setup:wallets": "tsx scripts/setup-wallets.ts",
    "seller": "tsx src/seller/index.ts",
    "buyer": "tsx src/buyer/index.ts mandates/treasury-100k.json",
    "dashboard": "tsx src/dashboard/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "dotenv": "17.4.2",
    "express": "5.2.1",
    "openai": "7.10.0",
    "x402-xrpl": "0.3.2",
    "xrpl": "4.6.0",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@types/express": "5.0.6",
    "@types/node": "24.13.3",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: Create .env.example and .gitignore**

`.env.example`:
```
XRPL_NETWORK=xrpl:1
XRPL_TESTNET_WS=wss://s.altnet.rippletest.net:51233
XRPL_MAINNET_WS=wss://s1.ripple.com:51233
XRPL_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai

SELLER_PORT=8080
SELLER_BASE_URL=http://127.0.0.1:8080
XRPL_PAY_TO=
XRPL_PRICE_DROPS=500000

XRPL_BUYER_SEED=
BUYER_MAX_DROPS_PER_REQUEST=1000000
BUYER_MAX_DROPS_PER_SESSION=3000000
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-sol

DASHBOARD_PORT=8090
```

`.gitignore`:
```
node_modules/
runs/
.env
```

- [ ] **Step 5: Write the failing type test**

`tests/shared/types.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { EXPLORER_TX_URL, explorerTxUrl, type Mandate } from "../../src/shared/types.js";

describe("shared types", () => {
  it("builds a testnet explorer link", () => {
    expect(explorerTxUrl("ABC123")).toBe(`${EXPLORER_TX_URL}/ABC123`);
  });

  it("accepts a mandate literal", () => {
    const m: Mandate = {
      asset: "RLUSD",
      amount: 100000,
      horizon_hours: 72,
      minimum_liquidity: 0.5,
      maximum_risk_score: 30,
      maximum_protocol_allocation: 0.25,
    };
    expect(m.amount).toBe(100000);
  });
});
```

- [ ] **Step 6: Install and run the test to verify it fails**

Run: `npm install && npm ls xrpl && npx vitest run tests/shared/types.test.ts`
Expected: `npm ls xrpl` shows one `xrpl@4.6.0` entry (deduped under x402-xrpl). Test FAILS with "Cannot find module '../../src/shared/types.js'".

- [ ] **Step 7: Create src/shared/types.ts**

```ts
export interface Mandate {
  asset: "RLUSD";
  amount: number;
  horizon_hours: number;
  minimum_liquidity: number;
  maximum_risk_score: number;
  maximum_protocol_allocation: number;
}

export interface PoolSnapshot {
  ammAccount: string;
  pairLabel: string;
  asset2Currency: string;
  asset2Issuer: string;
  asset2Name: string | null;
  issuerVerified: boolean;
  xrpBalanceDrops: string;
  asset2Value: string;
  tradingFee: number;
  frozen: boolean;
}

export interface PoolMetrics extends PoolSnapshot {
  tvlXrp: number;
  volumeXrpPerDay: number;
  feeApy: number;
  riskScore: number;
  liquidityScore: number;
  riskAdjustedScore: number;
}

export interface AllocationLine {
  ammAccount: string;
  pairLabel: string;
  weight: number;
  amount: number;
  feeApy: number;
  riskScore: number;
  liquidityScore: number;
}

export interface AllocationResult {
  recommendation: string;
  allocations: AllocationLine[];
  liquid_reserve: { weight: number; amount: number };
  expected_apy: number;
  portfolio_risk_score: number;
  portfolio_liquidity_score: number;
  reasoning: string;
  opportunities_considered: number;
  data: { ledger_index: number; rlusd_per_xrp: number; sampled_at: string };
  timestamp: string;
  valid_until: string;
}

export interface Opportunity {
  ammAccount: string;
  pairLabel: string;
  tvlXrp: number;
  tradingFeeBps: number;
}

export type AuditEvent =
  | { type: "mandate"; mandate: Mandate }
  | { type: "discovery"; tools: string[] }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "payment_required"; resource: string; amountDrops: string; asset: string; network: string; payTo: string }
  | { type: "payment_settled"; transaction: string; payer: string; amountDrops: string; network: string; explorer: string }
  | { type: "payment_declined"; resource: string; reason: string }
  | { type: "result"; result: AllocationResult }
  | { type: "decision"; action: string; rationale: string }
  | { type: "error"; message: string };

export interface AuditRecord {
  runId: string;
  seq: number;
  ts: string;
  event: AuditEvent;
}

export const EXPLORER_TX_URL = "https://testnet.xrpl.org/transactions";

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_TX_URL}/${hash}`;
}
```

- [ ] **Step 8: Run the test and typecheck**

Run: `npx vitest run tests/shared/types.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example .gitignore src/shared/types.ts tests/shared/types.test.ts
git commit -m "chore: scaffold TypeScript project and shared types"
```

---

### Task 2: Audit log

**Files:**
- Create: `src/shared/audit.ts`
- Test: `tests/shared/audit.test.ts`

**Interfaces:**
- Consumes: `AuditEvent`, `AuditRecord` from Task 1.
- Produces: `class AuditLog { constructor(dir: string, runId?: string); readonly runId: string; readonly path: string; append(event: AuditEvent): AuditRecord; }` and `readRun(dir: string, runId: string): AuditRecord[]`, `listRuns(dir: string): string[]`.

- [ ] **Step 1: Write the failing test**

`tests/shared/audit.test.ts`:
```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, listRuns, readRun } from "../../src/shared/audit.js";

describe("AuditLog", () => {
  it("appends JSONL records with increasing seq and reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const log = new AuditLog(dir, "run-1");
    log.append({ type: "discovery", tools: ["a", "b"] });
    log.append({ type: "decision", action: "hold", rationale: "test" });

    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.runId).toBe("run-1");
    expect(first.seq).toBe(1);
    expect(first.event.type).toBe("discovery");

    expect(readRun(dir, "run-1").map((r) => r.seq)).toEqual([1, 2]);
    expect(listRuns(dir)).toEqual(["run-1"]);
  });

  it("generates a runId when none is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const log = new AuditLog(dir);
    expect(log.runId).toMatch(/^\d{8}T\d{6}-[a-f0-9]{6}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/audit.test.ts`
Expected: FAIL with "Cannot find module '../../src/shared/audit.js'".

- [ ] **Step 3: Create src/shared/audit.ts**

```ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AuditEvent, AuditRecord } from "./types.js";

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export class AuditLog {
  readonly runId: string;
  readonly path: string;
  private seq = 0;

  constructor(dir: string, runId: string = newRunId()) {
    mkdirSync(dir, { recursive: true });
    this.runId = runId;
    this.path = join(dir, `${runId}.jsonl`);
  }

  append(event: AuditEvent): AuditRecord {
    this.seq += 1;
    const record: AuditRecord = { runId: this.runId, seq: this.seq, ts: new Date().toISOString(), event };
    appendFileSync(this.path, JSON.stringify(record) + "\n");
    return record;
  }
}

export function readRun(dir: string, runId: string): AuditRecord[] {
  const file = join(dir, `${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

export function listRuns(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort()
    .reverse();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/audit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/audit.ts tests/shared/audit.test.ts
git commit -m "feat: add JSONL audit log for agent runs"
```

---

### Task 3: Currency display and pool scoring

**Files:**
- Create: `src/shared/currency.ts`, `src/engine/scoring.ts`
- Test: `tests/shared/currency.test.ts`, `tests/engine/scoring.test.ts`

**Interfaces:**
- Consumes: `PoolSnapshot`, `PoolMetrics` from Task 1.
- Produces:
  - `displayCurrency(code: string): string`
  - `KNOWN_STABLE_ISSUERS: Record<string, string>`
  - `feeApy(volumeXrpPerDay: number, tradingFee: number, tvlXrp: number): number`
  - `riskScore(p: Pick<PoolSnapshot, "asset2Issuer" | "issuerVerified" | "tradingFee" | "frozen"> & { tvlXrp: number }): number`
  - `liquidityScore(deployXrp: number, tvlXrp: number): number`
  - `scorePool(snapshot: PoolSnapshot, volumeXrpPerDay: number, deployXrp: number): PoolMetrics`

Risk rules (the MVP heuristic, documented in README):
- start at 20
- issuer in `KNOWN_STABLE_ISSUERS`: +0; else if `issuerVerified`: +20; else +40
- `tvlXrp < 50_000`: +25; else `tvlXrp < 250_000`: +10
- `tradingFee > 500`: +10
- `frozen`: +30
- clamp to 0..100

Liquidity: `share = deployXrp / tvlXrp`; score = `round(100 * (1 - min(1, share * 5)))`, so deploying 20% of a pool scores 0 and 5% scores 75.

Risk-adjusted score: `feeApy * (1 - riskScore / 100)`.

- [ ] **Step 1: Write the failing currency test**

`tests/shared/currency.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { displayCurrency } from "../../src/shared/currency.js";

describe("displayCurrency", () => {
  it("returns 3-char codes unchanged", () => {
    expect(displayCurrency("USD")).toBe("USD");
    expect(displayCurrency("XRP")).toBe("XRP");
  });

  it("decodes 40-hex ASCII codes", () => {
    expect(displayCurrency("524C555344000000000000000000000000000000")).toBe("RLUSD");
    expect(displayCurrency("5553444300000000000000000000000000000000")).toBe("USDC");
  });

  it("falls back to the raw code when hex is not printable", () => {
    expect(displayCurrency("03B245BE580EC4F4386A751C084489EC4B514A2F")).toBe("03B245BE580EC4F4386A751C084489EC4B514A2F");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/currency.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/shared/currency.ts**

```ts
export function displayCurrency(code: string): string {
  if (!/^[0-9A-F]{40}$/i.test(code)) return code;
  const bytes = Buffer.from(code, "hex");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const text = bytes.subarray(0, end).toString("latin1");
  if (text.length === 0 || !/^[\x20-\x7E]+$/.test(text)) return code;
  return text;
}
```

- [ ] **Step 4: Run the currency test**

Run: `npx vitest run tests/shared/currency.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing scoring test**

`tests/engine/scoring.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { feeApy, liquidityScore, riskScore, scorePool } from "../../src/engine/scoring.js";
import type { PoolSnapshot } from "../../src/shared/types.js";

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

const rlusdPool: PoolSnapshot = {
  ammAccount: "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3",
  pairLabel: "XRP/RLUSD",
  asset2Currency: "524C555344000000000000000000000000000000",
  asset2Issuer: RLUSD_ISSUER,
  asset2Name: "RLUSD",
  issuerVerified: true,
  xrpBalanceDrops: "1673214842110",
  asset2Value: "2338593.89",
  tradingFee: 205,
  frozen: false,
};

describe("feeApy", () => {
  it("annualises fee income over TVL", () => {
    expect(feeApy(100_000, 1000, 1_000_000)).toBeCloseTo(0.365, 6);
  });
  it("returns 0 for empty pools", () => {
    expect(feeApy(100, 1000, 0)).toBe(0);
  });
});

describe("riskScore", () => {
  it("scores a deep allowlisted stable pool at the floor", () => {
    expect(riskScore({ asset2Issuer: RLUSD_ISSUER, issuerVerified: true, tradingFee: 205, frozen: false, tvlXrp: 3_000_000 })).toBe(20);
  });
  it("penalises unverified issuers, shallow depth, high fees and frozen assets", () => {
    expect(riskScore({ asset2Issuer: "rUnknown", issuerVerified: false, tradingFee: 800, frozen: true, tvlXrp: 10_000 })).toBe(100);
    expect(riskScore({ asset2Issuer: "rUnknown", issuerVerified: true, tradingFee: 100, frozen: false, tvlXrp: 100_000 })).toBe(50);
  });
});

describe("liquidityScore", () => {
  it("is 100 for a negligible share and 0 at 20% of the pool", () => {
    expect(liquidityScore(0, 1_000_000)).toBe(100);
    expect(liquidityScore(50_000, 1_000_000)).toBe(75);
    expect(liquidityScore(200_000, 1_000_000)).toBe(0);
  });
});

describe("scorePool", () => {
  it("combines metrics for a pool", () => {
    const m = scorePool(rlusdPool, 500_000, 20_000);
    expect(m.tvlXrp).toBeCloseTo(3_346_429.68, 0);
    expect(m.riskScore).toBe(20);
    expect(m.liquidityScore).toBe(97);
    expect(m.feeApy).toBeCloseTo(feeApy(500_000, 205, m.tvlXrp), 10);
    expect(m.riskAdjustedScore).toBeCloseTo(m.feeApy * 0.8, 10);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/engine/scoring.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 7: Create src/engine/scoring.ts**

```ts
import type { PoolMetrics, PoolSnapshot } from "../shared/types.js";

export const KNOWN_STABLE_ISSUERS: Record<string, string> = {
  rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De: "RLUSD",
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function feeApy(volumeXrpPerDay: number, tradingFee: number, tvlXrp: number): number {
  if (tvlXrp <= 0) return 0;
  return (volumeXrpPerDay * (tradingFee / 100_000) * 365) / tvlXrp;
}

export function riskScore(p: Pick<PoolSnapshot, "asset2Issuer" | "issuerVerified" | "tradingFee" | "frozen"> & { tvlXrp: number }): number {
  let score = 20;
  if (!(p.asset2Issuer in KNOWN_STABLE_ISSUERS)) score += p.issuerVerified ? 20 : 40;
  if (p.tvlXrp < 50_000) score += 25;
  else if (p.tvlXrp < 250_000) score += 10;
  if (p.tradingFee > 500) score += 10;
  if (p.frozen) score += 30;
  return clamp(score, 0, 100);
}

export function liquidityScore(deployXrp: number, tvlXrp: number): number {
  if (tvlXrp <= 0) return 0;
  const share = deployXrp / tvlXrp;
  return Math.round(100 * (1 - Math.min(1, share * 5)));
}

export function scorePool(snapshot: PoolSnapshot, volumeXrpPerDay: number, deployXrp: number): PoolMetrics {
  const tvlXrp = (Number(snapshot.xrpBalanceDrops) / 1_000_000) * 2;
  const apy = feeApy(volumeXrpPerDay, snapshot.tradingFee, tvlXrp);
  const risk = riskScore({ ...snapshot, tvlXrp });
  return {
    ...snapshot,
    tvlXrp,
    volumeXrpPerDay,
    feeApy: apy,
    riskScore: risk,
    liquidityScore: liquidityScore(deployXrp, tvlXrp),
    riskAdjustedScore: apy * (1 - risk / 100),
  };
}
```

- [ ] **Step 8: Run the scoring test**

Run: `npx vitest run tests/engine/scoring.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Commit**

```bash
git add src/shared/currency.ts src/engine/scoring.ts tests/shared/currency.test.ts tests/engine/scoring.test.ts
git commit -m "feat: add pool scoring heuristics and currency display"
```

---

### Task 4: Allocation optimizer

**Files:**
- Create: `src/engine/optimizer.ts`
- Test: `tests/engine/optimizer.test.ts`

**Interfaces:**
- Consumes: `Mandate`, `PoolMetrics`, `AllocationResult` from Task 1.
- Produces: `optimizeAllocation(mandate: Mandate, pools: PoolMetrics[], ctx: { rlusdPerXrp: number; ledgerIndex: number; sampledAt: string; now: Date }): AllocationResult`

Algorithm:
1. `reserve = amount * minimum_liquidity`; `deployable = amount - reserve`.
2. Eligible pools: `riskScore <= maximum_risk_score`, `liquidityScore >= 50`, `!frozen`, `feeApy > 0`. Sort by `riskAdjustedScore` descending.
3. For each eligible pool while `deployable > 0`: `slice = min(amount * maximum_protocol_allocation, deployable)`; push line; `deployable -= slice`.
4. Whatever is left joins the liquid reserve.
5. `expected_apy = Σ(weight * feeApy)`; portfolio risk and liquidity are weight-averaged over deployed lines (0 and 100 respectively when nothing is deployed).
6. `recommendation` is the pairLabel of the first line, or `"hold_liquid"` when nothing qualifies.
7. `valid_until = now + 1 hour`.

- [ ] **Step 1: Write the failing test**

`tests/engine/optimizer.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { optimizeAllocation } from "../../src/engine/optimizer.js";
import type { Mandate, PoolMetrics } from "../../src/shared/types.js";

const mandate: Mandate = {
  asset: "RLUSD",
  amount: 100000,
  horizon_hours: 72,
  minimum_liquidity: 0.5,
  maximum_risk_score: 30,
  maximum_protocol_allocation: 0.25,
};

function pool(over: Partial<PoolMetrics>): PoolMetrics {
  return {
    ammAccount: "rPool",
    pairLabel: "XRP/TEST",
    asset2Currency: "TST",
    asset2Issuer: "rIssuer",
    asset2Name: null,
    issuerVerified: false,
    xrpBalanceDrops: "0",
    asset2Value: "0",
    tradingFee: 100,
    frozen: false,
    tvlXrp: 1_000_000,
    volumeXrpPerDay: 100_000,
    feeApy: 0.05,
    riskScore: 20,
    liquidityScore: 90,
    riskAdjustedScore: 0.04,
    ...over,
  };
}

const ctx = { rlusdPerXrp: 1.4, ledgerIndex: 100, sampledAt: "2026-09-04T00:00:00.000Z", now: new Date("2026-09-04T12:00:00.000Z") };

describe("optimizeAllocation", () => {
  it("keeps the liquidity reserve and caps each pool at the concentration limit", () => {
    const a = pool({ ammAccount: "rA", pairLabel: "XRP/A", feeApy: 0.08, riskScore: 25, riskAdjustedScore: 0.06 });
    const b = pool({ ammAccount: "rB", pairLabel: "XRP/B", feeApy: 0.05, riskScore: 20, riskAdjustedScore: 0.04 });
    const c = pool({ ammAccount: "rC", pairLabel: "XRP/C", feeApy: 0.3, riskScore: 60, riskAdjustedScore: 0.12 });
    const r = optimizeAllocation(mandate, [b, c, a], ctx);

    expect(r.recommendation).toBe("XRP/A");
    expect(r.allocations.map((l) => [l.pairLabel, l.weight, l.amount])).toEqual([
      ["XRP/A", 0.25, 25000],
      ["XRP/B", 0.25, 25000],
    ]);
    expect(r.liquid_reserve).toEqual({ weight: 0.5, amount: 50000 });
    expect(r.expected_apy).toBeCloseTo(0.25 * 0.08 + 0.25 * 0.05, 10);
    expect(r.portfolio_risk_score).toBe(22.5);
    expect(r.opportunities_considered).toBe(3);
    expect(r.valid_until).toBe("2026-09-04T13:00:00.000Z");
    expect(r.data).toEqual({ ledger_index: 100, rlusd_per_xrp: 1.4, sampled_at: ctx.sampledAt });
  });

  it("holds everything liquid when no pool satisfies the mandate", () => {
    const r = optimizeAllocation(mandate, [pool({ riskScore: 80 }), pool({ liquidityScore: 10 }), pool({ frozen: true })], ctx);
    expect(r.recommendation).toBe("hold_liquid");
    expect(r.allocations).toEqual([]);
    expect(r.liquid_reserve).toEqual({ weight: 1, amount: 100000 });
    expect(r.expected_apy).toBe(0);
    expect(r.portfolio_risk_score).toBe(0);
    expect(r.portfolio_liquidity_score).toBe(100);
  });

  it("returns leftover deployable capital to the reserve when few pools qualify", () => {
    const r = optimizeAllocation(mandate, [pool({ pairLabel: "XRP/ONLY" })], ctx);
    expect(r.allocations).toHaveLength(1);
    expect(r.liquid_reserve).toEqual({ weight: 0.75, amount: 75000 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/engine/optimizer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/engine/optimizer.ts**

```ts
import type { AllocationLine, AllocationResult, Mandate, PoolMetrics } from "../shared/types.js";

const MIN_LIQUIDITY_SCORE = 50;
const VALIDITY_MS = 60 * 60 * 1000;

export function optimizeAllocation(
  mandate: Mandate,
  pools: PoolMetrics[],
  ctx: { rlusdPerXrp: number; ledgerIndex: number; sampledAt: string; now: Date },
): AllocationResult {
  const eligible = pools
    .filter((p) => p.riskScore <= mandate.maximum_risk_score && p.liquidityScore >= MIN_LIQUIDITY_SCORE && !p.frozen && p.feeApy > 0)
    .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);

  let deployable = mandate.amount * (1 - mandate.minimum_liquidity);
  const cap = mandate.amount * mandate.maximum_protocol_allocation;
  const allocations: AllocationLine[] = [];
  for (const p of eligible) {
    if (deployable <= 0) break;
    const amount = Math.min(cap, deployable);
    deployable -= amount;
    allocations.push({
      ammAccount: p.ammAccount,
      pairLabel: p.pairLabel,
      weight: amount / mandate.amount,
      amount,
      feeApy: p.feeApy,
      riskScore: p.riskScore,
      liquidityScore: p.liquidityScore,
    });
  }

  const deployedWeight = allocations.reduce((s, l) => s + l.weight, 0);
  const reserveAmount = mandate.amount - allocations.reduce((s, l) => s + l.amount, 0);
  const weighted = (pick: (l: AllocationLine) => number) =>
    deployedWeight === 0 ? 0 : allocations.reduce((s, l) => s + (l.weight / deployedWeight) * pick(l), 0);

  const rejected = pools.length - eligible.length;
  const reasoning =
    allocations.length === 0
      ? `None of ${pools.length} observed pools satisfied risk <= ${mandate.maximum_risk_score} with adequate depth; hold liquid.`
      : `${allocations.length} pool(s) selected by risk-adjusted fee yield; ${rejected} rejected on risk or depth; ${Math.round(mandate.minimum_liquidity * 100)}% reserve kept liquid per mandate.`;

  return {
    recommendation: allocations[0]?.pairLabel ?? "hold_liquid",
    allocations,
    liquid_reserve: { weight: reserveAmount / mandate.amount, amount: reserveAmount },
    expected_apy: allocations.reduce((s, l) => s + l.weight * l.feeApy, 0),
    portfolio_risk_score: weighted((l) => l.riskScore),
    portfolio_liquidity_score: deployedWeight === 0 ? 100 : weighted((l) => l.liquidityScore),
    reasoning,
    opportunities_considered: pools.length,
    data: { ledger_index: ctx.ledgerIndex, rlusd_per_xrp: ctx.rlusdPerXrp, sampled_at: ctx.sampledAt },
    timestamp: ctx.now.toISOString(),
    valid_until: new Date(ctx.now.getTime() + VALIDITY_MS).toISOString(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/engine/optimizer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/optimizer.ts tests/engine/optimizer.test.ts
git commit -m "feat: add constrained greedy allocation optimizer"
```

---

### Task 5: Live XRPL data adapters

**Files:**
- Create: `src/engine/xrplData.ts`
- Test: `tests/engine/xrplData.test.ts`

**Interfaces:**
- Consumes: `PoolSnapshot` from Task 1, `displayCurrency` from Task 3.
- Produces:
  - `type XrplRpc = { request(req: any): Promise<any> }` (structural subset of `xrpl.Client`)
  - `discoverPools(fetchImpl?: typeof fetch, opts?: { minXrpSide?: number; limit?: number }): Promise<PoolSnapshot[]>`
  - `fetchPoolState(rpc: XrplRpc, snapshot: PoolSnapshot): Promise<{ snapshot: PoolSnapshot; ledgerIndex: number }>`
  - `sampleVolume(rpc: XrplRpc, ammAccount: string, limit?: number): Promise<{ volumeXrpPerDay: number; sampleSize: number; spanSeconds: number }>`
  - `XRPSCAN_POOLS_URL`

- [ ] **Step 1: Write the failing test**

`tests/engine/xrplData.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { discoverPools, fetchPoolState, sampleVolume } from "../../src/engine/xrplData.js";
import type { PoolSnapshot } from "../../src/shared/types.js";

const RLUSD = "524C555344000000000000000000000000000000";

const xrpscanRows = [
  {
    Account: "rBig",
    Asset: { currency: "XRP" },
    Asset2: { currency: RLUSD, issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
    Balance: 1673214842110,
    TradingFee: 205,
    Asset2Name: { name: "RLUSD", verified: true },
  },
  {
    Account: "rSmall",
    Asset: { currency: "XRP" },
    Asset2: { currency: "TST", issuer: "rT" },
    Balance: 5_000_000_000,
    TradingFee: 900,
    Asset2Name: null,
  },
  {
    Account: "rNotXrp",
    Asset: { currency: "USD", issuer: "rU" },
    Asset2: { currency: "TST", issuer: "rT" },
    Balance: 0,
    TradingFee: 1,
    Asset2Name: null,
  },
];

const fakeFetch = (async () => new Response(JSON.stringify(xrpscanRows), { status: 200 })) as typeof fetch;

function ammXrpDeltaMeta(account: string, beforeDrops: string, afterDrops: string) {
  return {
    AffectedNodes: [
      {
        ModifiedNode: {
          LedgerEntryType: "AccountRoot",
          LedgerIndex: "A".repeat(64),
          FinalFields: { Account: account, Balance: afterDrops, Flags: 0, OwnerCount: 0, Sequence: 1 },
          PreviousFields: { Balance: beforeDrops },
        },
      },
    ],
    TransactionIndex: 0,
    TransactionResult: "tesSUCCESS",
  };
}

describe("discoverPools", () => {
  it("keeps XRP-paired pools above the depth floor, sorted by depth", async () => {
    const pools = await discoverPools(fakeFetch, { minXrpSide: 1000 });
    expect(pools.map((p) => p.ammAccount)).toEqual(["rBig", "rSmall"]);
    expect(pools[0]).toMatchObject<Partial<PoolSnapshot>>({
      pairLabel: "XRP/RLUSD",
      asset2Currency: RLUSD,
      asset2Issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      issuerVerified: true,
      xrpBalanceDrops: "1673214842110",
      tradingFee: 205,
      frozen: false,
    });
    expect(pools[1].pairLabel).toBe("XRP/TST");
    expect(pools[1].issuerVerified).toBe(false);
  });

  it("applies the depth floor and limit", async () => {
    expect(await discoverPools(fakeFetch, { minXrpSide: 10_000 })).toHaveLength(1);
    expect(await discoverPools(fakeFetch, { minXrpSide: 1000, limit: 1 })).toHaveLength(1);
  });
});

describe("fetchPoolState", () => {
  it("refreshes balances, fee, frozen flag and returns the ledger index", async () => {
    const rpc = {
      request: async (req: any) => {
        expect(req.command).toBe("amm_info");
        expect(req.amm_account).toBe("rBig");
        return {
          result: {
            amm: { amount: "2000000000", amount2: { currency: RLUSD, issuer: "rI", value: "2800" }, trading_fee: 300, asset2_frozen: true },
            ledger_index: 12345,
          },
        };
      },
    };
    const base = (await discoverPools(fakeFetch, { minXrpSide: 1000 }))[0];
    const { snapshot, ledgerIndex } = await fetchPoolState(rpc, base);
    expect(snapshot.xrpBalanceDrops).toBe("2000000000");
    expect(snapshot.asset2Value).toBe("2800");
    expect(snapshot.tradingFee).toBe(300);
    expect(snapshot.frozen).toBe(true);
    expect(ledgerIndex).toBe(12345);
  });
});

describe("sampleVolume", () => {
  it("sums absolute XRP balance changes on the AMM account and annualises over the sample span", async () => {
    const rpc = {
      request: async (req: any) => {
        expect(req.command).toBe("account_tx");
        return {
          result: {
            transactions: [
              { close_time_iso: "2026-09-04T12:00:00Z", meta: ammXrpDeltaMeta("rBig", "1000000000000", "1003000000000") },
              { close_time_iso: "2026-09-04T11:00:00Z", meta: ammXrpDeltaMeta("rBig", "1003000000000", "1000000000000") },
              { close_time_iso: "2026-09-04T00:00:00Z", meta: ammXrpDeltaMeta("rOther", "5", "6") },
            ],
          },
        };
      },
    };
    const v = await sampleVolume(rpc, "rBig");
    expect(v.sampleSize).toBe(3);
    expect(v.spanSeconds).toBe(12 * 3600);
    expect(v.volumeXrpPerDay).toBeCloseTo(6000 * 2, 6);
  });

  it("returns zero volume with fewer than two transactions", async () => {
    const rpc = { request: async () => ({ result: { transactions: [] } }) };
    expect(await sampleVolume(rpc, "rBig")).toEqual({ volumeXrpPerDay: 0, sampleSize: 0, spanSeconds: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/engine/xrplData.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/engine/xrplData.ts**

```ts
import { getBalanceChanges } from "xrpl";
import { displayCurrency } from "../shared/currency.js";
import type { PoolSnapshot } from "../shared/types.js";

export const XRPSCAN_POOLS_URL = "https://api.xrpscan.com/api/v1/amm/pools";

export type XrplRpc = { request(req: any): Promise<any> };

interface XrpscanPool {
  Account: string;
  Asset: { currency: string; issuer?: string };
  Asset2: { currency: string; issuer?: string };
  Balance: number;
  TradingFee: number;
  Asset2Name: { name: string; verified: boolean } | null;
}

export async function discoverPools(
  fetchImpl: typeof fetch = fetch,
  opts: { minXrpSide?: number; limit?: number } = {},
): Promise<PoolSnapshot[]> {
  const minXrpSide = opts.minXrpSide ?? 25_000;
  const limit = opts.limit ?? 12;
  const res = await fetchImpl(XRPSCAN_POOLS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`xrpscan pools request failed: ${res.status}`);
  const rows = (await res.json()) as XrpscanPool[];
  return rows
    .filter((r) => r.Asset.currency === "XRP" && typeof r.Balance === "number" && r.Balance / 1_000_000 >= minXrpSide)
    .sort((a, b) => b.Balance - a.Balance)
    .slice(0, limit)
    .map((r) => ({
      ammAccount: r.Account,
      pairLabel: `XRP/${r.Asset2Name?.name ?? displayCurrency(r.Asset2.currency)}`,
      asset2Currency: r.Asset2.currency,
      asset2Issuer: r.Asset2.issuer ?? "",
      asset2Name: r.Asset2Name?.name ?? null,
      issuerVerified: r.Asset2Name?.verified === true,
      xrpBalanceDrops: String(r.Balance),
      asset2Value: "0",
      tradingFee: r.TradingFee,
      frozen: false,
    }));
}

export async function fetchPoolState(rpc: XrplRpc, snapshot: PoolSnapshot): Promise<{ snapshot: PoolSnapshot; ledgerIndex: number }> {
  const { result } = await rpc.request({ command: "amm_info", amm_account: snapshot.ammAccount, ledger_index: "validated" });
  const amm = result.amm;
  return {
    snapshot: {
      ...snapshot,
      xrpBalanceDrops: String(amm.amount),
      asset2Value: String(amm.amount2.value),
      tradingFee: amm.trading_fee,
      frozen: amm.asset2_frozen === true,
    },
    ledgerIndex: result.ledger_index,
  };
}

export async function sampleVolume(
  rpc: XrplRpc,
  ammAccount: string,
  limit = 200,
): Promise<{ volumeXrpPerDay: number; sampleSize: number; spanSeconds: number }> {
  const { result } = await rpc.request({
    command: "account_tx",
    account: ammAccount,
    limit,
    ledger_index_min: -1,
    ledger_index_max: -1,
  });
  const txs = result.transactions as Array<{ close_time_iso: string; meta: any }>;
  if (txs.length < 2) return { volumeXrpPerDay: 0, sampleSize: txs.length, spanSeconds: 0 };

  let xrpMoved = 0;
  for (const tx of txs) {
    for (const change of getBalanceChanges(tx.meta)) {
      if (change.account !== ammAccount) continue;
      for (const b of change.balances) if (b.currency === "XRP") xrpMoved += Math.abs(Number(b.value));
    }
  }
  const times = txs.map((t) => Date.parse(t.close_time_iso));
  const spanSeconds = Math.max(60, (Math.max(...times) - Math.min(...times)) / 1000);
  return { volumeXrpPerDay: (xrpMoved * 86_400) / spanSeconds, sampleSize: txs.length, spanSeconds };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/engine/xrplData.test.ts`
Expected: PASS (5 tests). If `getBalanceChanges` reports the XRP delta with a different sign convention, the `Math.abs` keeps the sum correct; the expected value is `(3000 + 3000) XRP * 86400 / 43200 = 12000`.

- [ ] **Step 5: Smoke against mainnet, read-only**

Run:
```bash
npx tsx -e "import { Client } from 'xrpl'; import { discoverPools, fetchPoolState, sampleVolume } from './src/engine/xrplData.ts'; const c = new Client('wss://s1.ripple.com:51233'); await c.connect(); const pools = await discoverPools(); const { snapshot, ledgerIndex } = await fetchPoolState(c, pools[0]); console.log(ledgerIndex, snapshot.pairLabel, snapshot.tradingFee); console.log(await sampleVolume(c, snapshot.ammAccount)); await c.disconnect();"
```
Expected: prints a ledger index above 106,000,000, a pair label, and a volume object with `sampleSize` 200 and a positive `volumeXrpPerDay`.

- [ ] **Step 6: Commit**

```bash
git add src/engine/xrplData.ts tests/engine/xrplData.test.ts
git commit -m "feat: read live AMM pool state and sample trade volume"
```

---

### Task 6: Engine orchestration

**Files:**
- Create: `src/engine/engine.ts`
- Test: `tests/engine/engine.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5 exports; `Mandate`, `AllocationResult`, `Opportunity` from Task 1.
- Produces:
  - `interface EngineDeps { rpc: XrplRpc; fetchImpl?: typeof fetch; now?: () => Date }`
  - `listOpportunities(deps: EngineDeps): Promise<Opportunity[]>`
  - `runAnalysis(deps: EngineDeps, mandate: Mandate): Promise<AllocationResult>`
  - `RLUSD_AMM_ACCOUNT = "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3"`

`runAnalysis`: discover → for every pool in parallel `fetchPoolState` + `sampleVolume` → derive `rlusdPerXrp` from the RLUSD pool (`asset2Value / (xrpBalanceDrops / 1e6)`), throw if that pool is absent → `deployXrp = mandate.amount * maximum_protocol_allocation / rlusdPerXrp` → `scorePool` each → `optimizeAllocation`.

- [ ] **Step 1: Write the failing test**

`tests/engine/engine.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RLUSD_AMM_ACCOUNT, listOpportunities, runAnalysis } from "../../src/engine/engine.js";
import type { Mandate } from "../../src/shared/types.js";

const RLUSD = "524C555344000000000000000000000000000000";

const rows = [
  { Account: RLUSD_AMM_ACCOUNT, Asset: { currency: "XRP" }, Asset2: { currency: RLUSD, issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" }, Balance: 1_000_000_000_000, TradingFee: 200, Asset2Name: { name: "RLUSD", verified: true } },
  { Account: "rRisky", Asset: { currency: "XRP" }, Asset2: { currency: "TST", issuer: "rT" }, Balance: 100_000_000_000, TradingFee: 900, Asset2Name: null },
];
const fetchImpl = (async () => new Response(JSON.stringify(rows))) as typeof fetch;

function meta(account: string, before: string, after: string) {
  return {
    AffectedNodes: [{ ModifiedNode: { LedgerEntryType: "AccountRoot", LedgerIndex: "B".repeat(64), FinalFields: { Account: account, Balance: after, Flags: 0, OwnerCount: 0, Sequence: 1 }, PreviousFields: { Balance: before } } }],
    TransactionIndex: 0,
    TransactionResult: "tesSUCCESS",
  };
}

const rpc = {
  request: async (req: any) => {
    if (req.command === "amm_info") {
      const row = rows.find((r) => r.Account === req.amm_account)!;
      return { result: { amm: { amount: String(row.Balance), amount2: { currency: row.Asset2.currency, issuer: row.Asset2.issuer, value: String((row.Balance / 1e6) * 1.4) }, trading_fee: row.TradingFee, asset2_frozen: false }, ledger_index: 777 } };
    }
    return {
      result: {
        transactions: [
          { close_time_iso: "2026-09-04T12:00:00Z", meta: meta(req.account, "1000000000000", "1050000000000") },
          { close_time_iso: "2026-09-04T00:00:00Z", meta: meta(req.account, "1050000000000", "1000000000000") },
        ],
      },
    };
  },
};

const mandate: Mandate = { asset: "RLUSD", amount: 100000, horizon_hours: 72, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 };

describe("engine", () => {
  it("lists opportunities without scores", async () => {
    const list = await listOpportunities({ rpc, fetchImpl });
    expect(list).toEqual([
      { ammAccount: RLUSD_AMM_ACCOUNT, pairLabel: "XRP/RLUSD", tvlXrp: 2_000_000, tradingFeeBps: 20 },
      { ammAccount: "rRisky", pairLabel: "XRP/TST", tvlXrp: 200_000, tradingFeeBps: 90 },
    ]);
  });

  it("runs the full analysis on live-shaped data", async () => {
    const now = () => new Date("2026-09-04T12:00:00.000Z");
    const r = await runAnalysis({ rpc, fetchImpl, now }, mandate);
    expect(r.recommendation).toBe("XRP/RLUSD");
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].riskScore).toBe(20);
    expect(r.liquid_reserve.amount).toBe(75000);
    expect(r.data.ledger_index).toBe(777);
    expect(r.data.rlusd_per_xrp).toBeCloseTo(1.4, 10);
    expect(r.timestamp).toBe("2026-09-04T12:00:00.000Z");
    expect(r.opportunities_considered).toBe(2);
  });

  it("fails loudly without the RLUSD reference pool", async () => {
    const noRlusd = (async () => new Response(JSON.stringify([rows[1]]))) as typeof fetch;
    await expect(runAnalysis({ rpc, fetchImpl: noRlusd }, mandate)).rejects.toThrow(/RLUSD/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/engine/engine.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/engine/engine.ts**

```ts
import type { AllocationResult, Mandate, Opportunity } from "../shared/types.js";
import { optimizeAllocation } from "./optimizer.js";
import { scorePool } from "./scoring.js";
import { discoverPools, fetchPoolState, sampleVolume, type XrplRpc } from "./xrplData.js";

export const RLUSD_AMM_ACCOUNT = "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3";

export interface EngineDeps {
  rpc: XrplRpc;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function listOpportunities(deps: EngineDeps): Promise<Opportunity[]> {
  const pools = await discoverPools(deps.fetchImpl);
  return pools.map((p) => ({
    ammAccount: p.ammAccount,
    pairLabel: p.pairLabel,
    tvlXrp: (Number(p.xrpBalanceDrops) / 1_000_000) * 2,
    tradingFeeBps: p.tradingFee / 10,
  }));
}

export async function runAnalysis(deps: EngineDeps, mandate: Mandate): Promise<AllocationResult> {
  const now = deps.now ?? (() => new Date());
  const discovered = await discoverPools(deps.fetchImpl);
  const live = await Promise.all(
    discovered.map(async (p) => {
      const [state, volume] = await Promise.all([fetchPoolState(deps.rpc, p), sampleVolume(deps.rpc, p.ammAccount)]);
      return { ...state, volume };
    }),
  );

  const rlusd = live.find((l) => l.snapshot.ammAccount === RLUSD_AMM_ACCOUNT);
  if (!rlusd) throw new Error("RLUSD reference pool not found in discovered pools");
  const rlusdPerXrp = Number(rlusd.snapshot.asset2Value) / (Number(rlusd.snapshot.xrpBalanceDrops) / 1_000_000);
  const deployXrp = (mandate.amount * mandate.maximum_protocol_allocation) / rlusdPerXrp;

  const scored = live.map((l) => scorePool(l.snapshot, l.volume.volumeXrpPerDay, deployXrp));
  const ledgerIndex = Math.max(...live.map((l) => l.ledgerIndex));
  return optimizeAllocation(mandate, scored, { rlusdPerXrp, ledgerIndex, sampledAt: now().toISOString(), now: now() });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/engine/engine.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts tests/engine/engine.test.ts
git commit -m "feat: orchestrate live data, scoring and optimisation"
```

---

### Task 7: Seller MCP server

**Files:**
- Create: `src/seller/mcp.ts`
- Test: `tests/seller/mcp.test.ts`

**Interfaces:**
- Consumes: `listOpportunities`, `runAnalysis` signatures from Task 6 (injected as functions so tests need no network).
- Produces:
  - `interface SellerConfig { payTo: string; network: string; facilitatorUrl: string; priceDrops: string; baseUrl: string }`
  - `interface SellerEngine { listOpportunities(): Promise<Opportunity[]>; runAnalysis(mandate: Mandate): Promise<AllocationResult> }`
  - `buildMcpServer(cfg: SellerConfig, engine: SellerEngine): McpServer`
  - `MANDATE_SHAPE` (zod raw shape for the mandate; reused by the HTTP route in Task 8)
  - `interface PaymentRequiredEnvelope { status: "payment_required"; resource: string; method: "POST"; price_drops: string; asset: "XRP"; network: string; pay_to: string; description: string; input: Mandate }`

Tools:
- `list_opportunities` (free): returns JSON text of `Opportunity[]`.
- `optimize_allocation` (paid): validates the mandate and returns a `PaymentRequiredEnvelope` as JSON text. It never runs the engine; the paid HTTP resource does.

- [ ] **Step 1: Write the failing test**

`tests/seller/mcp.test.ts`:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer, type SellerConfig } from "../../src/seller/mcp.js";

const cfg: SellerConfig = {
  payTo: "rSeller",
  network: "xrpl:1",
  facilitatorUrl: "https://xrpl-facilitator-testnet.t54.ai",
  priceDrops: "500000",
  baseUrl: "http://127.0.0.1:8080",
};

const engine = {
  listOpportunities: async () => [{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 100, tradingFeeBps: 20 }],
  runAnalysis: async () => {
    throw new Error("must not run over MCP");
  },
};

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(cfg, engine);
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function text(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe("seller MCP server", () => {
  it("advertises both tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_opportunities", "optimize_allocation"]);
    const paid = tools.find((t) => t.name === "optimize_allocation")!;
    expect(paid.description).toContain("500000 drops");
  });

  it("serves list_opportunities for free", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "list_opportunities", arguments: {} });
    expect(text(res)).toEqual([{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 100, tradingFeeBps: 20 }]);
  });

  it("answers optimize_allocation with a payment_required envelope", async () => {
    const client = await connect();
    const mandate = { asset: "RLUSD", amount: 100000, horizon_hours: 72, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 };
    const res = await client.callTool({ name: "optimize_allocation", arguments: mandate });
    expect(text(res)).toEqual({
      status: "payment_required",
      resource: "http://127.0.0.1:8080/api/optimize_allocation",
      method: "POST",
      price_drops: "500000",
      asset: "XRP",
      network: "xrpl:1",
      pay_to: "rSeller",
      description: "Risk-adjusted RLUSD allocation across live XRPL AMM pools",
      input: mandate,
    });
  });

  it("rejects an invalid mandate", async () => {
    const client = await connect();
    const res: any = await client.callTool({ name: "optimize_allocation", arguments: { asset: "RLUSD", amount: -1 } });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/seller/mcp.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/seller/mcp.ts**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AllocationResult, Mandate, Opportunity } from "../shared/types.js";

export interface SellerConfig {
  payTo: string;
  network: string;
  facilitatorUrl: string;
  priceDrops: string;
  baseUrl: string;
}

export interface SellerEngine {
  listOpportunities(): Promise<Opportunity[]>;
  runAnalysis(mandate: Mandate): Promise<AllocationResult>;
}

export interface PaymentRequiredEnvelope {
  status: "payment_required";
  resource: string;
  method: "POST";
  price_drops: string;
  asset: "XRP";
  network: string;
  pay_to: string;
  description: string;
  input: Mandate;
}

export const OPTIMIZE_DESCRIPTION = "Risk-adjusted RLUSD allocation across live XRPL AMM pools";
export const OPTIMIZE_PATH = "/api/optimize_allocation";

export const MANDATE_SHAPE = {
  asset: z.literal("RLUSD").describe("Capital asset. Only RLUSD is supported."),
  amount: z.number().positive().describe("Total capital in RLUSD"),
  horizon_hours: z.number().positive().describe("Investment horizon in hours"),
  minimum_liquidity: z.number().min(0).max(1).describe("Fraction of capital that must stay liquid"),
  maximum_risk_score: z.number().min(0).max(100).describe("Reject any pool with a risk score above this"),
  maximum_protocol_allocation: z.number().min(0).max(1).describe("Maximum fraction of capital in one pool"),
};

export function buildMcpServer(cfg: SellerConfig, engine: SellerEngine): McpServer {
  const server = new McpServer({ name: "xrpl-financial-intelligence", version: "0.1.0" });

  server.registerTool(
    "list_opportunities",
    {
      description: "Free. Lists the XRP-paired AMM pools currently observed on XRPL mainnet with depth and fee only. No scores, no recommendation.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await engine.listOpportunities()) }] }),
  );

  server.registerTool(
    "optimize_allocation",
    {
      description: `Paid: ${cfg.priceDrops} drops of XRP per call via x402 on ${cfg.network}. Given a capital mandate, returns a risk-adjusted allocation across live XRPL AMM pools with expected APY, risk and liquidity scores, and reasoning. Calling this tool returns a payment_required envelope; pay the resource it names with x402 to receive the analysis.`,
      inputSchema: MANDATE_SHAPE,
    },
    async (mandate) => {
      const envelope: PaymentRequiredEnvelope = {
        status: "payment_required",
        resource: `${cfg.baseUrl}${OPTIMIZE_PATH}`,
        method: "POST",
        price_drops: cfg.priceDrops,
        asset: "XRP",
        network: cfg.network,
        pay_to: cfg.payTo,
        description: OPTIMIZE_DESCRIPTION,
        input: mandate as Mandate,
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    },
  );

  return server;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/seller/mcp.test.ts`
Expected: PASS (4 tests). The invalid-mandate case relies on the SDK's zod validation returning a tool result with `isError: true` (SDK 1.30 catches InvalidParams inside the tool handler rather than rejecting the call).

- [ ] **Step 5: Commit**

```bash
git add src/seller/mcp.ts tests/seller/mcp.test.ts
git commit -m "feat: expose intelligence tools over MCP with payment_required envelope"
```

---

### Task 8: Seller HTTP app with x402-guarded resource

**Files:**
- Create: `src/seller/app.ts`, `src/seller/index.ts`
- Test: `tests/seller/app.test.ts`

**Interfaces:**
- Consumes: `buildMcpServer`, `SellerConfig`, `SellerEngine`, `MANDATE_SHAPE`, `OPTIMIZE_PATH`, `OPTIMIZE_DESCRIPTION` from Task 7; `runAnalysis`, `listOpportunities` from Task 6.
- Produces:
  - `buildSellerApp(cfg: SellerConfig, engine: SellerEngine, opts?: { paymentGuard?: RequestHandler }): Express`
  - Routes: `GET /health` → `{ status: "ok" }`; `POST /mcp` stateless MCP; `GET|DELETE /mcp` → 405; `POST /api/optimize_allocation` (guarded) → `AllocationResult`; `GET /api/catalog` → `{ tools: [{ name, price_drops, asset, network, resource }] }`.
  - `paymentGuard` defaults to `requirePayment` from `x402-xrpl/express`; tests inject a pass-through.

- [ ] **Step 1: Write the failing test**

`tests/seller/app.test.ts`:
```ts
import type { RequestHandler } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSellerApp } from "../../src/seller/app.js";
import type { SellerConfig } from "../../src/seller/mcp.js";
import type { AllocationResult } from "../../src/shared/types.js";

const cfg: SellerConfig = { payTo: "rSeller", network: "xrpl:1", facilitatorUrl: "http://unused", priceDrops: "500000", baseUrl: "" };

const fakeResult: AllocationResult = {
  recommendation: "XRP/RLUSD",
  allocations: [],
  liquid_reserve: { weight: 1, amount: 100000 },
  expected_apy: 0,
  portfolio_risk_score: 0,
  portfolio_liquidity_score: 100,
  reasoning: "test",
  opportunities_considered: 0,
  data: { ledger_index: 1, rlusd_per_xrp: 1.4, sampled_at: "t" },
  timestamp: "t",
  valid_until: "t",
};

let seen: unknown[] = [];
const passThrough: RequestHandler = (_req, _res, next) => {
  seen.push("guard");
  next();
};

const engine = {
  listOpportunities: async () => [],
  runAnalysis: async (mandate: unknown) => {
    seen.push(mandate);
    return fakeResult;
  },
};

let baseUrl = "";
let server: ReturnType<ReturnType<typeof buildSellerApp>["listen"]>;

beforeAll(async () => {
  const app = buildSellerApp({ ...cfg, baseUrl: "" }, engine, { paymentGuard: passThrough });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

describe("seller app", () => {
  it("reports health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the MCP endpoint over Streamable HTTP", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_opportunities", "optimize_allocation"]);
    await client.close();
  });

  it("runs the paid analysis behind the payment guard", async () => {
    seen = [];
    const mandate = { asset: "RLUSD", amount: 100000, horizon_hours: 72, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 };
    const res = await fetch(`${baseUrl}/api/optimize_allocation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mandate),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fakeResult);
    expect(seen).toEqual(["guard", mandate]);
  });

  it("rejects a malformed mandate with 400", async () => {
    const res = await fetch(`${baseUrl}/api/optimize_allocation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: "RLUSD" }),
    });
    expect(res.status).toBe(400);
  });

  it("publishes a catalog", async () => {
    const res = await fetch(`${baseUrl}/api/catalog`);
    const body = await res.json();
    expect(body.tools[0]).toMatchObject({ name: "optimize_allocation", price_drops: "500000", asset: "XRP", network: "xrpl:1" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/seller/app.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/seller/app.ts**

```ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type RequestHandler } from "express";
import { requirePayment } from "x402-xrpl/express";
import * as z from "zod/v4";
import { MANDATE_SHAPE, OPTIMIZE_DESCRIPTION, OPTIMIZE_PATH, buildMcpServer, type SellerConfig, type SellerEngine } from "./mcp.js";

const mandateSchema = z.object(MANDATE_SHAPE);

export function buildSellerApp(cfg: SellerConfig, engine: SellerEngine, opts: { paymentGuard?: RequestHandler } = {}): Express {
  const app = express();
  app.use(express.json());

  const guard =
    opts.paymentGuard ??
    requirePayment({
      path: OPTIMIZE_PATH,
      price: cfg.priceDrops,
      payToAddress: cfg.payTo,
      network: cfg.network,
      facilitatorUrl: cfg.facilitatorUrl,
      asset: "XRP",
      resource: "xrpl-fi:optimize_allocation",
      description: OPTIMIZE_DESCRIPTION,
      settle: true,
    });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/catalog", (_req, res) => {
    res.json({
      tools: [
        { name: "optimize_allocation", price_drops: cfg.priceDrops, asset: "XRP", network: cfg.network, resource: `${cfg.baseUrl}${OPTIMIZE_PATH}` },
      ],
    });
  });

  app.post(OPTIMIZE_PATH, guard, async (req, res) => {
    const parsed = mandateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid mandate", issues: parsed.error.issues });
      return;
    }
    res.json(await engine.runAnalysis(parsed.data));
  });

  app.post("/mcp", async (req, res) => {
    const server = buildMcpServer(cfg, engine);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const reject: RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", reject);
  app.delete("/mcp", reject);

  return app;
}
```

- [ ] **Step 4: Create src/seller/index.ts**

```ts
import "dotenv/config";
import { Client } from "xrpl";
import { listOpportunities, runAnalysis } from "../engine/engine.js";
import { buildSellerApp } from "./app.js";

const port = Number(process.env.SELLER_PORT ?? "8080");
const payTo = process.env.XRPL_PAY_TO;
if (!payTo) throw new Error("XRPL_PAY_TO is required");

const cfg = {
  payTo,
  network: process.env.XRPL_NETWORK ?? "xrpl:1",
  facilitatorUrl: process.env.XRPL_FACILITATOR_URL ?? "https://xrpl-facilitator-testnet.t54.ai",
  priceDrops: process.env.XRPL_PRICE_DROPS ?? "500000",
  baseUrl: process.env.SELLER_BASE_URL ?? `http://127.0.0.1:${port}`,
};

const mainnet = new Client(process.env.XRPL_MAINNET_WS ?? "wss://s1.ripple.com:51233");
await mainnet.connect();

const engine = {
  listOpportunities: () => listOpportunities({ rpc: mainnet }),
  runAnalysis: (mandate: Parameters<typeof runAnalysis>[1]) => runAnalysis({ rpc: mainnet }, mandate),
};

buildSellerApp(cfg, engine).listen(port, "127.0.0.1", () => {
  console.log(`seller listening on ${cfg.baseUrl}`);
  console.log(`MCP endpoint ${cfg.baseUrl}/mcp`);
  console.log(`paid resource ${cfg.baseUrl}/api/optimize_allocation at ${cfg.priceDrops} drops -> ${cfg.payTo}`);
});
```

- [ ] **Step 5: Run the test and typecheck**

Run: `npx vitest run tests/seller/app.test.ts && npm run typecheck`
Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 6: Manually confirm the real guard emits a 402**

Run (any valid r-address works for this check):
```bash
XRPL_PAY_TO=rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3 npm run seller
```
In a second shell:
```bash
curl -s -i -X POST http://127.0.0.1:8080/api/optimize_allocation -H "content-type: application/json" -d "{}" | head -20
```
Expected: `HTTP/1.1 402`, a `PAYMENT-REQUIRED` header, and a JSON body containing `"accepts"` with `"amount":"500000"`, `"asset":"XRP"`, `"network":"xrpl:1"`. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add src/seller/app.ts src/seller/index.ts tests/seller/app.test.ts
git commit -m "feat: serve MCP and x402-guarded analysis resource"
```

---

### Task 9: Testnet wallet setup script

**Files:**
- Create: `scripts/setup-wallets.ts`, `mandates/treasury-100k.json`

**Interfaces:**
- Produces: `.env` populated with `XRPL_PAY_TO` (seller classic address) and `XRPL_BUYER_SEED`. Prints both addresses and balances.

- [ ] **Step 1: Create mandates/treasury-100k.json**

```json
{
  "asset": "RLUSD",
  "amount": 100000,
  "horizon_hours": 72,
  "minimum_liquidity": 0.5,
  "maximum_risk_score": 30,
  "maximum_protocol_allocation": 0.25
}
```

- [ ] **Step 2: Create scripts/setup-wallets.ts**

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "xrpl";

const wsUrl = process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233";
const envPath = ".env";
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(".env.example", "utf8");

function setVar(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  return new RegExp(`^${key}=`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
}

const client = new Client(wsUrl);
await client.connect();
const { wallet: seller, balance: sellerBalance } = await client.fundWallet();
const { wallet: buyer, balance: buyerBalance } = await client.fundWallet();
await client.disconnect();

let next = setVar(current, "XRPL_PAY_TO", seller.classicAddress);
next = setVar(next, "XRPL_BUYER_SEED", buyer.seed!);
writeFileSync(envPath, next);

console.log(`seller ${seller.classicAddress} balance ${sellerBalance} XRP`);
console.log(`buyer  ${buyer.classicAddress} balance ${buyerBalance} XRP`);
console.log(`wrote ${envPath}`);
```

- [ ] **Step 3: Run it**

Run: `npm run setup:wallets && grep -E "^(XRPL_PAY_TO|XRPL_BUYER_SEED)=" .env | sed 's/SEED=.*/SEED=<redacted>/'`
Expected: two funded addresses printed with balances near 100 XRP (`fundWallet` returns `balance` in XRP). `.env` contains `XRPL_PAY_TO=r...` and `XRPL_BUYER_SEED=s...`.

- [ ] **Step 4: Fill in OPENAI_API_KEY**

Edit `.env` and set `OPENAI_API_KEY=` to the developer's key. Never commit `.env`.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-wallets.ts mandates/treasury-100k.json
git commit -m "chore: add testnet wallet setup and demo mandate"
```

---

### Task 10: Buyer spend policy

**Files:**
- Create: `src/buyer/spendPolicy.ts`
- Test: `tests/buyer/spendPolicy.test.ts`

**Interfaces:**
- Produces:
  - `interface SpendPolicy { maxDropsPerRequest: bigint; maxDropsPerSession: bigint }`
  - `class SpendTracker { constructor(policy: SpendPolicy); readonly spentDrops: bigint; authorize(amountDrops: string): { ok: true } | { ok: false; reason: string }; record(amountDrops: string): void }`
  - `policyFromEnv(env: NodeJS.ProcessEnv): SpendPolicy`

- [ ] **Step 1: Write the failing test**

`tests/buyer/spendPolicy.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SpendTracker, policyFromEnv } from "../../src/buyer/spendPolicy.js";

describe("SpendTracker", () => {
  const policy = { maxDropsPerRequest: 1_000_000n, maxDropsPerSession: 1_500_000n };

  it("authorises within the per-request limit", () => {
    expect(new SpendTracker(policy).authorize("500000")).toEqual({ ok: true });
  });

  it("declines above the per-request limit", () => {
    expect(new SpendTracker(policy).authorize("1000001")).toEqual({ ok: false, reason: "1000001 drops exceeds per-request limit of 1000000 drops" });
  });

  it("declines when the session budget would be exceeded", () => {
    const t = new SpendTracker(policy);
    t.record("1000000");
    expect(t.spentDrops).toBe(1_000_000n);
    expect(t.authorize("600000")).toEqual({ ok: false, reason: "600000 drops would exceed session budget: 1000000 spent of 1500000 drops" });
    expect(t.authorize("500000")).toEqual({ ok: true });
  });

  it("reads the policy from env with defaults", () => {
    expect(policyFromEnv({})).toEqual({ maxDropsPerRequest: 1_000_000n, maxDropsPerSession: 3_000_000n });
    expect(policyFromEnv({ BUYER_MAX_DROPS_PER_REQUEST: "10", BUYER_MAX_DROPS_PER_SESSION: "20" })).toEqual({ maxDropsPerRequest: 10n, maxDropsPerSession: 20n });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/buyer/spendPolicy.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/buyer/spendPolicy.ts**

```ts
export interface SpendPolicy {
  maxDropsPerRequest: bigint;
  maxDropsPerSession: bigint;
}

export class SpendTracker {
  spentDrops = 0n;

  constructor(private readonly policy: SpendPolicy) {}

  authorize(amountDrops: string): { ok: true } | { ok: false; reason: string } {
    const amount = BigInt(amountDrops);
    if (amount > this.policy.maxDropsPerRequest) {
      return { ok: false, reason: `${amount} drops exceeds per-request limit of ${this.policy.maxDropsPerRequest} drops` };
    }
    if (this.spentDrops + amount > this.policy.maxDropsPerSession) {
      return {
        ok: false,
        reason: `${amount} drops would exceed session budget: ${this.spentDrops} spent of ${this.policy.maxDropsPerSession} drops`,
      };
    }
    return { ok: true };
  }

  record(amountDrops: string): void {
    this.spentDrops += BigInt(amountDrops);
  }
}

export function policyFromEnv(env: NodeJS.ProcessEnv): SpendPolicy {
  return {
    maxDropsPerRequest: BigInt(env.BUYER_MAX_DROPS_PER_REQUEST ?? "1000000"),
    maxDropsPerSession: BigInt(env.BUYER_MAX_DROPS_PER_SESSION ?? "3000000"),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/buyer/spendPolicy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/buyer/spendPolicy.ts tests/buyer/spendPolicy.test.ts
git commit -m "feat: add buyer spend policy with per-request and session limits"
```

---

### Task 11: Buyer payment tool

**Files:**
- Create: `src/buyer/pay.ts`
- Test: `tests/buyer/pay.test.ts`

**Interfaces:**
- Consumes: `SpendTracker` from Task 10, `AuditLog` from Task 2, `explorerTxUrl` from Task 1, `x402Purchase` and `defaultPaymentRequirementsSelector` from `x402-xrpl`.
- Produces:
  - `interface PayDeps { wallet: Wallet; network: string; tracker: SpendTracker; audit: AuditLog; purchase?: typeof x402Purchase }`
  - `payForResource(deps: PayDeps, input: { resource: string; body: unknown }): Promise<{ status: "paid"; transaction: string; payer: string; explorer: string; body: unknown } | { status: "declined"; reason: string } | { status: "failed"; reason: string }>`

Behaviour:
1. Build a `paymentRequirementsSelector` that calls `defaultPaymentRequirementsSelector`, then logs `payment_required` and runs `tracker.authorize(amount)`. If declined it throws `SpendDeclined(reason)`.
2. Call `purchase({ url, method: "POST", headers, body, wallet, network, maxValue, paymentRequirementsSelector })`.
3. On `status === "success"`: parse `response.json()`, `tracker.record(amount)`, log `payment_settled`, return `paid`.
4. On `SpendDeclined`: log `payment_declined`, return `declined`.
5. Any other status: log `error`, return `failed` with `reason`.

- [ ] **Step 1: Write the failing test**

`tests/buyer/pay.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { describe, expect, it } from "vitest";
import { payForResource } from "../../src/buyer/pay.js";
import { SpendTracker } from "../../src/buyer/spendPolicy.js";
import { AuditLog, readRun } from "../../src/shared/audit.js";

const wallet = Wallet.generate();
const accepts = [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "500000", payTo: "rSeller", maxTimeoutSeconds: 600, extra: { invoiceId: "INV-1" } }];

function setup(maxPerRequest = 1_000_000n) {
  const dir = mkdtempSync(join(tmpdir(), "pay-"));
  const audit = new AuditLog(dir, "run");
  const tracker = new SpendTracker({ maxDropsPerRequest: maxPerRequest, maxDropsPerSession: 3_000_000n });
  return { dir, audit, tracker };
}

describe("payForResource", () => {
  it("pays, records settlement and returns the resource body", async () => {
    const { dir, audit, tracker } = setup();
    const purchase = (async (opts: any) => {
      const selected = opts.paymentRequirementsSelector(accepts, "xrpl:1", "exact", opts.maxValue);
      expect(selected.amount).toBe("500000");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ amount: 1 });
      return { status: "success", transaction: "TXHASH", payer: wallet.classicAddress, network: "xrpl:1", response: new Response(JSON.stringify({ recommendation: "ok" })) };
    }) as any;

    const out = await payForResource({ wallet, network: "xrpl:1", tracker, audit, purchase }, { resource: "http://s/api/x", body: { amount: 1 } });
    expect(out).toEqual({ status: "paid", transaction: "TXHASH", payer: wallet.classicAddress, explorer: "https://testnet.xrpl.org/transactions/TXHASH", body: { recommendation: "ok" } });
    expect(tracker.spentDrops).toBe(500_000n);
    expect(readRun(dir, "run").map((r) => r.event.type)).toEqual(["payment_required", "payment_settled"]);
  });

  it("declines before signing when the policy is exceeded", async () => {
    const { dir, audit, tracker } = setup(100n);
    const purchase = (async (opts: any) => {
      opts.paymentRequirementsSelector(accepts, "xrpl:1", "exact", opts.maxValue);
      throw new Error("selector should have thrown first");
    }) as any;

    const out = await payForResource({ wallet, network: "xrpl:1", tracker, audit, purchase }, { resource: "http://s/api/x", body: {} });
    expect(out).toEqual({ status: "declined", reason: "500000 drops exceeds per-request limit of 100 drops" });
    expect(tracker.spentDrops).toBe(0n);
    expect(readRun(dir, "run").map((r) => r.event.type)).toEqual(["payment_required", "payment_declined"]);
  });

  it("reports facilitator failures", async () => {
    const { dir, audit, tracker } = setup();
    const purchase = (async () => ({ status: "failed", reason: "settle rejected" })) as any;
    const out = await payForResource({ wallet, network: "xrpl:1", tracker, audit, purchase }, { resource: "http://s/api/x", body: {} });
    expect(out).toEqual({ status: "failed", reason: "settle rejected" });
    expect(readRun(dir, "run").at(-1)?.event.type).toBe("error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/buyer/pay.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/buyer/pay.ts**

```ts
import type { Wallet } from "xrpl";
import { defaultPaymentRequirementsSelector, x402Purchase } from "x402-xrpl";
import type { AuditLog } from "../shared/audit.js";
import { explorerTxUrl } from "../shared/types.js";
import type { SpendTracker } from "./spendPolicy.js";

export interface PayDeps {
  wallet: Wallet;
  network: string;
  tracker: SpendTracker;
  audit: AuditLog;
  purchase?: typeof x402Purchase;
}

export type PayOutcome =
  | { status: "paid"; transaction: string; payer: string; explorer: string; body: unknown }
  | { status: "declined"; reason: string }
  | { status: "failed"; reason: string };

class SpendDeclined extends Error {}

export async function payForResource(deps: PayDeps, input: { resource: string; body: unknown }): Promise<PayOutcome> {
  const purchase = deps.purchase ?? x402Purchase;
  let amountDrops = "0";

  const paymentRequirementsSelector: typeof defaultPaymentRequirementsSelector = (accepts, networkFilter, schemeFilter, maxValue) => {
    const selected = defaultPaymentRequirementsSelector(accepts, networkFilter, schemeFilter, maxValue);
    amountDrops = String(selected.amount);
    deps.audit.append({
      type: "payment_required",
      resource: input.resource,
      amountDrops,
      asset: String(selected.asset),
      network: String(selected.network),
      payTo: String(selected.payTo),
    });
    const verdict = deps.tracker.authorize(amountDrops);
    if (!verdict.ok) throw new SpendDeclined(verdict.reason);
    return selected;
  };

  try {
    const result = await purchase({
      url: input.resource,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input.body),
      wallet: deps.wallet,
      network: deps.network as "xrpl:1" | "xrpl:0",
      paymentRequirementsSelector,
    });
    if (result.status !== "success" || !result.response || !result.transaction) {
      deps.audit.append({ type: "error", message: `payment ${result.status}: ${result.reason ?? "unknown"}` });
      return { status: "failed", reason: result.reason ?? result.status };
    }
    deps.tracker.record(amountDrops);
    const explorer = explorerTxUrl(result.transaction);
    deps.audit.append({
      type: "payment_settled",
      transaction: result.transaction,
      payer: result.payer ?? deps.wallet.classicAddress,
      amountDrops,
      network: result.network ?? deps.network,
      explorer,
    });
    return { status: "paid", transaction: result.transaction, payer: result.payer ?? deps.wallet.classicAddress, explorer, body: await result.response.json() };
  } catch (err) {
    if (err instanceof SpendDeclined) {
      deps.audit.append({ type: "payment_declined", resource: input.resource, reason: err.message });
      return { status: "declined", reason: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.audit.append({ type: "error", message });
    return { status: "failed", reason: message };
  }
}
```

The tracker enforces both limits inside the selector before any transaction is signed, so `maxValue` is not passed.

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/buyer/pay.test.ts && npm run typecheck`
Expected: PASS (3 tests). If typecheck complains that `network` must be `XRPLNetworkId`, import the type: `import type { XRPLNetworkId } from "x402-xrpl";` and cast `deps.network as XRPLNetworkId`.

- [ ] **Step 5: Commit**

```bash
git add src/buyer/pay.ts tests/buyer/pay.test.ts
git commit -m "feat: pay for x402 resources under the buyer spend policy"
```

---

### Task 12: Buyer MCP client adapter

**Files:**
- Create: `src/buyer/mcpClient.ts`
- Test: `tests/buyer/mcpClient.test.ts`

**Interfaces:**
- Consumes: `buildSellerApp` from Task 8 (for the test), MCP `Client`.
- Produces:
  - `interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }`
  - `interface McpBridge { listTools(): Promise<McpTool[]>; callTool(name: string, args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }`
  - `connectMcp(url: string): Promise<McpBridge>` (Streamable HTTP)
  - `mcpToolsToOpenAiTools(tools: McpTool[]): OpenAI.Responses.FunctionTool[]` with `strict: false`
  - `callTool` returns the parsed JSON of the first text content block, or the raw text when it is not JSON. It throws when `isError` is true.

- [ ] **Step 1: Write the failing test**

`tests/buyer/mcpClient.test.ts`:
```ts
import type { RequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, mcpToolsToOpenAiTools } from "../../src/buyer/mcpClient.js";
import { buildSellerApp } from "../../src/seller/app.js";

const passThrough: RequestHandler = (_req, _res, next) => next();
const engine = {
  listOpportunities: async () => [{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 1, tradingFeeBps: 2 }],
  runAnalysis: async () => {
    throw new Error("unused");
  },
};

let server: any;
let url = "";

beforeAll(async () => {
  const app = buildSellerApp({ payTo: "rS", network: "xrpl:1", facilitatorUrl: "", priceDrops: "500000", baseUrl: "http://x" }, engine, { paymentGuard: passThrough });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});

afterAll(() => server.close());

describe("mcp bridge", () => {
  it("lists tools and converts them to OpenAI function tools", async () => {
    const bridge = await connectMcp(url);
    const tools = await bridge.listTools();
    const fnTools = mcpToolsToOpenAiTools(tools);
    expect(fnTools.map((t) => t.name).sort()).toEqual(["list_opportunities", "optimize_allocation"]);
    const paid = fnTools.find((t) => t.name === "optimize_allocation")!;
    expect(paid.type).toBe("function");
    expect(paid.strict).toBe(false);
    expect((paid.parameters as any).properties.amount.type).toBe("number");
    await bridge.close();
  });

  it("calls a tool and parses JSON text", async () => {
    const bridge = await connectMcp(url);
    expect(await bridge.callTool("list_opportunities", {})).toEqual([{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 1, tradingFeeBps: 2 }]);
    const env: any = await bridge.callTool("optimize_allocation", { asset: "RLUSD", amount: 1, horizon_hours: 1, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 });
    expect(env.status).toBe("payment_required");
    expect(env.resource).toBe("http://x/api/optimize_allocation");
    await bridge.close();
  });

  it("throws on tool errors", async () => {
    const bridge = await connectMcp(url);
    await expect(bridge.callTool("optimize_allocation", { asset: "RLUSD" })).rejects.toThrow();
    await bridge.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/buyer/mcpClient.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/buyer/mcpClient.ts**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type OpenAI from "openai";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpBridge {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export async function connectMcp(url: string): Promise<McpBridge> {
  const client = new Client({ name: "xrpl-treasury-buyer", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
    },
    async callTool(name, args) {
      const result: any = await client.callTool({ name, arguments: args });
      const text = result.content?.find((c: any) => c.type === "text")?.text ?? "";
      if (result.isError) throw new Error(`MCP tool ${name} failed: ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}

export function mcpToolsToOpenAiTools(tools: McpTool[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema,
    strict: false,
  }));
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/buyer/mcpClient.test.ts && npm run typecheck`
Expected: PASS (3 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/buyer/mcpClient.ts tests/buyer/mcpClient.test.ts
git commit -m "feat: bridge MCP tool discovery into OpenAI function tools"
```

---

### Task 13: Buyer agent loop

**Files:**
- Create: `src/buyer/agent.ts`
- Test: `tests/buyer/agent.test.ts`

**Interfaces:**
- Consumes: `McpBridge`, `mcpToolsToOpenAiTools` from Task 12; `PayOutcome` from Task 11; `AuditLog` from Task 2; `Mandate` from Task 1.
- Produces:
  - `interface AgentDeps { responses: { create(params: OpenAI.Responses.ResponseCreateParamsNonStreaming): Promise<OpenAI.Responses.Response> }; model: string; mcp: McpBridge; pay(input: { resource: string; body: unknown }): Promise<PayOutcome>; audit: AuditLog; maxTurns?: number; log?: (line: string) => void }`
  - `runAgentLoop(deps: AgentDeps, mandate: Mandate): Promise<{ action: string; rationale: string }>`
  - `SYSTEM_INSTRUCTIONS(mandate: Mandate, spendSummary: string): string`

Local tools presented alongside the MCP tools:
- `pay_for_resource` `{ resource: string; body: object }` strict
- `record_decision` `{ action: string; rationale: string }` strict, ends the loop

Loop: build tools from `mcp.listTools()` (log `discovery`), seed `input` with the mandate as a user message, then up to `maxTurns` (default 8): call `responses.create`, push `response.output` into `input`, handle every `function_call` item (log `tool_call`, run it, log `tool_result`, push `function_call_output`). When `record_decision` runs, log `decision` and return. If the loop ends without a decision, log `error` and return `{ action: "no_decision", rationale: "turn limit reached" }`.

- [ ] **Step 1: Write the failing test**

`tests/buyer/agent.test.ts`:
```ts
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
  return {
    seenInputs,
    responses: {
      create: async (params: any) => {
        seenInputs.push(params.input);
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/buyer/agent.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/buyer/agent.ts**

```ts
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
      instructions: SYSTEM_INSTRUCTIONS(mandate, "see pay_for_resource; limits are enforced by the wallet"),
      input,
      tools,
      reasoning: { effort: "low" },
    });
    input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));

    const calls = response.output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call");
    if (calls.length === 0 && response.output_text) log(`model: ${response.output_text}`);

    for (const call of calls) {
      const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      deps.audit.append({ type: "tool_call", name: call.name, args });
      log(`tool_call ${call.name} ${JSON.stringify(args)}`);

      if (call.name === "record_decision") {
        const decision = { action: String(args.action), rationale: String(args.rationale) };
        deps.audit.append({ type: "decision", ...decision });
        log(`decision: ${decision.action}`);
        return decision;
      }

      let result: unknown;
      if (call.name === "pay_for_resource") {
        const outcome = await deps.pay({ resource: String(args.resource), body: args.body });
        if (outcome.status === "paid") deps.audit.append({ type: "result", result: outcome.body as AllocationResult });
        result = outcome;
      } else if (mcpNames.has(call.name)) {
        result = await deps.mcp.callTool(call.name, args);
      } else {
        result = { error: `unknown tool ${call.name}` };
      }

      deps.audit.append({ type: "tool_result", name: call.name, result });
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  deps.audit.append({ type: "error", message: `no decision after ${maxTurns} turns` });
  return { action: "no_decision", rationale: "turn limit reached" };
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run tests/buyer/agent.test.ts && npm run typecheck`
Expected: PASS (2 tests). If typecheck rejects pushing `response.output` into `ResponseInput`, keep the cast as written; the SDK documents resubmitting output items as input.

- [ ] **Step 5: Commit**

```bash
git add src/buyer/agent.ts tests/buyer/agent.test.ts
git commit -m "feat: run buyer agent loop over MCP tools with x402 payment"
```

---

### Task 14: Buyer entry point and live end-to-end run

**Files:**
- Create: `src/buyer/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 10 to 13, `AuditLog`, `explorerTxUrl`.
- Produces: `npm run buyer` prints the run id, discovery, each tool call, the payment tx hash with explorer link, the allocation, and the decision. Exit code 0 on a recorded decision, 1 otherwise.

- [ ] **Step 1: Create src/buyer/index.ts**

```ts
import "dotenv/config";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { Wallet } from "xrpl";
import { AuditLog } from "../shared/audit.js";
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
  },
  mandate,
);
await mcp.close();

console.log("");
console.log(`decision: ${decision.action}`);
console.log(`rationale: ${decision.rationale}`);
console.log(`spent ${tracker.spentDrops} drops`);
console.log(`audit ${audit.path}`);
process.exitCode = decision.action === "no_decision" ? 1 : 0;
```

- [ ] **Step 2: Add tx hash printing**

In `src/buyer/index.ts`, after the `pay:` line's `payForResource` call resolves, the settlement is already in the audit log. Print it at the end by reading the audit file: add after `await mcp.close();`

```ts
import { readRun } from "../shared/audit.js";
```
(merge into the existing audit import: `import { AuditLog, readRun } from "../shared/audit.js";`) and after `console.log(`spent ...`)`:
```ts
for (const r of readRun("runs", audit.runId)) {
  if (r.event.type === "payment_settled") console.log(`payment ${r.event.transaction} ${r.event.explorer}`);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Live end-to-end run**

Shell 1: `npm run seller` (needs `.env` from Task 9). Wait for `seller listening`.
Shell 2: `npm run buyer`

Expected output, in order:
1. `run <id>` and the buyer wallet address.
2. `discovered MCP tools: list_opportunities, optimize_allocation`.
3. One or more `tool_call list_opportunities` and `tool_call optimize_allocation` lines.
4. `tool_call pay_for_resource ...`.
5. `decision: ...` referencing an allocation or hold.
6. `payment <64-hex hash> https://testnet.xrpl.org/transactions/<hash>`.
7. Exit code 0.

Verify the hash: open the explorer link. The transaction must be a `Payment` of `0.5 XRP` from the buyer address to `XRPL_PAY_TO` with `SourceTag 804681468`.

If step 4 fails with a facilitator error, run `curl -s https://xrpl-facilitator-testnet.t54.ai/supported` to confirm it lists `xrpl:1` / `exact`, and confirm both wallets still hold XRP with `curl -s -X POST https://s.altnet.rippletest.net:51234/ -H "content-type: application/json" -d '{"method":"account_info","params":[{"account":"<addr>"}]}'`.

- [ ] **Step 5: Record the evidence**

Copy the run's tx hash and the audit file name into a scratch note for Task 16's README.

- [ ] **Step 6: Commit**

```bash
git add src/buyer/index.ts
git commit -m "feat: add buyer CLI that runs the full commercial loop"
```

---

### Task 15: Dashboard event log

**Files:**
- Create: `src/dashboard/index.ts`, `src/dashboard/public/index.html`
- Test: `tests/dashboard/api.test.ts`

**Interfaces:**
- Consumes: `listRuns`, `readRun` from Task 2.
- Produces: `buildDashboardApp(runsDir: string): Express` with `GET /api/runs` → `{ runs: string[] }`, `GET /api/runs/:id` → `{ records: AuditRecord[] }`, static `/` from `public/`.

- [ ] **Step 1: Write the failing test**

`tests/dashboard/api.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDashboardApp } from "../../src/dashboard/index.js";
import { AuditLog } from "../../src/shared/audit.js";

let server: any;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "dash-"));

beforeAll(async () => {
  new AuditLog(dir, "r1").append({ type: "discovery", tools: ["a"] });
  await new Promise<void>((resolve) => {
    server = buildDashboardApp(dir).listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

describe("dashboard api", () => {
  it("lists runs", async () => {
    expect(await (await fetch(`${base}/api/runs`)).json()).toEqual({ runs: ["r1"] });
  });
  it("returns records for a run", async () => {
    const body = await (await fetch(`${base}/api/runs/r1`)).json();
    expect(body.records[0].event).toEqual({ type: "discovery", tools: ["a"] });
  });
  it("serves the page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("XRPL Financial Intelligence");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard/api.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create src/dashboard/index.ts**

```ts
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import express, { type Express } from "express";
import { listRuns, readRun } from "../shared/audit.js";

export function buildDashboardApp(runsDir: string): Express {
  const app = express();
  app.get("/api/runs", (_req, res) => {
    res.json({ runs: listRuns(runsDir) });
  });
  app.get("/api/runs/:id", (req, res) => {
    res.json({ records: readRun(runsDir, String(req.params.id)) });
  });
  app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "public")));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DASHBOARD_PORT ?? "8090");
  buildDashboardApp("runs").listen(port, "127.0.0.1", () => {
    console.log(`dashboard on http://127.0.0.1:${port}`);
  });
}
```

- [ ] **Step 4: Create src/dashboard/public/index.html**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>XRPL Financial Intelligence — Agent Audit Trail</title>
<style>
  :root { --bg:#0f1115; --card:#181b22; --ink:#e6e8ee; --dim:#8a90a2; --ok:#3ddc97; --warn:#ffb454; --bad:#ff6b6b; --pay:#7aa2ff; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
  header { padding:20px 28px; border-bottom:1px solid #262a35; display:flex; gap:16px; align-items:baseline; }
  header h1 { margin:0; font-size:18px; }
  header select { background:var(--card); color:var(--ink); border:1px solid #2c3140; padding:6px 10px; border-radius:6px; }
  main { max-width:960px; margin:0 auto; padding:24px 28px; }
  .ev { background:var(--card); border-left:4px solid var(--dim); border-radius:8px; padding:12px 16px; margin:10px 0; }
  .ev.payment_settled { border-color:var(--pay); }
  .ev.payment_required { border-color:var(--warn); }
  .ev.payment_declined, .ev.error { border-color:var(--bad); }
  .ev.decision, .ev.result { border-color:var(--ok); }
  .t { color:var(--dim); font-size:12px; }
  .k { font-weight:600; text-transform:uppercase; letter-spacing:.04em; font-size:12px; }
  pre { margin:8px 0 0; white-space:pre-wrap; word-break:break-word; font-size:12px; color:#c9cede; }
  a { color:var(--pay); }
  table { border-collapse:collapse; margin-top:8px; }
  td, th { padding:4px 10px 4px 0; text-align:left; }
</style>
</head>
<body>
<header><h1>XRPL Financial Intelligence</h1><span class="t">agent → MCP → x402 → XRPL → decision</span><select id="runs"></select></header>
<main id="timeline"></main>
<script>
const runsEl = document.getElementById("runs");
const timeline = document.getElementById("timeline");
let current = null;

function fmtAlloc(r) {
  const rows = r.allocations.map(a => `<tr><td>${a.pairLabel}</td><td>${(a.weight*100).toFixed(0)}%</td><td>${a.amount.toLocaleString()} RLUSD</td><td>${(a.feeApy*100).toFixed(2)}%</td><td>${a.riskScore}</td><td>${a.liquidityScore}</td></tr>`).join("");
  return `<table><tr><th>Pool</th><th>Weight</th><th>Amount</th><th>Fee APY</th><th>Risk</th><th>Liquidity</th></tr>${rows}<tr><td>Liquid</td><td>${(r.liquid_reserve.weight*100).toFixed(0)}%</td><td>${r.liquid_reserve.amount.toLocaleString()} RLUSD</td><td></td><td></td><td></td></tr></table>
  <pre>expected APY ${(r.expected_apy*100).toFixed(2)}% · portfolio risk ${r.portfolio_risk_score.toFixed(1)} · ledger ${r.data.ledger_index} · valid until ${r.valid_until}\n${r.reasoning}</pre>`;
}

function render(records) {
  timeline.innerHTML = records.map(({ seq, ts, event }) => {
    let body = "";
    if (event.type === "payment_settled") body = `<pre>tx <a href="${event.explorer}" target="_blank">${event.transaction}</a>\npayer ${event.payer} · ${event.amountDrops} drops · ${event.network}</pre>`;
    else if (event.type === "result") body = fmtAlloc(event.result);
    else if (event.type === "decision") body = `<pre>${event.action}\n\n${event.rationale}</pre>`;
    else { const { type, ...rest } = event; body = `<pre>${JSON.stringify(rest, null, 1)}</pre>`; }
    return `<div class="ev ${event.type}"><span class="k">${seq}. ${event.type}</span> <span class="t">${ts}</span>${body}</div>`;
  }).join("");
}

async function loadRuns() {
  const { runs } = await (await fetch("/api/runs")).json();
  const prev = runsEl.value;
  runsEl.innerHTML = runs.map(r => `<option value="${r}">${r}</option>`).join("");
  runsEl.value = runs.includes(prev) ? prev : (runs[0] || "");
  if (runsEl.value !== current) { current = runsEl.value; await loadRun(); }
}
async function loadRun() {
  if (!runsEl.value) { timeline.innerHTML = "<p class='t'>No runs yet. Start the seller and run the buyer.</p>"; return; }
  current = runsEl.value;
  const { records } = await (await fetch(`/api/runs/${runsEl.value}`)).json();
  render(records);
}
runsEl.addEventListener("change", loadRun);
loadRuns();
setInterval(async () => { await loadRuns(); if (current) await loadRun(); }, 2000);
</script>
</body>
</html>
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/dashboard/api.test.ts && npm run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 6: Manual check**

Run: `npm run dashboard`, open `http://127.0.0.1:8090`. Select the run from Task 14. Expect the timeline to show mandate, discovery, tool calls, `payment_required`, `payment_settled` with a clickable explorer link, the allocation table, and the decision.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/index.ts src/dashboard/public/index.html tests/dashboard/api.test.ts
git commit -m "feat: add audit-trail dashboard for agent runs"
```

---

### Task 16: README and submission evidence

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

Contents, in this order, each as its own section:

1. **One-sentence pitch** copied from spec §24.
2. **Commercial loop** diagram copied from spec §20 (the "Developer Mental Model" block).
3. **Architecture**: the File Structure block from this plan plus three sentences on seller, buyer, dashboard.
4. **How MCP and x402 divide the work**: MCP = discovery and contract (`list_opportunities` free, `optimize_allocation` returns `payment_required`); x402 = payment for `POST /api/optimize_allocation`, settled by the t54 testnet facilitator; the buyer's wallet enforces the spend policy inside the requirement selector before signing.
5. **Intelligence model**: the risk rules, liquidity formula, fee-APY formula, and optimizer from Tasks 3 and 4, marked as an MVP heuristic. State the limitation that LP positions carry XRP price exposure that the score does not model.
6. **Run it**:
   ```bash
   npm install
   npm run setup:wallets      # funds two testnet wallets, writes .env
   # set OPENAI_API_KEY in .env
   npm run seller             # shell 1
   npm run dashboard          # shell 2, http://127.0.0.1:8090
   npm run buyer              # shell 3
   npm test
   ```
7. **Evidence**: the tx hash and explorer link from Task 14, the run id, the buyer and seller addresses.
8. **Trust and safety**: spend limits, no custody, recommend-only, audit trail path, testnet only.
9. **Hackathon feedback hook**: one line noting `.claude/settings.json` and `hook/` are the required XRPL feedback hook and must stay.
10. **Not built**: bullets from spec §15.

- [ ] **Step 2: Verify the run instructions from a clean clone**

Run, in a scratch directory outside the repo:
```bash
git clone <repo-url> verify && cd verify && npm install && npm test && npm run typecheck
```
Expected: all tests pass, typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe architecture, model, run steps and evidence"
```

---

## Self-Review

**Spec coverage (spec §21 P0):**
1. Buyer agent → Tasks 10–14.
2. MCP server → Task 7.
3. Meaningful financial-intelligence tool → Tasks 3–6 (`optimize_allocation`).
4. x402 payment flow → Tasks 8, 11.
5. Real XRPL transaction → Task 14 step 4.
6. Structured result → `AllocationResult`, Tasks 1, 4.
7. Buyer consumes result → Task 13 (`record_decision` after `pay_for_resource`).
8. Transaction hash visible → Task 14 step 2, Task 15 explorer link, Task 16 README.
9. Reproducible demo → Task 9 wallets, Task 16 clean-clone check.

**Spec §21 P1 covered:** multiple tools (2), risk parameters (mandate), portfolio optimization (Task 4), live XRPL data (Task 5), spending limits (Task 10), audit history (Task 2), UI (Task 15). Not covered: `assess_risk` and `evaluate_liquidity` as separate paid tools (spec §12); their metrics ship inside `optimize_allocation`. Adding them later is a new `registerTool` plus a guarded route each.

**Placeholder scan:** no TBD/TODO. Every code step shows the complete file contents.

**Type consistency:** `SellerConfig`, `SellerEngine`, `MANDATE_SHAPE`, `OPTIMIZE_PATH`, `OPTIMIZE_DESCRIPTION` defined in Task 7 and used in Task 8. `McpBridge`, `mcpToolsToOpenAiTools` from Task 12 used in Task 13. `PayOutcome` from Task 11 used in Task 13. `SpendTracker.authorize` returns `{ ok: true } | { ok: false; reason }` consistently across Tasks 10 and 11. `AuditEvent` union in Task 1 covers every `audit.append` call in Tasks 11, 13. `Opportunity.tradingFeeBps = tradingFee / 10` in Task 6 matches the Task 6 test (`200 → 20`).
