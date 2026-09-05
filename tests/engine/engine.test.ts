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

  it("falls back to the deepest pool when the RLUSD reference is absent", async () => {
    const noRlusd = (async () => new Response(JSON.stringify([rows[1]]))) as typeof fetch;
    const r = await runAnalysis({ rpc, fetchImpl: noRlusd }, mandate);
    expect(r.data.rlusd_per_xrp).toBeCloseTo(1.4, 10);
    expect(r.opportunities_considered).toBe(1);
  });

  it("emits an execution plan alongside the analysis", async () => {
    const now = () => new Date("2026-09-04T12:00:00.000Z");
    const amendments = { known: true, enabled: new Set(["AMM"]) };
    const r = await runAnalysis({ rpc, fetchImpl, now, network: "xrpl:0", amendments }, mandate);
    const plan = r.plan!;
    expect(plan.network).toBe("xrpl:0");
    expect(plan.totals.deployed).toBe(25000);
    expect(plan.totals.reserve).toBe(75000);
    expect(plan.legs.map((l) => l.tx.TransactionType)).toEqual(["TrustSet", "AMMDeposit"]);
    expect(plan.legs.every((l) => !("Account" in l.tx))).toBe(true);
  });

  it("omits legs for venues the network cannot execute", async () => {
    const amendments = { known: true, enabled: new Set<string>() };
    const r = await runAnalysis({ rpc, fetchImpl, network: "xrpl:0", amendments }, mandate);
    expect(r.plan!.legs).toHaveLength(0);
    expect(r.plan!.totals.deployed).toBe(0);
  });
});
