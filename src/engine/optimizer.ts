import type { AllocationLine, AllocationResult, Mandate, PoolMetrics } from "../shared/types.js";

const MIN_LIQUIDITY_SCORE = 50;
const VALIDITY_MS = 60 * 60 * 1000;

export function optimizeAllocation(
  mandate: Mandate,
  pools: PoolMetrics[],
  ctx: { rlusdPerXrp: number; ledgerIndex: number; sampledAt: string; now: Date; rateSource?: string },
): AllocationResult {
  const eligible = pools
    .filter((p) => p.riskScore <= mandate.maximum_risk_score && p.liquidityScore >= MIN_LIQUIDITY_SCORE && !p.frozen && p.feeApy > 0)
    .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);

  let deployable = mandate.amount * (1 - mandate.minimum_liquidity);
  const cap = mandate.amount * mandate.maximum_protocol_allocation;
  const allocations: AllocationLine[] = [];
  for (const p of eligible) {
    if (deployable <= 0 || cap <= 0) break;
    const amount = Math.min(cap, deployable);
    deployable -= amount;
    allocations.push({
      ammAccount: p.ammAccount,
      pairLabel: p.pairLabel,
      weight: amount / mandate.amount,
      amount,
      feeApy: p.feeApy,
      riskScore: p.riskScore,
      liquidityScore: p.liquidityScore,
    });
  }

  const deployedWeight = allocations.reduce((s, l) => s + l.weight, 0);
  const reserveAmount = mandate.amount - allocations.reduce((s, l) => s + l.amount, 0);
  const weighted = (pick: (l: AllocationLine) => number) =>
    deployedWeight === 0 ? 0 : allocations.reduce((s, l) => s + (l.weight / deployedWeight) * pick(l), 0);

  const rejected = pools.length - eligible.length;
  const reasoning =
    allocations.length === 0
      ? `None of ${pools.length} observed pools satisfied risk <= ${mandate.maximum_risk_score} with adequate depth; hold liquid.`
      : `${allocations.length} pool(s) selected by risk-adjusted fee yield; ${rejected} rejected on risk or depth; ${Math.round(mandate.minimum_liquidity * 100)}% reserve kept liquid per mandate.`;

  return {
    recommendation: allocations[0]?.pairLabel ?? "hold_liquid",
    allocations,
    liquid_reserve: { weight: reserveAmount / mandate.amount, amount: reserveAmount },
    expected_apy: allocations.reduce((s, l) => s + l.weight * l.feeApy, 0),
    portfolio_risk_score: weighted((l) => l.riskScore),
    portfolio_liquidity_score: deployedWeight === 0 ? 100 : weighted((l) => l.liquidityScore),
    reasoning,
    opportunities_considered: pools.length,
    data: { ledger_index: ctx.ledgerIndex, rlusd_per_xrp: ctx.rlusdPerXrp, sampled_at: ctx.sampledAt, rate_source: ctx.rateSource },
    timestamp: ctx.now.toISOString(),
    valid_until: new Date(ctx.now.getTime() + VALIDITY_MS).toISOString(),
  };
}
