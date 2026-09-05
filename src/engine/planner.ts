import { randomBytes } from "node:crypto";
import { adapterFor, type VenueAllocation } from "../execute/adapters/index.js";
import type { ExecutionPlan, PlanLeg } from "../shared/plan.js";
import type { AllocationResult, Mandate, PoolMetrics } from "../shared/types.js";

const PLAN_VALIDITY_MS = 60 * 60 * 1000;

export interface PlanContext {
  network: string;
  rlusdPerXrp: number;
  now: Date;
  /** Venue kinds the connected network can execute. Unavailable venues are skipped. */
  available?: Record<string, boolean>;
  planId?: string;
}

function newPlanId(): string {
  return `pl_${randomBytes(4).toString("hex")}`;
}

/**
 * Turns an allocation into unsigned transactions the buyer can sign. Account,
 * Sequence and Fee are deliberately left unset — the buyer fills those from its
 * own wallet, so a plan can never move funds out of an account the seller named.
 */
export function buildPlan(
  mandate: Mandate,
  result: AllocationResult,
  pools: PoolMetrics[],
  ctx: PlanContext,
): ExecutionPlan {
  const planId = ctx.planId ?? newPlanId();
  const legs: PlanLeg[] = [];
  let seq = 1;

  for (const line of result.allocations) {
    const venue = `amm:${line.ammAccount}`;
    const adapter = adapterFor(venue);
    if (ctx.available && ctx.available[adapter.id] === false) continue;

    const pool = pools.find((p) => p.ammAccount === line.ammAccount);
    if (!pool) throw new Error(`allocation references unknown pool ${line.ammAccount}`);

    const alloc: VenueAllocation = {
      venue,
      amountRlusd: line.amount,
      rlusdPerXrp: ctx.rlusdPerXrp,
      hasTrustline: false,
      asset2Currency: pool.asset2Currency,
      asset2Issuer: pool.asset2Issuer,
      pairLabel: pool.pairLabel,
    };

    const produced = adapter.plan(alloc, seq);
    legs.push(...produced);
    seq += produced.length;
  }

  const deployed = legs.reduce((s, l) => s + l.amountRlusd, 0);
  return {
    planId,
    network: ctx.network,
    createdAt: ctx.now.toISOString(),
    validUntil: new Date(ctx.now.getTime() + PLAN_VALIDITY_MS).toISOString(),
    mandate,
    legs,
    totals: {
      deployed,
      reserve: mandate.amount - deployed,
      venues: new Set(legs.map((l) => l.venue)).size,
    },
  };
}
