import type { PlanLeg } from "../../shared/plan.js";
import type { AmendmentState } from "../amendments.js";
import { rlusdToDrops } from "./amm.js";
import { requiresMet, type VenueAdapter, type VenueAllocation } from "./types.js";

/**
 * Lend/borrow carry: deposit into a vault, then draw a loan against it at the
 * mandate's target LTV. Requires both amendments; neither is live yet, so this
 * venue stays dark. The borrow leg is irreversible in one step (repayment is a
 * LoanPay against accrued interest), so it carries no compensation.
 */
export const lendingAdapter: VenueAdapter = {
  id: "lending",
  requires: ["SingleAssetVault", "LendingProtocol"],

  available(state: AmendmentState): boolean {
    return requiresMet(this.requires, state);
  },

  plan(alloc: VenueAllocation, startSeq: number): PlanLeg[] {
    if (!alloc.vaultId) throw new Error(`lending venue ${alloc.venue} is missing a vaultId`);
    if (!alloc.loanBrokerId) throw new Error(`lending venue ${alloc.venue} is missing a loanBrokerId`);
    const ltv = alloc.targetLtv ?? 0.6;
    if (!(ltv > 0 && ltv <= 1)) throw new Error(`targetLtv must be within (0,1], got ${ltv}`);

    const collateralDrops = rlusdToDrops(alloc.amountRlusd, alloc.rlusdPerXrp);
    const principalDrops = rlusdToDrops(alloc.amountRlusd * ltv, alloc.rlusdPerXrp);
    let seq = startSeq;

    return [
      {
        seq: seq++,
        venue: alloc.venue,
        kind: "deposit",
        description: `Post ${collateralDrops} drops of collateral to vault ${alloc.vaultId}`,
        tx: { TransactionType: "VaultDeposit", VaultID: alloc.vaultId, Amount: collateralDrops },
        amountRlusd: alloc.amountRlusd,
        compensate: { TransactionType: "VaultWithdraw", VaultID: alloc.vaultId, Amount: collateralDrops },
      },
      {
        seq: seq++,
        venue: alloc.venue,
        kind: "loan",
        description: `Draw ${principalDrops} drops at ${Math.round(ltv * 100)}% LTV from broker ${alloc.loanBrokerId}`,
        tx: {
          TransactionType: "LoanSet",
          LoanBrokerID: alloc.loanBrokerId,
          PrincipalRequested: principalDrops,
        },
        amountRlusd: 0,
      },
    ];
  },
};
