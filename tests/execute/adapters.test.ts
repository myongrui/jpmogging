import { describe, expect, it } from "vitest";
import { adapterFor, availability } from "../../src/execute/adapters/index.js";
import { ammAdapter, rlusdToDrops } from "../../src/execute/adapters/amm.js";
import { lendingAdapter } from "../../src/execute/adapters/lending.js";
import { vaultAdapter } from "../../src/execute/adapters/vault.js";
import type { VenueAllocation } from "../../src/execute/adapters/types.js";

const alloc: VenueAllocation = {
  venue: "amm:rPool",
  amountRlusd: 25000,
  rlusdPerXrp: 2,
  hasTrustline: false,
  asset2Currency: "USD",
  asset2Issuer: "rIssuer",
  pairLabel: "XRP/USD",
};

const live = (names: string[]) => ({ known: true, enabled: new Set(names) });

describe("rlusdToDrops", () => {
  it("converts mandate units to drops at the given rate", () => {
    expect(rlusdToDrops(25000, 2)).toBe("12500000000");
  });
  it("refuses a non-positive rate rather than emitting a bogus amount", () => {
    expect(() => rlusdToDrops(1, 0)).toThrow(/must be positive/);
  });
});

describe("ammAdapter", () => {
  it("emits a trustline leg then a deposit, with compensations", () => {
    const legs = ammAdapter.plan(alloc, 1);
    expect(legs.map((l) => l.tx.TransactionType)).toEqual(["TrustSet", "AMMDeposit"]);
    expect(legs[0].amountRlusd).toBe(0);
    expect(legs[1].amountRlusd).toBe(25000);
    expect(legs[1].compensate!.TransactionType).toBe("AMMWithdraw");
  });

  it("skips the trustline when the buyer already holds one", () => {
    const legs = ammAdapter.plan({ ...alloc, hasTrustline: true }, 1);
    expect(legs.map((l) => l.tx.TransactionType)).toEqual(["AMMDeposit"]);
  });

  it("never presets fields the buyer owns", () => {
    for (const leg of ammAdapter.plan(alloc, 1)) {
      for (const f of ["Account", "Sequence", "Fee", "LastLedgerSequence"]) expect(f in leg.tx).toBe(false);
    }
  });

  it("is available only when the AMM amendment is live", () => {
    expect(ammAdapter.available(live(["AMM"]))).toBe(true);
    expect(ammAdapter.available(live([]))).toBe(false);
    expect(ammAdapter.available({ known: false, enabled: new Set() })).toBe(false);
  });
});

describe("gated adapters", () => {
  it("keeps vault and lending dark until their amendments enable", () => {
    const state = live(["AMM"]);
    expect(vaultAdapter.available(state)).toBe(false);
    expect(lendingAdapter.available(state)).toBe(false);
    expect(vaultAdapter.available(live(["SingleAssetVault"]))).toBe(true);
    expect(lendingAdapter.available(live(["SingleAssetVault", "LendingProtocol"]))).toBe(true);
  });

  it("plans a collateral leg and a borrow leg at the target LTV", () => {
    const legs = lendingAdapter.plan(
      { ...alloc, venue: "lending:v1", vaultId: "V1", loanBrokerId: "B1", targetLtv: 0.6 },
      1,
    );
    expect(legs.map((l) => l.tx.TransactionType)).toEqual(["VaultDeposit", "LoanSet"]);
    expect(legs[1].tx.PrincipalRequested).toBe("7500000000");
    // Only the collateral counts as deployed capital; the borrow is not new exposure.
    expect(legs.reduce((s, l) => s + l.amountRlusd, 0)).toBe(25000);
  });

  it("refuses to plan a vault leg without a vault id", () => {
    expect(() => vaultAdapter.plan({ ...alloc, venue: "vault:x" }, 1)).toThrow(/vaultId/);
  });
});

describe("registry", () => {
  it("resolves an adapter from the venue prefix", () => {
    expect(adapterFor("amm:rPool").id).toBe("amm");
    expect(() => adapterFor("unknown:x")).toThrow(/no adapter registered/);
  });

  it("reports availability per venue kind", () => {
    expect(availability(live(["AMM"]))).toEqual({ amm: true, vault: false, lending: false });
  });
});
