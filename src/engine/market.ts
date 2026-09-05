import { mapWithConcurrency } from "../shared/concurrency.js";
import type { PoolSnapshot } from "../shared/types.js";
import { throttledRpc } from "./throttle.js";
import { fetchPoolState, sampleVolume, type XrplRpc } from "./xrplData.js";

export interface MarketPool {
  snapshot: PoolSnapshot;
  ledgerIndex: number;
  volumeXrpPerDay: number;
}

export interface Market {
  pools: MarketPool[];
  ledgerIndex: number;
  rlusdPerXrp: number;
  rateSource: string;
  sampledAt: string;
}

function rateFrom(p: MarketPool): number {
  const xrp = Number(p.snapshot.xrpBalanceDrops) / 1_000_000;
  const other = Number(p.snapshot.asset2Value);
  return xrp > 0 && other > 0 ? other / xrp : 0;
}

/**
 * Derives the mandate-unit price of XRP. The RLUSD pool is the preferred
 * reference, but it only exists on mainnet, so any network without it falls
 * back to the deepest pool that quotes a non-XRP side.
 */
export function resolveRate(pools: MarketPool[], referenceAccount: string): { rlusdPerXrp: number; source: string } {
  const reference = pools.find((p) => p.snapshot.ammAccount === referenceAccount);
  if (reference) {
    const rate = rateFrom(reference);
    if (rate > 0) return { rlusdPerXrp: rate, source: `reference pool ${referenceAccount}` };
  }
  const deepest = [...pools]
    .filter((p) => rateFrom(p) > 0)
    .sort((a, b) => Number(b.snapshot.xrpBalanceDrops) - Number(a.snapshot.xrpBalanceDrops))[0];
  if (deepest) return { rlusdPerXrp: rateFrom(deepest), source: `deepest pool ${deepest.snapshot.ammAccount}` };
  return { rlusdPerXrp: 1, source: "fallback 1:1 — no pool quoted a usable rate" };
}

export interface LoadMarketDeps {
  rpc: XrplRpc;
  discover: () => Promise<PoolSnapshot[]>;
  referenceAccount: string;
  concurrency?: number;
  now?: () => Date;
  /** Transactions sampled per pool when estimating volume. */
  volumeSample?: number;
  /** Set false to bypass pacing, e.g. against a private node or in tests. */
  throttle?: boolean;
}

/** The expensive half: one amm_info and one account_tx per pool. */
export async function loadMarket(deps: LoadMarketDeps): Promise<Market> {
  const now = deps.now ?? (() => new Date());
  const rpc = deps.throttle === false ? deps.rpc : throttledRpc(deps.rpc);
  const discovered = await deps.discover();
  const pools = await mapWithConcurrency(discovered, deps.concurrency ?? 2, async (p) => {
    const state = await fetchPoolState(rpc, p);
    const volume = await sampleVolume(rpc, p.ammAccount, deps.volumeSample ?? 60);
    return { snapshot: state.snapshot, ledgerIndex: state.ledgerIndex, volumeXrpPerDay: volume.volumeXrpPerDay };
  });
  const { rlusdPerXrp, source } = resolveRate(pools, deps.referenceAccount);
  return {
    pools,
    ledgerIndex: pools.length ? Math.max(...pools.map((p) => p.ledgerIndex)) : 0,
    rlusdPerXrp,
    rateSource: source,
    sampledAt: now().toISOString(),
  };
}

/**
 * Holds the market snapshot so a paid request never has to hit the ledger.
 *
 * Pool data is the same for every buyer and only the mandate-specific scoring
 * differs, so fetching it per request wastes calls and — because x402 settles
 * payment before the handler runs — turns a throttled node into a buyer who
 * paid and got nothing. Refreshing on a timer moves that risk off the paid path.
 */
export class MarketCache {
  private current?: Market;
  private loadedAt?: number;
  private inFlight?: Promise<Market>;

  constructor(
    private readonly deps: LoadMarketDeps,
    private readonly ttlMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  get snapshot(): Market | undefined {
    return this.current;
  }

  /** Measured on the cache's own clock, not the snapshot's timestamp, so the
   *  two never disagree about how old the entry is. */
  get ageMs(): number | undefined {
    return this.loadedAt === undefined ? undefined : this.clock() - this.loadedAt;
  }

  private get fresh(): boolean {
    const age = this.ageMs;
    return age !== undefined && age < this.ttlMs;
  }

  /** Returns cached data when fresh; otherwise loads, collapsing concurrent callers. */
  async get(): Promise<Market> {
    if (this.current && this.fresh) return this.current;
    if (!this.inFlight) {
      this.inFlight = loadMarket(this.deps)
        .then((m) => {
          this.current = m;
          this.loadedAt = this.clock();
          return m;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    try {
      return await this.inFlight;
    } catch (err) {
      // A refresh failure must not destroy a usable snapshot: stale data beats
      // charging a buyer and returning nothing.
      if (this.current) return this.current;
      throw err;
    }
  }

  /** Refreshes ahead of demand. Failures are swallowed; the timer tries again. */
  async warm(): Promise<void> {
    try {
      await this.get();
    } catch {
      /* keep serving whatever we have */
    }
  }
}
