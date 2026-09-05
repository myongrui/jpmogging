import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RevenueLedger, splitFee } from "../../src/platform/revenue.js";

const dir = () => mkdtempSync(join(tmpdir(), "rev-"));

describe("splitFee", () => {
  it("takes the platform cut off the top and shares the rest pro rata", () => {
    const s = splitFee("500000", 2000, [
      { strategyId: "alpha", amount: 75000 },
      { strategyId: "beta", amount: 25000 },
    ]);
    expect(s.platformDrops).toBe("100000");
    expect(s.strategyDrops).toEqual({ alpha: "300000", beta: "100000" });
  });

  it("pays a strategy that placed nothing exactly nothing", () => {
    const s = splitFee("500000", 2000, [
      { strategyId: "alpha", amount: 100000 },
      { strategyId: "beta", amount: 0 },
    ]);
    expect(s.strategyDrops.beta).toBe("0");
    expect(s.strategyDrops.alpha).toBe("400000");
  });

  it("keeps the whole fee when no capital was placed", () => {
    const s = splitFee("500000", 2000, []);
    expect(s.platformDrops).toBe("500000");
    expect(s.strategyDrops).toEqual({});
  });

  it("never pays out more drops than it took in", () => {
    // Thirds do not divide evenly into drops; the dust must stay with the platform.
    const s = splitFee("100000", 1000, [
      { strategyId: "a", amount: 1 },
      { strategyId: "b", amount: 1 },
      { strategyId: "c", amount: 1 },
    ]);
    const out = BigInt(s.platformDrops) + Object.values(s.strategyDrops).reduce((t, d) => t + BigInt(d), 0n);
    expect(out).toBe(100000n);
  });

  it("gives everything away at a zero cut", () => {
    const s = splitFee("1000", 0, [{ strategyId: "a", amount: 10 }]);
    expect(s.platformDrops).toBe("0");
    expect(s.strategyDrops.a).toBe("1000");
  });

  it("keeps everything at a full cut", () => {
    const s = splitFee("1000", 10000, [{ strategyId: "a", amount: 10 }]);
    expect(s.platformDrops).toBe("1000");
    expect(s.strategyDrops).toEqual({});
  });

  it("rejects a cut outside 0..100%", () => {
    expect(() => splitFee("1000", 10001, [])).toThrow(/0\.\.10000/);
    expect(() => splitFee("1000", -1, [])).toThrow(/0\.\.10000/);
  });
});

describe("RevenueLedger", () => {
  it("starts empty", () => {
    const l = new RevenueLedger(dir());
    expect(l.entries()).toEqual([]);
    expect(l.totals()).toEqual({ platformDrops: "0", strategyDrops: {} });
  });

  it("accumulates what each party has earned across calls", () => {
    const l = new RevenueLedger(dir());
    l.record({ ts: "t1", kind: "list", feeDrops: "10000", split: { platformDrops: "10000", strategyDrops: {} } });
    l.record({
      ts: "t2", kind: "allocate", planId: "pl_1", feeDrops: "500000",
      split: { platformDrops: "100000", strategyDrops: { alpha: "300000", beta: "100000" } },
    });
    expect(l.totals()).toEqual({
      platformDrops: "110000",
      strategyDrops: { alpha: "300000", beta: "100000" },
    });
  });

  it("survives a reload, since payouts happen later", () => {
    const d = dir();
    const a = new RevenueLedger(d);
    a.record({ ts: "t", kind: "list", feeDrops: "10000", split: { platformDrops: "10000", strategyDrops: {} } });
    expect(new RevenueLedger(d).totals().platformDrops).toBe("10000");
  });
});

describe("owed", () => {
  it("nets payouts against earnings", () => {
    const l = new RevenueLedger(dir());
    l.record({
      ts: "t", kind: "allocate", planId: "p", feeDrops: "500000",
      split: { platformDrops: "100000", strategyDrops: { alpha: "300000", beta: "100000" } },
    });
    l.settle("alpha", "300000", "HASH1");
    expect(l.owed()).toEqual({ beta: "100000" });
  });

  it("keeps a partial payout owing the remainder", () => {
    const l = new RevenueLedger(dir());
    l.record({
      ts: "t", kind: "allocate", planId: "p", feeDrops: "500000",
      split: { platformDrops: "0", strategyDrops: { alpha: "500000" } },
    });
    l.settle("alpha", "200000", "HASH1");
    expect(l.owed()).toEqual({ alpha: "300000" });
  });

  it("does not count settlements as new earnings", () => {
    const l = new RevenueLedger(dir());
    l.record({ ts: "t", kind: "list", feeDrops: "10000", split: { platformDrops: "10000", strategyDrops: {} } });
    l.settle("alpha", "1", "HASH");
    expect(l.totals().platformDrops).toBe("10000");
  });
});
