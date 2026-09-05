import type { AmendmentState } from "../execute/amendments.js";
import type { Mandate } from "../shared/types.js";
import { splitCapital, type AllocationLeg, type Rejection } from "./allocate.js";
import { mcpEndpoint, quoteEndpoint, type SellerListing } from "./registry.js";
import { quoteFor, type StrategyQuote } from "./strategy.js";

export interface OrchestratedLeg extends AllocationLeg {
  endpoint: string;
  priceDrops: string;
  /** False when the seller did not answer and its listed figures were used. */
  quoteLive: boolean;
}

export interface Orchestration {
  band: "conservative" | "moderate" | "aggressive";
  legs: OrchestratedLeg[];
  rejected: Rejection[];
  deployed: number;
  reserve: number;
  blendedApy: number;
  unplaced: number;
  reasoning: string;
  /** Sellers that did not answer a quote request. */
  staleQuotes: string[];
}

export function riskBand(mandate: Mandate): Orchestration["band"] {
  if (mandate.maximum_risk_score <= 20) return "conservative";
  if (mandate.maximum_risk_score <= 40) return "moderate";
  return "aggressive";
}

/**
 * Asks every listed seller what it is paying right now and how much room it has
 * left. A seller that does not answer falls back to its listed figures, marked
 * as stale rather than silently trusted.
 */
export async function fetchQuotes(
  listings: SellerListing[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2500,
): Promise<{ quotes: StrategyQuote[]; stale: string[] }> {
  const quotes: StrategyQuote[] = [];
  const stale: string[] = [];

  await Promise.all(
    listings.map(async (l) => {
      try {
        const res = await fetchImpl(quoteEndpoint(l), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        quotes.push((await res.json()) as StrategyQuote);
      } catch {
        stale.push(l.id);
        quotes.push(quoteFor(l, 0));
      }
    }),
  );

  return { quotes, stale };
}

/**
 * The platform's product: a capacity-aware split across sellers, priced off
 * live quotes. Strategies whose amendments are not enabled on this network are
 * dropped before allocation, because a plan nobody can execute is not a match.
 */
export async function orchestrate(
  mandate: Mandate,
  listings: SellerListing[],
  amendments: AmendmentState,
  fetchImpl: typeof fetch = fetch,
): Promise<Orchestration> {
  const supported: SellerListing[] = [];
  const rejected: Rejection[] = [];

  for (const l of listings) {
    if (!amendments.known) {
      rejected.push({ sellerId: l.id, name: l.name, reason: "amendment state unknown on this network" });
      continue;
    }
    const missing = l.requires.filter((a) => !amendments.enabled.has(a));
    if (missing.length) {
      rejected.push({ sellerId: l.id, name: l.name, reason: `requires ${missing.join(", ")}, not enabled on this network` });
      continue;
    }
    supported.push(l);
  }

  const { quotes, stale } = await fetchQuotes(supported, fetchImpl);
  const split = splitCapital(mandate, quotes);
  const byId = new Map(supported.map((l) => [l.id, l]));

  return {
    band: riskBand(mandate),
    legs: split.legs.map((leg) => {
      const listing = byId.get(leg.sellerId)!;
      return {
        ...leg,
        endpoint: mcpEndpoint(listing),
        priceDrops: listing.priceDrops,
        quoteLive: !stale.includes(leg.sellerId),
      };
    }),
    rejected: [...rejected, ...split.rejected],
    deployed: split.deployed,
    reserve: split.reserve,
    blendedApy: split.blendedApy,
    unplaced: split.unplaced,
    reasoning: split.reasoning,
    staleQuotes: stale,
  };
}
