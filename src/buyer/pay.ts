import type { Wallet } from "xrpl";
import { defaultPaymentRequirementsSelector, x402Purchase } from "x402-xrpl";
import type { AuditLog } from "../shared/audit.js";
import { explorerTxUrl } from "../shared/types.js";
import type { SpendTracker } from "./spendPolicy.js";

export interface PayDeps {
  wallet: Wallet;
  network: string;
  tracker: SpendTracker;
  audit: AuditLog;
  purchase?: typeof x402Purchase;
}

export type PayOutcome =
  | { status: "paid"; transaction: string; payer: string; explorer: string; body: unknown }
  | { status: "declined"; reason: string }
  | { status: "failed"; reason: string };

class SpendDeclined extends Error {}

export async function payForResource(deps: PayDeps, input: { resource: string; body: unknown }): Promise<PayOutcome> {
  const purchase = deps.purchase ?? x402Purchase;
  let amountDrops = "0";

  const paymentRequirementsSelector: typeof defaultPaymentRequirementsSelector = (accepts, networkFilter, schemeFilter, maxValue) => {
    const selected = defaultPaymentRequirementsSelector(accepts, networkFilter, schemeFilter, maxValue);
    amountDrops = String(selected.amount);
    deps.audit.append({
      type: "payment_required",
      resource: input.resource,
      amountDrops,
      asset: String(selected.asset),
      network: String(selected.network),
      payTo: String(selected.payTo),
    });
    const verdict = deps.tracker.authorize(amountDrops);
    if (!verdict.ok) throw new SpendDeclined(verdict.reason);
    return selected;
  };

  try {
    const result = await purchase({
      url: input.resource,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input.body),
      wallet: deps.wallet,
      network: deps.network as "xrpl:1" | "xrpl:0",
      paymentRequirementsSelector,
    });
    if (result.status !== "success" || !result.response || !result.transaction) {
      deps.audit.append({ type: "error", message: `payment ${result.status}: ${result.reason ?? "unknown"}` });
      return { status: "failed", reason: result.reason ?? result.status };
    }
    deps.tracker.record(amountDrops);
    const explorer = explorerTxUrl(result.transaction);
    deps.audit.append({
      type: "payment_settled",
      transaction: result.transaction,
      payer: result.payer ?? deps.wallet.classicAddress,
      amountDrops,
      network: result.network ?? deps.network,
      explorer,
    });
    return { status: "paid", transaction: result.transaction, payer: result.payer ?? deps.wallet.classicAddress, explorer, body: await result.response.json() };
  } catch (err) {
    if (err instanceof SpendDeclined) {
      deps.audit.append({ type: "payment_declined", resource: input.resource, reason: err.message });
      return { status: "declined", reason: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.audit.append({ type: "error", message });
    return { status: "failed", reason: message };
  }
}
