import { describe, expect, it } from "vitest";
import { feeApy, liquidityScore, riskScore, scorePool } from "../../src/engine/scoring.js";
import type { PoolSnapshot } from "../../src/shared/types.js";

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

const rlusdPool: PoolSnapshot = {
  ammAccount: "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3",
  pairLabel: "XRP/RLUSD",
  asset2Currency: "524C555344000000000000000000000000000000",
  asset2Issuer: RLUSD_ISSUER,
  asset2Name: "RLUSD",
  issuerVerified: true,
  xrpBalanceDrops: "1673214842110",
  asset2Value: "2338593.89",
  tradingFee: 205,
  frozen: false,
};

describe("feeApy", () => {
  it("annualises fee income over TVL", () => {
    expect(feeApy(100_000, 1000, 1_000_000)).toBeCloseTo(0.365, 6);
  });
  it("returns 0 for empty pools", () => {
    expect(feeApy(100, 1000, 0)).toBe(0);
  });
});

describe("riskScore", () => {
  it("scores a deep allowlisted stable pool at the floor", () => {
    expect(riskScore({ asset2Issuer: RLUSD_ISSUER, issuerVerified: true, tradingFee: 205, frozen: false, tvlXrp: 3_000_000 })).toBe(20);
  });
  it("penalises unverified issuers, shallow depth, high fees and frozen assets", () => {
    expect(riskScore({ asset2Issuer: "rUnknown", issuerVerified: false, tradingFee: 800, frozen: true, tvlXrp: 10_000 })).toBe(100);
    expect(riskScore({ asset2Issuer: "rUnknown", issuerVerified: true, tradingFee: 100, frozen: false, tvlXrp: 100_000 })).toBe(50);
  });
});

describe("liquidityScore", () => {
  it("is 100 for a negligible share and 0 at 20% of the pool", () => {
    expect(liquidityScore(0, 1_000_000)).toBe(100);
    expect(liquidityScore(50_000, 1_000_000)).toBe(75);
    expect(liquidityScore(200_000, 1_000_000)).toBe(0);
  });
});

describe("scorePool", () => {
  it("combines metrics for a pool", () => {
    const m = scorePool(rlusdPool, 500_000, 20_000);
    expect(m.tvlXrp).toBeCloseTo(3_346_429.68, 0);
    expect(m.riskScore).toBe(20);
    expect(m.liquidityScore).toBe(97);
    expect(m.feeApy).toBeCloseTo(feeApy(500_000, 205, m.tvlXrp), 10);
    expect(m.riskAdjustedScore).toBeCloseTo(m.feeApy * 0.8, 10);
  });
});
