/**
 * What a seller advertises about itself. Capacity is the capital the strategy
 * absorbs at its headline rate; past that the pool is full and further capital
 * earns nothing extra, which is what dilutes the average yield.
 */
export interface StrategyProfile {
  id: string;
  name: string;
  family: "amm_lp" | "lend_borrow" | "carry";
  /** Rate while the strategy is inside its capacity, as a fraction. */
  headlineApy: number;
  /** Capital absorbed before yield starts diluting, in mandate units. */
  capacity: number;
  riskScore: number;
  exitHours: number;
  /** Ceiling this strategy applies to individual pools, on top of the mandate's. */
  maxPoolRisk: number;
  /** XRPL address the strategy author is paid out to. */
  payoutAddress: string;
  /** Amendments this strategy's execution needs. */
  requires: string[];
}

/** A profile plus how full it is right now. Crosses the network as plain JSON. */
export interface StrategyQuote extends StrategyProfile {
  /** Capital already committed to this strategy. */
  deployed: number;
  /** Capacity still available at the headline rate. */
  remaining: number;
  /** Rate the next unit of capital would earn. Zero once the pool is full. */
  marginalApy: number;
  /** When the figure was taken, so a stale quote is visible as stale. */
  quotedAt: string;
}

export function remainingCapacity(p: Pick<StrategyProfile, "capacity">, deployed: number): number {
  return Math.max(0, p.capacity - deployed);
}

/**
 * Average APY a buyer would earn by adding `additional` capital on top of what
 * is already deployed. Inside the remaining capacity it is the headline rate;
 * beyond it the extra capital earns nothing, so the average falls off as
 * remaining/additional.
 */
export function apyFor(
  p: Pick<StrategyProfile, "headlineApy" | "capacity">,
  deployed: number,
  additional: number,
): number {
  if (additional <= 0) return 0;
  const room = remainingCapacity(p, deployed);
  if (room <= 0) return 0;
  if (additional <= room) return p.headlineApy;
  return (p.headlineApy * room) / additional;
}

export function quoteFor(p: StrategyProfile, deployed: number, now = new Date()): StrategyQuote {
  const remaining = remainingCapacity(p, deployed);
  return {
    ...p,
    deployed,
    remaining,
    marginalApy: remaining > 0 ? p.headlineApy : 0,
    quotedAt: now.toISOString(),
  };
}
