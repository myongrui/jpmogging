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
