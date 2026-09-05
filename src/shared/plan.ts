import type { Mandate } from "./types.js";

/** An unsigned XRPL transaction as it travels over the wire, as plain JSON. */
export type UnsignedTx = Record<string, unknown>;

export type LegKind = "trustline" | "deposit" | "withdraw" | "offer" | "loan";

export interface PlanLeg {
  seq: number;
  /** Venue identity, e.g. "amm:rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3". */
  venue: string;
  kind: LegKind;
  description: string;
  /**
   * Unsigned transaction. The seller never sets Account, Sequence, Fee or
   * LastLedgerSequence — the buyer fills those from its own wallet so a plan
   * can never direct funds out of an account the seller chose.
   */
  tx: UnsignedTx;
  /** Mandate-denominated size of this leg, for constraint checking. */
  amountRlusd: number;
  /** How to unwind this leg if a later one fails. Absent when irreversible. */
  compensate?: UnsignedTx;
}

export interface ExecutionPlan {
  planId: string;
  network: string;
  createdAt: string;
  validUntil: string;
  mandate: Mandate;
  legs: PlanLeg[];
  totals: { deployed: number; reserve: number; venues: number };
}

/** Transaction types a buyer will sign. Anything else is rejected outright. */
export const ALLOWED_TX_TYPES = new Set([
  "TrustSet",
  "AMMDeposit",
  "AMMWithdraw",
  "OfferCreate",
  "OfferCancel",
  "VaultDeposit",
  "VaultWithdraw",
  "LoanSet",
  "LoanPay",
]);

/** Fields the buyer owns. A plan that presets any of them is rejected. */
export const BUYER_OWNED_FIELDS = ["Account", "Sequence", "Fee", "LastLedgerSequence", "SigningPubKey", "TxnSignature"];

export function planLegTag(planId: string, seq: number): string {
  return `${planId}:${seq}`;
}
