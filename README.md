# XRPL Financial Intelligence

XRPL Financial Intelligence is an MCP-accessible, x402-monetized financial intelligence service that allows autonomous agents to purchase specialized XRPL market, risk, liquidity and allocation analysis and use the results in their own economic decisions.

## Commercial Loop

```text
                    ┌──────────────┐
                    │  BUYER AGENT │
                    └──────┬───────┘
                           │
                    "I need a decision"
                           │
                           ▼
                    ┌──────────────┐
                    │     MCP      │
                    │  Discovery   │
                    └──────┬───────┘
                           │
                    "Call this tool"
                           │
                           ▼
                    ┌──────────────┐
                    │   x402       │
                    │   Payment    │
                    └──────┬───────┘
                           │
                      XRPL payment
                           │
                           ▼
                ┌────────────────────┐
                │ Financial          │
                │ Intelligence       │
                │ Engine             │
                └─────────┬──────────┘
                          │
                   Structured result
                          │
                          ▼
                    ┌──────────────┐
                    │  BUYER AGENT │
                    │  acts on it  │
                    └──────────────┘
```

## Architecture

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

The **seller** is an Express server exposing a stateless MCP endpoint at `/mcp` (discovery and a paid tool) plus an x402-guarded REST resource at `/api/optimize_allocation` that runs the intelligence engine. The **buyer** is a GPT-5.6 Sol tool-use loop whose tool list is built dynamically from MCP `listTools`, plus two local tools: `pay_for_resource` (x402 purchase under a spend policy) and `record_decision`. The **dashboard** serves an audit trail of every run written as JSONL.

## How MCP and x402 Divide the Work

**MCP** (Model Context Protocol) handles discovery and contract. The `list_opportunities` tool is free and returns a list of XRPL AMM pools with depth and fee only; no scores, no recommendation. The `optimize_allocation` tool returns a `payment_required` envelope indicating the cost.

**x402** (HTTP 402 Payment Required) handles payment. When the buyer agent calls `optimize_allocation`, it receives a payment-required envelope. The agent evaluates whether the analysis is worth the price. If yes, it calls the local `pay_for_resource` tool, which executes an x402 purchase with the buyer's wallet. The buyer's wallet enforces the spend policy inside the x402 requirement selector before signing: declines are logged as `payment_declined`.

The payment is settled by the t54 testnet facilitator on network `xrpl:1`. Once settlement confirms, the buyer receives the analysis via the REST response body at `POST /api/optimize_allocation`.

## Intelligence Model

The MVP heuristic evaluates XRPL AMM opportunities and produces a risk-adjusted allocation recommendation. This model is not a validated risk framework and is appropriate for a hackathon demo only.

**Risk Score** (0–100 scale, lower is better):
- Start at 20.
- If the asset issuer is in the RLUSD allowlist (rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De): +0. Else if the issuer is xrpscan-verified: +20. Else: +40.
- If TVL is below 50,000 XRP: +25. Else if below 250,000 XRP: +10.
- If trading fee exceeds 500 basis points (0.5%): +10.
- If the asset is frozen: +30.
- Clamp to 0–100.

**Liquidity Score** (0–100 scale, higher is better):
- `share = deployXrp / tvlXrp`.
- `score = round(100 * (1 - min(1, share * 5)))`.
- Deploying 20% of a pool scores 0; deploying 5% scores 75.

**Fee APY**:
- `feeApy = volumeXrpPerDay * (tradingFee / 100000) * 365 / tvlXrp`.
- Volume is estimated from absolute XRP balance changes on the AMM account over the sampled span (up to 200 recent transactions).

**Risk-Adjusted Score**:
- `riskAdjustedScore = feeApy * (1 - risk / 100)`.

**Allocation Algorithm**:
1. Reserve = `amount * minimum_liquidity`. Deployable = `amount - reserve`.
2. Eligible pools: `riskScore <= mandate.maximum_risk_score`, `liquidityScore >= 50`, `!frozen`, `feeApy > 0`. Sort by risk-adjusted score descending.
3. For each eligible pool while deployable > 0: allocate `min(amount * maximum_protocol_allocation, deployable)`. Subtract from deployable.
4. Leftover deployable capital joins the liquid reserve.
5. Expected APY is the weight-average of pool fees. Portfolio risk and liquidity are weighted over deployed lines only.
6. Recommendation is the `pairLabel` of the first allocated pool, or `"hold_liquid"` if none qualify.
7. Valid for 1 hour.

**Limitation**: LP positions on AMM pools carry XRP price exposure that this model does not account for. Holding RLUSD liquidity and deploying to XRP/RLUSD creates basis risk if XRP appreciates or depreciates significantly. Agents must incorporate XRP price forecasts separately.

## Run It

Live mainnet data is read-only via xrpscan pool discovery and mainnet JSON-RPC calls. Testnet wallets and x402 payment flow operate on XRPL testnet.

```bash
npm install
npm run setup:wallets      # funds two testnet wallets, writes .env
# set OPENAI_API_KEY in .env
npm run seller             # shell 1
npm run dashboard          # shell 2, http://127.0.0.1:8090
npm run buyer              # shell 3
npm test
```

1. `npm install`: Install dependencies.
2. `npm run setup:wallets`: Funds a seller wallet and a buyer wallet with 100 XRP each from the testnet faucet, writes `XRPL_PAY_TO` and `XRPL_BUYER_SEED` to `.env`.
3. Set `OPENAI_API_KEY` in `.env` (required for the buyer agent).
4. `npm run seller` (shell 1): Start the MCP server and x402-guarded API on `http://127.0.0.1:8080`.
5. `npm run dashboard` (shell 2): Start the audit-trail dashboard on `http://127.0.0.1:8090`.
6. `npm run buyer` (shell 3): Run the buyer agent against the mandate in `mandates/treasury-100k.json`. The agent discovers tools via MCP, decides whether to pay, executes an x402 transaction if approved, receives the analysis, and records a decision.
7. `npm test`: Run all 53 tests across 14 test files. All tests pass; typecheck is clean.

## Evidence

**Seller wallet (payment recipient)**: `rhWLqJ2mpNNBmFe5TSDQKEBXKiPKdZkPaR` (funded 100 XRP on 2026-09-05)

**Buyer wallet (payment sender)**: `rU6pvGTCWxihsb6sHnCkBfch64C6cxLxC6` (funded 100 XRP on 2026-09-05)

**Service pricing**: `optimize_allocation` costs 500,000 drops (0.5 XRP)

**Live end-to-end run**: Pending: run `npm run buyer` with `OPENAI_API_KEY` set, then paste the `payment <hash> <explorer>` line printed by the buyer.

## Trust and Safety

The buyer agent enforces strict spending limits inside its wallet:
- Maximum 1,000,000 drops (1 XRP) per request.
- Maximum 3,000,000 drops (3 XRP) per run.
- Above these limits, payments are declined and logged as `payment_declined`.

The service never takes custody of buyer funds. The buyer only recommends an allocation; it does not execute RLUSD transfers or AMM deposits. A human operator or downstream automation must execute trades based on the recommendation.

Every run produces a JSONL audit trail at `runs/<runId>.jsonl`, one JSON record per line with `runId`, `seq`, `ts`, `event`. Each event records the mandate, discovered tools, tool calls, payment requirements, transaction hashes, analysis results, and final decisions. The dashboard at `http://127.0.0.1:8090` renders the audit trail for review.

The service operates on XRPL testnet only. Mainnet data is read-only; no transactions are submitted to mainnet.

## Hackathon Feedback Hook

`.claude/settings.json` and `hook/` contain the XRPL feedback hook required by the Singhacks 2026 hackathon. These must remain in the repository.

## Not Built

- A full DeFi protocol. We do not operate our own lending market, DEX, or yield protocol.
- A custodial asset manager. We do not take custody of customer funds.
- A generic AI chatbot. Conversational interface is secondary.
- A generic yield aggregator. We do not reproduce a dashboard showing APYs.
- A retail investment application. The primary interface is machine-to-machine.
- An AI that autonomously invests unlimited money. Agent autonomy is constrained by spend policies.
- A claim that autonomous XRPL treasury agents already dominate the market. This hackathon prototype demonstrates the infrastructure and business primitive for a future agent economy.
