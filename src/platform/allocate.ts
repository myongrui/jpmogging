import type { Mandate } from "../shared/types.js";
import { apyFor, type StrategyQuote } from "./strategy.js";

export interface AllocationLeg {
  sellerId: string;
  name: string;
  amount: number;
  /** Rate this leg earns at its size, after dilution. */
  apy: number;
  riskScore: number;
  /** True when this leg took everything the strategy had room for. */
  filledToCapacity: boolean;
}

export interface Rejection {
  sellerId: string;
  name: string;
  reason: string;
}

export interface SplitResult {
  legs: AllocationLeg[];
  rejected: Rejection[];
  deployed: number;
  reserve: number;
  /** Capital-weighted APY across the deployed legs. */
  blendedApy: number;
  /** Capital that fit no strategy, on top of the mandated reserve. */
  unplaced: number;
  reasoning: string;
}

/**
 * Splits capital across strategies by marginal yield.
 *
 * Each strategy pays its headline rate only up to its capacity, so the best
 * total return comes from filling the highest-rate strategy to its limit, then
 * moving to the next — rather than dividing capital by a flat per-venue
 * percentage, which under-uses deep strategies and over-fragments small
 * mandates. The mandate's concentration cap still applies on top as a ceiling.
 */
export function splitCapital(mandate: Mandate, quotes: StrategyQuote[]): SplitResult {
  const rejected: Rejection[] = [];
  const exitCeiling = mandate.horizon_hours * (1 - mandate.minimum_liquidity);

  const eligible = quotes.filter((q) => {
    if (q.riskScore > mandate.maximum_risk_score) {
      rejected.push({ sellerId: q.id, name: q.name, reason: `risk ${q.riskScore} exceeds ceiling ${mandate.maximum_risk_score}` });
      return false;
    }
    if (q.exitHours > exitCeiling) {
      rejected.push({ sellerId: q.id, name: q.name, reason: `exit ${q.exitHours}h exceeds ${exitCeiling}h implied by the liquidity floor` });
      return false;
    }
    if (q.remaining <= 0) {
      rejected.push({ sellerId: q.id, name: q.name, reason: `at capacity: ${q.deployed} of ${q.capacity} deployed` });
      return false;
    }
    return true;
  });

  // Highest marginal rate first; break ties toward the safer strategy.
  const ranked = [...eligible].sort((a, b) => b.marginalApy - a.marginalApy || a.riskScore - b.riskScore);

  let budget = mandate.amount * (1 - mandate.minimum_liquidity);
  const concentrationCap = mandate.amount * mandate.maximum_protocol_allocation;
  const legs: AllocationLeg[] = [];

  for (const q of ranked) {
    if (budget <= 0) break;
    const amount = Math.min(q.remaining, budget, concentrationCap);
    if (amount <= 0) continue;
    budget -= amount;
    legs.push({
      sellerId: q.id,
      name: q.name,
      amount,
      apy: apyFor(q, q.deployed, amount),
      riskScore: q.riskScore,
      filledToCapacity: amount >= q.remaining,
    });
  }

  const deployed = legs.reduce((s, l) => s + l.amount, 0);
  const blendedApy = deployed === 0 ? 0 : legs.reduce((s, l) => s + (l.amount / deployed) * l.apy, 0);

  const reasoning =
    legs.length === 0
      ? `No listed strategy fits the mandate; ${quotes.length} evaluated, holding all capital liquid.`
      : `${legs.length} strategy(ies) filled by marginal yield; ${rejected.length} rejected; ` +
        `${Math.round(mandate.minimum_liquidity * 100)}% reserve held per mandate` +
        (budget > 0 ? `; ${budget} could not be placed inside available capacity.` : ".");

  return {
    legs,
    rejected,
    deployed,
    reserve: mandate.amount - deployed,
    blendedApy,
    unplaced: budget,
    reasoning,
  };
}
