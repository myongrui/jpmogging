import type { PlanLeg } from "../../shared/plan.js";
import type { AmendmentState } from "../amendments.js";

export interface VenueAllocation {
  /** Venue identity, e.g. "amm:rhWTX…". */
  venue: string;
  /** Mandate-denominated size. */
  amountRlusd: number;
  /** Mandate units per XRP, for venues priced in drops. */
  rlusdPerXrp: number;
  /** Whether the buyer already holds a trustline for the venue's non-XRP side. */
  hasTrustline: boolean;
  asset2Currency: string;
  asset2Issuer: string;
  pairLabel: string;
  /** Set for vault venues once SingleAssetVault is live. */
  vaultId?: string;
  /** Set for lending venues once LendingProtocol is live. */
  loanBrokerId?: string;
  /** Loan-to-value for leveraged venues, 0..1. */
  targetLtv?: number;
}

export interface VenueAdapter {
  readonly id: string;
  /** Amendments this venue's transactions require. */
  readonly requires: readonly string[];
  /** True when every required amendment is live on the connected network. */
  available(state: AmendmentState): boolean;
  /** Unsigned legs, with compensations, starting at the given sequence number. */
  plan(alloc: VenueAllocation, startSeq: number): PlanLeg[];
}

export function requiresMet(requires: readonly string[], state: AmendmentState): boolean {
  if (!state.known) return false;
  return requires.every((name) => state.enabled.has(name));
}
