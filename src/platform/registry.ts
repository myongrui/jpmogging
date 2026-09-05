import { readFileSync } from "node:fs";
import type { StrategyProfile } from "./strategy.js";

/** A strategy the platform lists, plus where to reach the seller that runs it. */
export interface SellerListing extends StrategyProfile {
  /** Seller root. The MCP endpoint and quote endpoint hang off this. */
  baseUrl: string;
}

export const DEFAULT_LISTINGS: SellerListing[] = [
  {
    id: "alpha", name: "Alpha Deep LP", family: "amm_lp",
    baseUrl: "http://127.0.0.1:8080",
    headlineApy: 0.05, capacity: 100_000,
    riskScore: 22, exitHours: 1, priceDrops: "500000", requires: ["AMM"],
  },
  {
    id: "beta", name: "Beta Wide Router", family: "amm_lp",
    baseUrl: "http://127.0.0.1:8082",
    headlineApy: 0.045, capacity: 200_000,
    riskScore: 26, exitHours: 2, priceDrops: "400000", requires: ["AMM"],
  },
  {
    id: "gamma", name: "Gamma Thin Edge", family: "amm_lp",
    baseUrl: "http://127.0.0.1:8083",
    headlineApy: 0.062, capacity: 40_000,
    riskScore: 29, exitHours: 4, priceDrops: "600000", requires: ["AMM"],
  },
];

export function mcpEndpoint(l: SellerListing): string {
  return `${l.baseUrl}/mcp`;
}

export function quoteEndpoint(l: SellerListing): string {
  return `${l.baseUrl}/api/quote`;
}

export function loadRegistry(path?: string): SellerListing[] {
  if (!path) return DEFAULT_LISTINGS;
  return JSON.parse(readFileSync(path, "utf8")) as SellerListing[];
}
