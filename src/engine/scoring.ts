import type { PoolMetrics, PoolSnapshot } from "../shared/types.js";

export const KNOWN_STABLE_ISSUERS: Record<string, string> = {
  rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De: "RLUSD",
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function feeApy(volumeXrpPerDay: number, tradingFee: number, tvlXrp: number): number {
  if (tvlXrp <= 0) return 0;
  return (volumeXrpPerDay * (tradingFee / 100_000) * 365) / tvlXrp;
}

export function riskScore(p: Pick<PoolSnapshot, "asset2Issuer" | "issuerVerified" | "tradingFee" | "frozen"> & { tvlXrp: number }): number {
  let score = 20;
  if (!(p.asset2Issuer in KNOWN_STABLE_ISSUERS)) score += p.issuerVerified ? 20 : 40;
  if (p.tvlXrp < 50_000) score += 25;
  else if (p.tvlXrp < 250_000) score += 10;
  if (p.tradingFee > 500) score += 10;
  if (p.frozen) score += 30;
  return clamp(score, 0, 100);
}

export function liquidityScore(deployXrp: number, tvlXrp: number): number {
  if (tvlXrp <= 0) return 0;
  const share = deployXrp / tvlXrp;
  return Math.round(100 * (1 - Math.min(1, share * 5)));
}

export function scorePool(snapshot: PoolSnapshot, volumeXrpPerDay: number, deployXrp: number): PoolMetrics {
  const tvlXrp = (Number(snapshot.xrpBalanceDrops) / 1_000_000) * 2;
  const apy = feeApy(volumeXrpPerDay, snapshot.tradingFee, tvlXrp);
  const risk = riskScore({ ...snapshot, tvlXrp });
  return {
    ...snapshot,
    tvlXrp,
    volumeXrpPerDay,
    feeApy: apy,
    riskScore: risk,
    liquidityScore: liquidityScore(deployXrp, tvlXrp),
    riskAdjustedScore: apy * (1 - risk / 100),
  };
}
