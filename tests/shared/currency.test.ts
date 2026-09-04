import { describe, expect, it } from "vitest";
import { displayCurrency } from "../../src/shared/currency.js";

describe("displayCurrency", () => {
  it("returns 3-char codes unchanged", () => {
    expect(displayCurrency("USD")).toBe("USD");
    expect(displayCurrency("XRP")).toBe("XRP");
  });

  it("decodes 40-hex ASCII codes", () => {
    expect(displayCurrency("524C555344000000000000000000000000000000")).toBe("RLUSD");
    expect(displayCurrency("5553444300000000000000000000000000000000")).toBe("USDC");
  });

  it("falls back to the raw code when hex is not printable", () => {
    expect(displayCurrency("03B245BE580EC4F4386A751C084489EC4B514A2F")).toBe("03B245BE580EC4F4386A751C084489EC4B514A2F");
  });
});
