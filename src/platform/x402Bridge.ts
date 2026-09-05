import { randomBytes } from "node:crypto";
import {
  XRPLPresignedPaymentPayer,
  base64EncodeUtf8,
  defaultPaymentRequirementsSelector,
  jsonCanonicalStringify,
  paymentRequirementsFromWire,
} from "x402-xrpl";

/**
 * Bridges x402 for agents whose wallet can sign but not speak the protocol.
 *
 * The XRPL agent wallet skill signs a transaction it is handed and submits it;
 * x402 needs a Payment carrying the challenge's invoice id, signed but NOT
 * submitted, encoded into a PAYMENT-SIGNATURE header. That leaves a gap no
 * wallet fills. These two calls close it: the platform does every protocol
 * step, and the wallet is asked only to sign.
 */

export interface PreparedPayment {
  paymentId: string;
  /** Unsigned, autofilled Payment. Sign this and return the blob — do not submit it. */
  unsignedTx: Record<string, unknown>;
  invoiceId: string;
  amountDrops: string;
  payTo: string;
  network: string;
  expiresAt: string;
}

interface PendingPayment {
  resource: string;
  accepted: unknown;
  invoiceId: string;
  expiresAtMs: number;
}

/** Encodes a signed-but-unsubmitted payment into the header x402 expects. */
export function buildPaymentSignatureHeader(accepted: unknown, signedTxBlob: string, invoiceId: string): string {
  return base64EncodeUtf8(
    jsonCanonicalStringify({
      x402Version: 2,
      accepted,
      payload: { signedTxBlob, invoiceId },
    } as never),
  );
}

/** A wallet-shaped stub that captures the built transaction instead of signing. */
class CapturingWallet {
  captured?: Record<string, unknown>;
  constructor(readonly classicAddress: string) {}
  sign(tx: Record<string, unknown>) {
    this.captured = tx;
    // preparePayment rejects an empty blob, so hand back a placeholder it never uses.
    return { tx_blob: "UNSIGNED", hash: "" };
  }
}

export interface BridgeDeps {
  /** Overrides per x402 network id. Defaults follow x402-xrpl's own mapping. */
  wsUrlForNetwork?: (network: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a prepared payment stays claimable. */
  ttlMs?: number;
}

/**
 * x402 network ids, which do not read the way you would guess: in x402-xrpl
 * `xrpl:0` is mainnet and `xrpl:1` is testnet. The payment is autofilled on the
 * network the challenge names, which is independent of whichever ledger the
 * analysis engine happens to read.
 */
const DEFAULT_WS_FOR_NETWORK: Record<string, string> = {
  "xrpl:0": "wss://s1.ripple.com:51233",
  "xrpl:1": "wss://s.altnet.rippletest.net:51233",
  "xrpl:2": "wss://s.devnet.rippletest.net:51233",
};

export function wsUrlForNetwork(network: string, override?: BridgeDeps["wsUrlForNetwork"]): string {
  const chosen = override?.(network) ?? DEFAULT_WS_FOR_NETWORK[network];
  if (!chosen) throw new Error(`no XRPL endpoint known for payment network ${network}`);
  return chosen;
}

export class X402Bridge {
  private readonly pending = new Map<string, PendingPayment>();

  constructor(private readonly deps: BridgeDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sweep(): void {
    for (const [id, p] of this.pending) if (p.expiresAtMs <= this.now) this.pending.delete(id);
  }

  /** Fetches the 402 challenge and returns the exact transaction that satisfies it. */
  async prepare(resource: string, payer: string, body: unknown = {}): Promise<PreparedPayment> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(resource, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status !== 402) {
      throw new Error(`expected a 402 payment challenge from ${resource}, got ${res.status}`);
    }

    const challenge = (await res.json()) as { accepts?: unknown[] };
    const accepts = (challenge.accepts ?? []).filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null);
    if (accepts.length === 0) throw new Error("payment challenge carried no accepts entry");

    const selected = defaultPaymentRequirementsSelector(accepts as never, undefined, "exact", undefined);
    const requirements = paymentRequirementsFromWire(selected as never);

    // Drive the library's own builder so the invoice binding, memos, source tag
    // and ledger deadline are exactly what the facilitator will verify.
    const capturing = new CapturingWallet(payer);
    const payerImpl = new XRPLPresignedPaymentPayer({
      wallet: capturing as never,
      network: requirements.network as never,
      wsUrl: wsUrlForNetwork(String(requirements.network), this.deps.wsUrlForNetwork),
      invoiceBinding: "both",
    });
    const prepared = await payerImpl.preparePayment(requirements as never, undefined as never);
    const unsignedTx = capturing.captured;
    if (!unsignedTx) throw new Error("failed to capture the unsigned payment transaction");

    this.sweep();
    const paymentId = `pay_${randomBytes(6).toString("hex")}`;
    const ttlMs = this.deps.ttlMs ?? 10 * 60_000;
    const expiresAtMs = this.now + ttlMs;
    this.pending.set(paymentId, { resource, accepted: selected, invoiceId: prepared.invoiceId, expiresAtMs });

    return {
      paymentId,
      unsignedTx,
      invoiceId: prepared.invoiceId,
      amountDrops: String(requirements.amount),
      payTo: String(requirements.payTo),
      network: String(requirements.network),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /** Encodes the signed blob into a PAYMENT-SIGNATURE header and claims the resource. */
  async complete(paymentId: string, signedTxBlob: string, body: unknown = {}): Promise<unknown> {
    // The blob guard runs first: passing the placeholder back is a caller
    // mistake worth naming plainly, whatever state the paymentId is in.
    if (!signedTxBlob || signedTxBlob === "UNSIGNED") throw new Error("signedTxBlob is required — sign the unsignedTx without submitting it");
    this.sweep();
    const pendingPayment = this.pending.get(paymentId);
    if (!pendingPayment) throw new Error(`unknown or expired paymentId ${paymentId}; call prepare_payment again`);

    const header = buildPaymentSignatureHeader(pendingPayment.accepted, signedTxBlob, pendingPayment.invoiceId);

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(pendingPayment.resource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "PAYMENT-SIGNATURE": header,
      },
      body: JSON.stringify(body ?? {}),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`paid call failed with HTTP ${res.status}: ${text.slice(0, 400)}`);
    // One payment, one claim.
    this.pending.delete(paymentId);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
