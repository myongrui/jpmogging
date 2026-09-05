import { ALLOWED_TX_TYPES, BUYER_OWNED_FIELDS, type ExecutionPlan } from "../shared/plan.js";
import type { Mandate } from "../shared/types.js";

export type PlanVerdict = { ok: true } | { ok: false; violations: string[] };

const EPSILON = 1e-6;

/**
 * Re-checks a seller's plan against the mandate before anything is signed.
 * The seller is a paid counterparty, not a trusted component: every constraint
 * the mandate expresses is verified here, on the buyer's side, from scratch.
 */
export function validatePlan(
  plan: ExecutionPlan,
  mandate: Mandate,
  ctx: { network: string; now?: Date },
): PlanVerdict {
  const now = ctx.now ?? new Date();
  const v: string[] = [];

  if (plan.network !== ctx.network) v.push(`plan network ${plan.network} does not match buyer network ${ctx.network}`);
  if (!plan.planId) v.push("plan is missing a planId");

  const validUntil = Date.parse(plan.validUntil);
  if (Number.isNaN(validUntil)) v.push(`plan valid_until is unparseable: ${plan.validUntil}`);
  else if (validUntil <= now.getTime()) v.push(`plan expired at ${plan.validUntil}`);

  // A zero-leg plan deploys nothing and therefore breaches nothing: it is how
  // "hold everything liquid" is expressed, not a malformed plan.

  plan.legs.forEach((leg, i) => {
    const where = `leg ${leg.seq}`;
    if (leg.seq !== i + 1) v.push(`${where}: sequence numbers must run 1..n in order`);

    const type = leg.tx.TransactionType;
    if (typeof type !== "string" || !ALLOWED_TX_TYPES.has(type)) {
      v.push(`${where}: transaction type ${String(type)} is not on the buyer's allowlist`);
    }
    for (const field of BUYER_OWNED_FIELDS) {
      if (field in leg.tx) v.push(`${where}: plan presets buyer-owned field ${field}`);
    }
    // No allowlisted type carries a Destination. Its presence means the plan is
    // trying to move funds to an address of the seller's choosing.
    if ("Destination" in leg.tx) v.push(`${where}: plan sets a Destination, which no allowed transaction type uses`);

    if (!Number.isFinite(leg.amountRlusd) || leg.amountRlusd < 0) {
      v.push(`${where}: amountRlusd must be a non-negative number, got ${leg.amountRlusd}`);
    }
  });

  const perVenue = new Map<string, number>();
  for (const leg of plan.legs) {
    perVenue.set(leg.venue, (perVenue.get(leg.venue) ?? 0) + leg.amountRlusd);
  }

  const venueCap = mandate.amount * mandate.maximum_protocol_allocation;
  for (const [venue, exposure] of perVenue) {
    if (exposure > venueCap + EPSILON) {
      v.push(
        `venue ${venue}: exposure ${exposure} exceeds per-protocol cap ${venueCap} ` +
          `(${Math.round(mandate.maximum_protocol_allocation * 100)}% of ${mandate.amount})`,
      );
    }
  }

  const deployed = plan.legs.reduce((s, l) => s + l.amountRlusd, 0);
  const deployCeiling = mandate.amount * (1 - mandate.minimum_liquidity);
  if (deployed > deployCeiling + EPSILON) {
    v.push(
      `total deployed ${deployed} exceeds ${deployCeiling}, leaving less than the ` +
        `${Math.round(mandate.minimum_liquidity * 100)}% liquidity floor`,
    );
  }
  if (deployed > mandate.amount + EPSILON) v.push(`total deployed ${deployed} exceeds mandate amount ${mandate.amount}`);

  if (Math.abs(plan.totals.deployed - deployed) > EPSILON) {
    v.push(`plan totals claim ${plan.totals.deployed} deployed but the legs sum to ${deployed}`);
  }
  const reserve = mandate.amount - deployed;
  if (Math.abs(plan.totals.reserve - reserve) > EPSILON) {
    v.push(`plan totals claim ${plan.totals.reserve} reserve but the legs imply ${reserve}`);
  }

  return v.length === 0 ? { ok: true } : { ok: false, violations: v };
}
