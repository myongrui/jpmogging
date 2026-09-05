import type { PlanLeg } from "../../shared/plan.js";
import type { AmendmentState } from "../amendments.js";
import { rlusdToDrops } from "./amm.js";
import { requiresMet, type VenueAdapter, type VenueAllocation } from "./types.js";

/**
 * Single-asset vaults. The transaction types ship in xrpl.js today but the
 * SingleAssetVault amendment is not enabled on mainnet or testnet, so
 * `available()` keeps this venue dark until it is.
 */
export const vaultAdapter: VenueAdapter = {
  id: "vault",
  requires: ["SingleAssetVault"],

  available(state: AmendmentState): boolean {
    return requiresMet(this.requires, state);
  },

  plan(alloc: VenueAllocation, startSeq: number): PlanLeg[] {
    if (!alloc.vaultId) throw new Error(`vault venue ${alloc.venue} is missing a vaultId`);
    const drops = rlusdToDrops(alloc.amountRlusd, alloc.rlusdPerXrp);
    return [
      {
        seq: startSeq,
        venue: alloc.venue,
        kind: "deposit",
        description: `Deposit ${drops} drops into vault ${alloc.vaultId}`,
        tx: { TransactionType: "VaultDeposit", VaultID: alloc.vaultId, Amount: drops },
        amountRlusd: alloc.amountRlusd,
        compensate: { TransactionType: "VaultWithdraw", VaultID: alloc.vaultId, Amount: drops },
      },
    ];
  },
};
