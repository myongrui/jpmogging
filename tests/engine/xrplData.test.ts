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
