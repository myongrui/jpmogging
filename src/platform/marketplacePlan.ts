import { randomBytes } from "node:crypto";
import type { Market } from "../engine/market.js";
import { optimizeAllocation } from "../engine/optimizer.js";
import { buildPlan } from "../engine/planner.js";
import { scorePool } from "../engine/scoring.js";
import type { ExecutionPlan, PlanLeg } from "../shared/plan.js";
import type { Mandate } from "../shared/types.js";
import type { AllocationLeg } from "./allocate.js";
import type { StrategyProfile } from "./strategy.js";

export interface StrategyPlan {
  strategyId: string;
  name: string;
  amount: number;
  apy: number;
  /** Pools this strategy chose for its slice. */
  pools: { ammAccount: string; pairLabel: string; amount: number; feeApy: number; riskScore: number }[];
  reasoning: string;
}

export interface MarketplacePlan {
  plan: ExecutionPlan;
  strategies: StrategyPlan[];
  /** Capital a strategy could not place because its venues were already at the cap. */
  crowdedOut: number;
}

const EPSILON = 1e-6;

/**
 * Turns a capital split into one signable plan.
 *
 * Each strategy gets a sub-mandate for its own slice, tightened to whichever
 * risk ceiling is stricter — the buyer's or the strategy's own. Their legs are
 * then renumbered into a single sequence so the buyer signs one plan rather
 * than one per strategy.
 */
export function buildMarketplacePlan(
  mandate: Mandate,
  legs: AllocationLeg[],
  profiles: StrategyProfile[],
  market: Market,
  ctx: { network: string; now: Date; available?: Record<string, boolean>; planId?: string },
): MarketplacePlan {
  const planId = ctx.planId ?? `pl_${randomBytes(4).toString("hex")}`;
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const allLegs: PlanLeg[] = [];
  const strategies: StrategyPlan[] = [];
  let seq = 1;
  let crowdedOut = 0;

  // Two strategies can independently pick the same pool, so the mandate's
  // concentration cap has to be tracked across the merged plan rather than
  // inside each strategy's slice.
  const venueCap = mandate.amount * mandate.maximum_protocol_allocation;
  const venueUsed = new Map<string, number>();
  const headroom = (ammAccount: string) => venueCap - (venueUsed.get(ammAccount) ?? 0);

  for (const leg of legs) {
    const profile = byId.get(leg.sellerId);
    if (!profile) continue;

    const subMandate: Mandate = {
      ...mandate,
      amount: leg.amount,
      // The slice is this strategy's whole budget, so it deploys all of it and
      // the reserve is accounted for once at the marketplace level.
      minimum_liquidity: 0,
      maximum_risk_score: Math.min(mandate.maximum_risk_score, profile.maxPoolRisk),
      maximum_protocol_allocation: 1,
    };

    const deployXrp = leg.amount / market.rlusdPerXrp;
    const scored = market.pools.map((p) => scorePool(p.snapshot, p.volumeXrpPerDay, deployXrp));
    const allocation = optimizeAllocation(subMandate, scored, {
      rlusdPerXrp: market.rlusdPerXrp,
      ledgerIndex: market.ledgerIndex,
      sampledAt: market.sampledAt,
      now: ctx.now,
      rateSource: market.rateSource,
    });

    // Trim each line to what the venue can still take across the whole plan.
    const trimmed = allocation.allocations
      .map((a) => ({ ...a, amount: Math.min(a.amount, Math.max(0, headroom(a.ammAccount))) }))
      .filter((a) => a.amount > EPSILON);
    for (const a of trimmed) venueUsed.set(a.ammAccount, (venueUsed.get(a.ammAccount) ?? 0) + a.amount);

    const placed = trimmed.reduce((s2, a) => s2 + a.amount, 0);
    crowdedOut += leg.amount - placed;

    const sub = buildPlan(subMandate, { ...allocation, allocations: trimmed }, scored, {
      network: ctx.network,
      rlusdPerXrp: market.rlusdPerXrp,
      now: ctx.now,
      available: ctx.available,
      planId,
    });

    for (const l of sub.legs) allLegs.push({ ...l, seq: seq++ });

    strategies.push({
      strategyId: profile.id,
      name: profile.name,
      amount: placed,
      apy: leg.apy,
      pools: trimmed.map((a) => ({
        ammAccount: a.ammAccount,
        pairLabel: a.pairLabel,
        amount: a.amount,
        feeApy: a.feeApy,
        riskScore: a.riskScore,
      })),
      reasoning:
        placed < leg.amount - EPSILON
          ? `${allocation.reasoning} Placed ${placed} of ${leg.amount}; the rest was crowded out by the ${Math.round(mandate.maximum_protocol_allocation * 100)}% per-venue cap.`
          : allocation.reasoning,
    });
  }

  const deployed = allLegs.reduce((s, l) => s + l.amountRlusd, 0);
  return {
    plan: {
      planId,
      network: ctx.network,
      createdAt: ctx.now.toISOString(),
      validUntil: new Date(ctx.now.getTime() + 60 * 60 * 1000).toISOString(),
      mandate,
      legs: allLegs,
      totals: { deployed, reserve: mandate.amount - deployed, venues: new Set(allLegs.map((l) => l.venue)).size },
    },
    strategies,
    crowdedOut,
  };
}
