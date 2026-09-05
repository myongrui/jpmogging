import type { PlanLeg } from "../../shared/plan.js";
import type { AmendmentState } from "../amendments.js";
import { requiresMet, type VenueAdapter, type VenueAllocation } from "./types.js";

/** AMMDeposit/AMMWithdraw flag for putting in (or taking out) a single side. */
const TF_SINGLE_ASSET = 0x00080000;

export function rlusdToDrops(amountRlusd: number, rlusdPerXrp: number): string {
  if (!(rlusdPerXrp > 0)) throw new Error(`rlusdPerXrp must be positive, got ${rlusdPerXrp}`);
  return String(Math.floor((amountRlusd / rlusdPerXrp) * 1_000_000));
}

/**
 * XRPL native AMM. Deposits the XRP side only, which keeps the plan to one
 * transaction per pool and avoids needing a matching balance of the pair asset.
 */
export const ammAdapter: VenueAdapter = {
  id: "amm",
  requires: ["AMM"],

  available(state: AmendmentState): boolean {
    return requiresMet(this.requires, state);
  },

  plan(alloc: VenueAllocation, startSeq: number): PlanLeg[] {
    const ammAccount = alloc.venue.replace(/^amm:/, "");
    const drops = rlusdToDrops(alloc.amountRlusd, alloc.rlusdPerXrp);
    const asset = { currency: "XRP" };
    const asset2 = { currency: alloc.asset2Currency, issuer: alloc.asset2Issuer };
    const legs: PlanLeg[] = [];
    let seq = startSeq;

    if (!alloc.hasTrustline) {
      legs.push({
        seq: seq++,
        venue: alloc.venue,
        kind: "trustline",
        description: `Trustline for ${alloc.pairLabel} LP settlement`,
        tx: {
          TransactionType: "TrustSet",
          LimitAmount: { currency: alloc.asset2Currency, issuer: alloc.asset2Issuer, value: "1000000000" },
        },
        amountRlusd: 0,
        compensate: {
          TransactionType: "TrustSet",
          LimitAmount: { currency: alloc.asset2Currency, issuer: alloc.asset2Issuer, value: "0" },
        },
      });
    }

    legs.push({
      seq: seq++,
      venue: alloc.venue,
      kind: "deposit",
      description: `Deposit ${alloc.amountRlusd} RLUSD-equivalent (${drops} drops) into ${alloc.pairLabel} (${ammAccount})`,
      tx: {
        TransactionType: "AMMDeposit",
        Asset: asset,
        Asset2: asset2,
        Amount: drops,
        Flags: TF_SINGLE_ASSET,
      },
      amountRlusd: alloc.amountRlusd,
      compensate: {
        TransactionType: "AMMWithdraw",
        Asset: asset,
        Asset2: asset2,
        Amount: drops,
        Flags: TF_SINGLE_ASSET,
      },
    });

    return legs;
  },
};
