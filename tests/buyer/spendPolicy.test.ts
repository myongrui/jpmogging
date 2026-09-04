import { describe, expect, it } from "vitest";
import { SpendTracker, policyFromEnv } from "../../src/buyer/spendPolicy.js";

describe("SpendTracker", () => {
  const policy = { maxDropsPerRequest: 1_000_000n, maxDropsPerSession: 1_500_000n };

  it("authorises within the per-request limit", () => {
    expect(new SpendTracker(policy).authorize("500000")).toEqual({ ok: true });
  });

  it("declines above the per-request limit", () => {
    expect(new SpendTracker(policy).authorize("1000001")).toEqual({ ok: false, reason: "1000001 drops exceeds per-request limit of 1000000 drops" });
  });

  it("declines when the session budget would be exceeded", () => {
    const t = new SpendTracker(policy);
    t.record("1000000");
    expect(t.spentDrops).toBe(1_000_000n);
    expect(t.authorize("600000")).toEqual({ ok: false, reason: "600000 drops would exceed session budget: 1000000 spent of 1500000 drops" });
    expect(t.authorize("500000")).toEqual({ ok: true });
  });

  it("reads the policy from env with defaults", () => {
    expect(policyFromEnv({})).toEqual({ maxDropsPerRequest: 1_000_000n, maxDropsPerSession: 3_000_000n });
    expect(policyFromEnv({ BUYER_MAX_DROPS_PER_REQUEST: "10", BUYER_MAX_DROPS_PER_SESSION: "20" })).toEqual({ maxDropsPerRequest: 10n, maxDropsPerSession: 20n });
  });
});
