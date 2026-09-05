import { describe, expect, it } from "vitest";
import { X402Bridge, buildPaymentSignatureHeader, wsUrlForNetwork } from "../../src/platform/x402Bridge.js";

const challenge = (accepts: unknown[]) =>
  new Response(JSON.stringify({ x402Version: 2, error: "PAYMENT-SIGNATURE header is required", accepts }), { status: 402 });

describe("wsUrlForNetwork", () => {
  it("maps x402 network ids, where xrpl:1 is testnet and xrpl:0 is mainnet", () => {
    expect(wsUrlForNetwork("xrpl:0")).toBe("wss://s1.ripple.com:51233");
    expect(wsUrlForNetwork("xrpl:1")).toBe("wss://s.altnet.rippletest.net:51233");
    expect(wsUrlForNetwork("xrpl:2")).toBe("wss://s.devnet.rippletest.net:51233");
  });

  it("takes an override, and falls back when the override declines", () => {
    expect(wsUrlForNetwork("xrpl:1", () => "wss://custom:51233")).toBe("wss://custom:51233");
    expect(wsUrlForNetwork("xrpl:1", () => undefined)).toBe("wss://s.altnet.rippletest.net:51233");
  });

  it("refuses a network it has no endpoint for", () => {
    expect(() => wsUrlForNetwork("solana:1")).toThrow(/no XRPL endpoint known/);
  });
});

describe("buildPaymentSignatureHeader", () => {
  it("encodes the x402 v2 payload the facilitator expects", () => {
    const accepted = { scheme: "exact", network: "xrpl:1", amount: "10000", payTo: "rSeller" };
    const header = buildPaymentSignatureHeader(accepted, "BLOB", "INV1");
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded).toEqual({
      x402Version: 2,
      accepted,
      payload: { signedTxBlob: "BLOB", invoiceId: "INV1" },
    });
  });
});

describe("X402Bridge.prepare", () => {
  it("refuses a resource that is not asking for payment", async () => {
    const bridge = new X402Bridge({ fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    await expect(bridge.prepare("http://x/api", "rPayer")).rejects.toThrow(/expected a 402 payment challenge/);
  });

  it("refuses a challenge with no accepts entry", async () => {
    const bridge = new X402Bridge({ fetchImpl: (async () => challenge([])) as typeof fetch });
    await expect(bridge.prepare("http://x/api", "rPayer")).rejects.toThrow(/no accepts entry/);
  });
});

describe("X402Bridge.complete", () => {
  const bridge = () => new X402Bridge({ fetchImpl: (async () => new Response("{}")) as typeof fetch });

  it("rejects an unknown paymentId", async () => {
    await expect(bridge().complete("pay_nope", "BLOB")).rejects.toThrow(/unknown or expired paymentId/);
  });

  it("rejects the placeholder blob, so an unsigned transaction cannot be submitted by mistake", async () => {
    await expect(bridge().complete("pay_x", "UNSIGNED")).rejects.toThrow(/signedTxBlob is required/);
  });

  it("rejects an empty blob", async () => {
    await expect(bridge().complete("pay_x", "")).rejects.toThrow(/signedTxBlob is required/);
  });
});
