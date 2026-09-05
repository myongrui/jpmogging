import { readFileSync } from "node:fs";
import type { StrategyProfile } from "./strategy.js";

/**
 * The strategies the platform lists. A strategy is a named policy — a rate, a
 * capacity, and a risk ceiling it applies to individual pools — not a separate
 * service. The platform runs the engine on their behalf.
 */
export type SellerListing = StrategyProfile;

export const DEFAULT_LISTINGS: StrategyProfile[] = [
  {
    id: "alpha", name: "Alpha Deep LP", family: "amm_lp",
    headlineApy: 0.05, capacity: 100_000,
    riskScore: 22, maxPoolRisk: 25, exitHours: 1, requires: ["AMM"],
    payoutAddress: "rAlphaStrategyAuthorAddressPlaceholder",
  },
  {
    id: "beta", name: "Beta Wide Router", family: "amm_lp",
    headlineApy: 0.045, capacity: 200_000,
    riskScore: 26, maxPoolRisk: 45, exitHours: 2, requires: ["AMM"],
    payoutAddress: "rBetaStrategyAuthorAddressPlaceholder",
  },
  {
    id: "gamma", name: "Gamma Thin Edge", family: "amm_lp",
    headlineApy: 0.062, capacity: 40_000,
    riskScore: 29, maxPoolRisk: 70, exitHours: 4, requires: ["AMM"],
    payoutAddress: "rGammaStrategyAuthorAddressPlaceholder",
  },
];

export function loadRegistry(path?: string): StrategyProfile[] {
  if (!path) return DEFAULT_LISTINGS;
  return JSON.parse(readFileSync(path, "utf8")) as StrategyProfile[];
}
