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

interface AmmLedgerEntry {
  Account: string;
  Asset: { currency: string; issuer?: string };
  Asset2: { currency: string; issuer?: string };
  TradingFee?: number;
}

/**
 * Enumerates AMMs straight off the ledger. Networks without an indexer (testnet,
 * devnet) have no xrpscan equivalent, so this pages `ledger_data` filtered to AMM
 * entries. Paging is bounded because a full ledger scan is expensive.
 */
export async function discoverPoolsFromLedger(
  rpc: XrplRpc,
  opts: { minXrpSide?: number; limit?: number; maxPages?: number; pageSize?: number } = {},
): Promise<PoolSnapshot[]> {
  const minXrpSide = opts.minXrpSide ?? 10;
  const limit = opts.limit ?? 12;
  const maxPages = opts.maxPages ?? 25;
  const pageSize = opts.pageSize ?? 2000;

  const entries: AmmLedgerEntry[] = [];
  let marker: unknown = undefined;
  for (let page = 0; page < maxPages; page++) {
    const req: Record<string, unknown> = { command: "ledger_data", ledger_index: "validated", type: "amm", limit: pageSize, binary: false };
    if (marker !== undefined) req.marker = marker;
    const { result } = await rpc.request(req);
    entries.push(...((result.state ?? []) as AmmLedgerEntry[]));
    marker = result.marker;
    if (marker === undefined) break;
  }

  const xrpPaired = entries.filter((e) => e.Asset.currency === "XRP" && e.Asset2.currency !== "XRP");
  const snapshots: PoolSnapshot[] = [];
  // Already sequential: one amm_info per AMM, in order, to stay inside node limits.
  for (const e of xrpPaired) {
    try {
      const { result } = await rpc.request({ command: "amm_info", amm_account: e.Account, ledger_index: "validated" });
      const amm = result.amm;
      const drops = String(amm.amount);
      if (Number(drops) / 1_000_000 < minXrpSide) continue;
      snapshots.push({
        ammAccount: e.Account,
        pairLabel: `XRP/${displayCurrency(e.Asset2.currency)}`,
        asset2Currency: e.Asset2.currency,
        asset2Issuer: e.Asset2.issuer ?? "",
        asset2Name: null,
        issuerVerified: false,
        xrpBalanceDrops: drops,
        asset2Value: String(amm.amount2?.value ?? "0"),
        tradingFee: amm.trading_fee ?? e.TradingFee ?? 0,
        frozen: amm.asset2_frozen === true,
      });
    } catch {
      // An AMM entry that amm_info will not resolve is not tradeable; skip it.
    }
  }

  return snapshots.sort((a, b) => Number(b.xrpBalanceDrops) - Number(a.xrpBalanceDrops)).slice(0, limit);
}
