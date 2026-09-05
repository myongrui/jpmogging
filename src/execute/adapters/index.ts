import type { AmendmentState } from "../amendments.js";
import { ammAdapter } from "./amm.js";
import { lendingAdapter } from "./lending.js";
import type { VenueAdapter } from "./types.js";
import { vaultAdapter } from "./vault.js";

export const ADAPTERS: VenueAdapter[] = [ammAdapter, vaultAdapter, lendingAdapter];

export function adapterFor(venue: string): VenueAdapter {
  const id = venue.split(":")[0];
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new Error(`no adapter registered for venue ${venue}`);
  return adapter;
}

/** Which venue kinds the connected network can actually execute right now. */
export function availability(state: AmendmentState): Record<string, boolean> {
  return Object.fromEntries(ADAPTERS.map((a) => [a.id, a.available(state)]));
}

export * from "./types.js";
export { ammAdapter, vaultAdapter, lendingAdapter };
