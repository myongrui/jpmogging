import type { AuditRecord } from "../shared/types.js";

/** One event in the shape wire-console.html's MachineWire.push expects. */
export interface WireEvent {
  lane: "buyer" | "match" | "wire" | "sellers" | "ledger";
  kind?: string;
  title?: string;
  detail?: string;
  code?: number;
  body?: unknown;
  from?: string;
  to?: string;
  tx?: { type: string; amount?: string; hash: string; status: "pending" | "validated"; setup?: boolean };
  id?: string;
  status?: string;
  reason?: string;
  category?: string;
  band?: string;
  candidates?: unknown[];
}

const drops = (d: string) => `${Number(d) / 1_000_000} XRP`;

/**
 * Projects an audit run onto the console's five lanes. Every event here is
 * derived from something that actually happened, so a run with one payment and
 * no execution renders as exactly that rather than a scripted four-transaction
 * story.
 */
export function toWireEvents(records: AuditRecord[]): WireEvent[] {
  const out: WireEvent[] = [];

  for (const { event: e } of records) {
    switch (e.type) {
      case "mandate":
        out.push({ lane: "buyer", kind: "reason", title: "Read mandate", detail: `${e.mandate.amount} ${e.mandate.asset}, risk <= ${e.mandate.maximum_risk_score}, liquidity >= ${Math.round(e.mandate.minimum_liquidity * 100)}%` });
        break;
      case "discovery":
        out.push({ lane: "buyer", kind: "reason", title: "Discovered tools", detail: e.tools.join(", ") });
        break;
      case "match":
        out.push({ lane: "wire", kind: "response", from: "platform", to: "buyer", code: 200, title: "Match", body: { seller: e.seller, endpoint: e.endpoint, rating: e.rating, reason: e.reason } });
        break;
      case "tool_call":
        out.push({ lane: "wire", kind: "request", from: "buyer", to: "seller", title: `${e.name}()`, body: e.args });
        break;
      case "tool_result":
        out.push({ lane: "wire", kind: "response", from: "seller", to: "buyer", code: 200, title: `${e.name} returned` });
        break;
      case "payment_required":
        out.push({ lane: "wire", kind: "response", from: "seller", to: "buyer", code: 402, title: "Payment required", detail: `${drops(e.amountDrops)} to ${e.payTo}`, body: { price: drops(e.amountDrops), pay_to: e.payTo, network: e.network } });
        break;
      case "payment_settled":
        out.push({ lane: "wire", kind: "payment", from: "buyer", to: "seller", title: `Payment ${drops(e.amountDrops)}`, detail: e.transaction });
        out.push({ lane: "ledger", tx: { type: "Payment", amount: drops(e.amountDrops), hash: e.transaction, status: "validated" } });
        break;
      case "payment_declined":
        out.push({ lane: "buyer", kind: "refusal", title: "Declined to pay", detail: e.reason });
        break;
      case "result":
        out.push({ lane: "wire", kind: "response", from: "seller", to: "buyer", code: 200, title: "Analysis delivered", body: { recommendation: e.result.recommendation, expected_apy: e.result.expected_apy, portfolio_risk_score: e.result.portfolio_risk_score } });
        break;
      case "plan_received":
        out.push({ lane: "buyer", kind: "reason", title: `Plan ${e.planId} received`, detail: `${e.legs} leg(s), ${e.deployed} deployed, ${e.reserve} held liquid` });
        break;
      case "plan_rejected":
        out.push({ lane: "buyer", kind: "refusal", title: `Plan ${e.planId} rejected`, detail: e.violations.join("; ") });
        break;
      case "leg_submitted":
        out.push({ lane: "buyer", kind: "reason", title: `Leg ${e.seq}: ${e.kind}`, detail: e.description });
        out.push({ lane: "ledger", tx: { type: e.kind, hash: `pending-${e.planId}-${e.seq}`, status: "pending" } });
        break;
      case "leg_validated":
        out.push({ lane: "ledger", tx: { type: "validated", hash: e.transaction, status: "validated" } });
        break;
      case "leg_failed":
        out.push({ lane: "wire", kind: "response", from: "seller", to: "buyer", code: 422, title: `Leg ${e.seq} failed`, body: { venue: e.venue, reason: e.reason } });
        break;
      case "leg_compensated":
        out.push({ lane: "buyer", kind: e.ok ? "reason" : "refusal", title: `Leg ${e.seq} ${e.ok ? "unwound" : "unwind failed"}`, detail: e.reason });
        break;
      case "plan_executed":
        out.push({ lane: "buyer", kind: e.status === "settled" ? "done" : "refusal", title: `Execution ${e.status}`, detail: `${e.validated} of ${e.legs} legs validated` });
        break;
      case "decision":
        out.push({ lane: "buyer", kind: "done", title: e.action, detail: e.rationale });
        break;
      case "error":
        out.push({ lane: "wire", kind: "response", code: 500, title: "Error", body: { message: e.message } });
        break;
    }
  }

  return out;
}
