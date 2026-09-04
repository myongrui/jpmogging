import { describe, expect, it } from "vitest";
import { EXPLORER_TX_URL, explorerTxUrl, type Mandate } from "../../src/shared/types.js";

describe("shared types", () => {
  it("builds a testnet explorer link", () => {
    expect(explorerTxUrl("ABC123")).toBe(`${EXPLORER_TX_URL}/ABC123`);
  });

  it("accepts a mandate literal", () => {
    const m: Mandate = {
      asset: "RLUSD",
      amount: 100000,
      horizon_hours: 72,
      minimum_liquidity: 0.5,
      maximum_risk_score: 30,
      maximum_protocol_allocation: 0.25,
    };
    expect(m.amount).toBe(100000);
  });
});
