import type { AmendmentState } from "../execute/amendments.js";
import type { Mandate } from "../shared/types.js";
import { splitCapital, type AllocationLeg, type Rejection } from "./allocate.js";
import type { StrategyProfile, StrategyQuote } from "./strategy.js";

export interface Orchestration {
  band: "conservative" | "moderate" | "aggressive";
  legs: AllocationLeg[];
  rejected: Rejection[];
  deployed: number;
  reserve: number;
  blendedApy: number;
  unplaced: number;
  reasoning: string;
}

export function riskBand(mandate: Mandate): Orchestration["band"] {
  if (mandate.maximum_risk_score <= 20) return "conservative";
  if (mandate.maximum_risk_score <= 40) return "moderate";
  return "aggressive";
}

/**
 * Splits a mandate across the platform's strategies by marginal yield.
 *
 * Strategies whose amendments are not enabled on this network are dropped
 * before allocation, because a plan nobody can execute is not a match.
 */
export function orchestrate(
  mandate: Mandate,
  profiles: StrategyProfile[],
  quotes: StrategyQuote[],
  amendments: AmendmentState,
): Orchestration {
  const rejected: Rejection[] = [];
  const supported: StrategyQuote[] = [];
  const byId = new Map(profiles.map((p) => [p.id, p]));

  for (const q of quotes) {
    const profile = byId.get(q.id);
    if (!profile) continue;
    if (!amendments.known) {
      rejected.push({ sellerId: q.id, name: q.name, reason: "amendment state unknown on this network" });
      continue;
    }
    const missing = profile.requires.filter((a) => !amendments.enabled.has(a));
    if (missing.length) {
      rejected.push({ sellerId: q.id, name: q.name, reason: `requires ${missing.join(", ")}, not enabled on this network` });
      continue;
    }
    supported.push(q);
  }

  const split = splitCapital(mandate, supported);
  return {
    band: riskBand(mandate),
    legs: split.legs,
    rejected: [...rejected, ...split.rejected],
    deployed: split.deployed,
    reserve: split.reserve,
    blendedApy: split.blendedApy,
    unplaced: split.unplaced,
    reasoning: split.reasoning,
  };
}
