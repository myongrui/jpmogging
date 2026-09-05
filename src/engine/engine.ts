import { availability } from "../execute/adapters/index.js";
import { readAmendments, type AmendmentState } from "../execute/amendments.js";
import type { AllocationResult, Mandate, Opportunity, PoolSnapshot } from "../shared/types.js";
import { MarketCache, loadMarket, type Market } from "./market.js";
import { optimizeAllocation } from "./optimizer.js";
import { buildPlan } from "./planner.js";
import { scorePool } from "./scoring.js";
import { discoverPools, discoverPoolsFromLedger, type XrplRpc } from "./xrplData.js";

export const RLUSD_AMM_ACCOUNT = "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3";

export interface EngineDeps {
  rpc: XrplRpc;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Network tag written into plans, e.g. "xrpl:1". */
  network?: string;
  /** Pool discovery strategy. Defaults to the xrpscan indexer (mainnet only). */
  discover?: () => Promise<PoolSnapshot[]>;
  /** Pool used to derive the RLUSD/XRP rate. Falls back to the deepest pool. */
  referenceAccount?: string;
  /** Live amendment set. Read from the node when omitted. */
  amendments?: AmendmentState;
  /** In-flight requests against the node. Public nodes throttle above ~4. */
  concurrency?: number;
  /** Shared market snapshot. Without one, every analysis re-reads the ledger. */
  market?: MarketCache;
}

function discoverer(deps: EngineDeps): () => Promise<PoolSnapshot[]> {
  return deps.discover ?? (() => discoverPools(deps.fetchImpl));
}

/** Ledger-backed discovery, for networks with no indexer in front of them. */
export function ledgerDiscoverer(rpc: XrplRpc, opts?: Parameters<typeof discoverPoolsFromLedger>[1]) {
  return () => discoverPoolsFromLedger(rpc, opts);
}

export function marketDeps(deps: EngineDeps) {
  return {
    rpc: deps.rpc,
    discover: discoverer(deps),
    referenceAccount: deps.referenceAccount ?? RLUSD_AMM_ACCOUNT,
    concurrency: deps.concurrency,
    now: deps.now,
  };
}

/** Builds a cache over the same inputs the engine would use directly. */
export function marketCache(deps: EngineDeps, ttlMs?: number): MarketCache {
  return new MarketCache(marketDeps(deps), ttlMs);
}

export async function listOpportunities(deps: EngineDeps): Promise<Opportunity[]> {
  const pools = await discoverer(deps)();
  return pools.map((p) => ({
    ammAccount: p.ammAccount,
    pairLabel: p.pairLabel,
    tvlXrp: (Number(p.xrpBalanceDrops) / 1_000_000) * 2,
    tradingFeeBps: p.tradingFee / 10,
  }));
}

export async function runAnalysis(deps: EngineDeps, mandate: Mandate): Promise<AllocationResult> {
  const now = deps.now ?? (() => new Date());
  const network = deps.network ?? "xrpl:1";

  const market: Market = deps.market ? await deps.market.get() : await loadMarket(marketDeps(deps));
  const deployXrp = (mandate.amount * mandate.maximum_protocol_allocation) / market.rlusdPerXrp;

  const scored = market.pools.map((p) => scorePool(p.snapshot, p.volumeXrpPerDay, deployXrp));
  const result = optimizeAllocation(mandate, scored, {
    rlusdPerXrp: market.rlusdPerXrp,
    ledgerIndex: market.ledgerIndex,
    sampledAt: market.sampledAt,
    now: now(),
    rateSource: market.rateSource,
  });

  const amendments = deps.amendments ?? (await readAmendments(deps.rpc));
  result.plan = buildPlan(mandate, result, scored, {
    network,
    rlusdPerXrp: market.rlusdPerXrp,
    now: now(),
    available: availability(amendments),
  });
  return result;
}
