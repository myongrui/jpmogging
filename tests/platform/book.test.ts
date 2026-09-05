import { describe, expect, it } from "vitest";
import { CapacityBook } from "../../src/platform/book.js";
import type { StrategyProfile } from "../../src/platform/strategy.js";

const profile: StrategyProfile = {
  id: "alpha", name: "Alpha Deep LP", family: "amm_lp",
  headlineApy: 0.05, capacity: 100000,
  riskScore: 22, exitHours: 1, maxPoolRisk: 40, payoutAddress: "rAuthor", requires: ["AMM"],
};

describe("CapacityBook", () => {
  it("starts empty and advertises the full headline rate", () => {
    const q = new CapacityBook(profile).quote();
    expect(q).toMatchObject({ deployed: 0, remaining: 100000, marginalApy: 0.05 });
  });

  it("shrinks remaining capacity as plans commit capital", () => {
    const book = new CapacityBook(profile);
    book.commit("pl_1", 60000);
    expect(book.quote()).toMatchObject({ deployed: 60000, remaining: 40000, marginalApy: 0.05 });
  });

  it("stops advertising a rate once it is full", () => {
    const book = new CapacityBook(profile);
    book.commit("pl_1", 100000);
    expect(book.quote()).toMatchObject({ deployed: 100000, remaining: 0, marginalApy: 0 });
  });

  it("ignores a repeated commit of the same plan", () => {
    const book = new CapacityBook(profile);
    book.commit("pl_1", 40000);
    book.commit("pl_1", 40000);
    expect(book.deployed).toBe(40000);
  });

  it("frees capacity when a plan is released", () => {
    const book = new CapacityBook(profile);
    book.commit("pl_1", 40000);
    book.release("pl_1", 40000);
    expect(book.quote()).toMatchObject({ deployed: 0, remaining: 100000 });
  });

  it("never reports negative capital", () => {
    const book = new CapacityBook(profile);
    book.commit("pl_1", 10000);
    book.release("pl_1", 999999);
    expect(book.deployed).toBe(0);
  });

  it("stamps each quote so a stale one is visible", () => {
    const q = new CapacityBook(profile).quote(new Date("2026-09-05T12:00:00.000Z"));
    expect(q.quotedAt).toBe("2026-09-05T12:00:00.000Z");
  });
});
