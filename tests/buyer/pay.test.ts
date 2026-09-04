import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { describe, expect, it } from "vitest";
import { payForResource } from "../../src/buyer/pay.js";
import { SpendTracker } from "../../src/buyer/spendPolicy.js";
import { AuditLog, readRun } from "../../src/shared/audit.js";

const wallet = Wallet.generate();
const accepts = [{ scheme: "exact", network: "xrpl:1", asset: "XRP", amount: "500000", payTo: "rSeller", maxTimeoutSeconds: 600, extra: { invoiceId: "INV-1" } }];

function setup(maxPerRequest = 1_000_000n) {
  const dir = mkdtempSync(join(tmpdir(), "pay-"));
  const audit = new AuditLog(dir, "run");
  const tracker = new SpendTracker({ maxDropsPerRequest: maxPerRequest, maxDropsPerSession: 3_000_000n });
  return { dir, audit, tracker };
}

describe("payForResource", () => {
  it("pays, records settlement and returns the resource body", async () => {
    const { dir, audit, tracker } = setup();
    const purchase = (async (opts: any) => {
      const selected = opts.paymentRequirementsSelector(accepts, "xrpl:1", "exact", opts.maxValue);
      expect(selected.amount).toBe("500000");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ amount: 1 });
      return { status: "success", transaction: "TXHASH", payer: wallet.classicAddress, network: "xrpl:1", response: new Response(JSON.stringify({ recommendation: "ok" })) };
    }) as any;

    const out = await payForResource({ wallet, network: "xrpl:1", tracker, audit, purchase }, { resource: "http://s/api/x", body: { amount: 1 } });
    expect(out).toEqual({ status: "paid", transaction: "TXHASH", payer: wallet.classicAddress, explorer: "https://testnet.xrpl.org/transactions/TXHASH", body: { recommendation: "ok" } });
    expect(tracker.spentDrops).toBe(500_000n);
    expect(readRun(dir, "run").map((r) => r.event.type)).toEqual(["payment_required", "payment_settled"]);
  });

  it("declines before signing when the policy is exceeded", async () => {
    const { dir, audit, tracker } = setup(100n);
    const purchase = (async (opts: any) => {
      try {
        opts.paymentRequirementsSelector(accepts, "xrpl:1", "exact", opts.maxValue);
      } catch (err) {
        return { status: "payment_required", reason: (err as Error).message };
      }
      throw new Error("selector should have thrown first");
    }) as any;

    const out = await payForResource({ wallet, network: "xrpl:1", tracker, audit, purchase }, { resource: "http://s/api/x", body: {} });
    expect(out).toEqual({ status: "declined", reason: "500000 drops exceeds per-request limit of 100 drops" });
    expect(tracker.spentDrops).toBe(0n);
    expect(readRun(dir, "run").map((r) => r.event.type)).toEqual(["payment_required", "payment_declined"]);
  });

  it("reports facilitator failures", async () => {
    const { dir, audit, tracker } = setup();
    const purchase = (async () => ({ status: "failed", reason: "settle rejected" })) as any;
    const out = await payForResource({ wallet, network: "xrpl:1", tracker, audit, purchase }, { resource: "http://s/api/x", body: {} });
    expect(out).toEqual({ status: "failed", reason: "settle rejected" });
    expect(readRun(dir, "run").at(-1)?.event.type).toBe("error");
  });

  it("returns paid with the raw text when the body is not JSON", async () => {
    const { dir, audit, tracker } = setup();
    const purchase = (async (opts: any) => {
      opts.paymentRequirementsSelector(accepts, "xrpl:1", "exact", opts.maxValue);
      return { status: "success", transaction: "TX2", payer: wallet.classicAddress, network: "xrpl:1", response: new Response("not json") };
    }) as any;

    const out = await payForResource({ wallet, network: "xrpl:1", tracker, audit, purchase }, { resource: "http://s/api/x", body: {} });
    expect(out).toEqual({ status: "paid", transaction: "TX2", payer: wallet.classicAddress, explorer: "https://testnet.xrpl.org/transactions/TX2", body: "not json" });
    expect(tracker.spentDrops).toBe(500_000n);
    expect(readRun(dir, "run").map((r) => r.event.type)).toEqual(["payment_required", "payment_settled"]);
  });
});
