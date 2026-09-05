import { describe, expect, it } from "vitest";
import { toWireEvents } from "../../src/dashboard/wire.js";
import type { AuditEvent, AuditRecord } from "../../src/shared/types.js";

const rec = (event: AuditEvent, seq = 1): AuditRecord => ({ runId: "r", seq, ts: "2026-09-05T00:00:00Z", event });

describe("toWireEvents", () => {
  it("routes a settled payment to both the wire and the ledger lane", () => {
    const events = toWireEvents([
      rec({ type: "payment_settled", transaction: "ABC", payer: "rP", amountDrops: "500000", network: "xrpl:0", explorer: "e", payTo: "rS" }),
    ]);
    expect(events.map((e) => e.lane)).toEqual(["wire", "ledger"]);
    expect(events[1].tx).toEqual({ type: "Payment", amount: "0.5 XRP", hash: "ABC", status: "validated" });
  });

  it("renders a 402 as a payment-required response", () => {
    const [e] = toWireEvents([
      rec({ type: "payment_required", resource: "u", amountDrops: "100000", asset: "XRP", network: "xrpl:0", payTo: "rS" }),
    ]);
    expect(e).toMatchObject({ lane: "wire", code: 402, detail: "0.1 XRP to rS" });
  });

  it("surfaces a rejected plan as a buyer refusal carrying the violations", () => {
    const [e] = toWireEvents([rec({ type: "plan_rejected", planId: "pl_1", violations: ["cap exceeded", "expired"] })]);
    expect(e).toMatchObject({ lane: "buyer", kind: "refusal" });
    expect(e.detail).toBe("cap exceeded; expired");
  });

  it("emits a pending ledger row on submit and a validated one on confirmation", () => {
    const events = toWireEvents([
      rec({ type: "leg_submitted", planId: "pl_1", seq: 1, venue: "amm:rA", kind: "deposit", description: "d" }),
      rec({ type: "leg_validated", planId: "pl_1", seq: 1, venue: "amm:rA", transaction: "H1", explorer: "e" }, 2),
    ]);
    const ledger = events.filter((e) => e.lane === "ledger");
    expect(ledger.map((e) => e.tx!.status)).toEqual(["pending", "validated"]);
  });

  it("produces nothing for a run with no events", () => {
    expect(toWireEvents([])).toEqual([]);
  });
});
