import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MANDATE_SHAPE } from "../shared/mandate.js";
import type { Mandate } from "../shared/types.js";
import type { MarketplacePlan } from "./marketplacePlan.js";
import type { Orchestration } from "./orchestrate.js";
import type { StrategyQuote } from "./strategy.js";
import type { PreparedPayment } from "./x402Bridge.js";

export interface PlatformConfig {
  payTo: string;
  network: string;
  facilitatorUrl: string;
  /** Fee for a full allocation. */
  priceDrops: string;
  /** Fee for listing strategies with live capacity. */
  listPriceDrops: string;
  /** Basis points of every fee the platform keeps before paying strategy authors. */
  cutBps: number;
  baseUrl: string;
}

export interface AllocationResponse extends Orchestration, MarketplacePlan {}

export interface PlatformEngine {
  /** Live rate and remaining capacity for every listed strategy. */
  quotes(): StrategyQuote[];
  allocate(mandate: Mandate): Promise<AllocationResponse>;
  /** False while market data is cold and no allocation can be produced. */
  ready(): boolean;
  /** Books a listing fee once payment has settled. */
  recordListingFee(): void;
  /** Turns a 402 challenge into a transaction a wallet can sign. */
  preparePayment(resource: string, payer: string, body?: unknown): Promise<PreparedPayment>;
  /** Claims the paid resource with a signed, unsubmitted payment. */
  completePayment(paymentId: string, signedTxBlob: string, body?: unknown): Promise<unknown>;
}

export const ALLOCATE_DESCRIPTION = "Capacity-aware allocation across listed strategies, with signable XRPL transactions";
export const ALLOCATE_PATH = "/api/allocate";
export const LIST_DESCRIPTION = "Live strategy listing with current APY and remaining capacity";
export const LIST_PATH = "/api/strategies";

export interface PaymentRequiredEnvelope {
  status: "payment_required";
  resource: string;
  method: "POST";
  price_drops: string;
  asset: "XRP";
  network: string;
  pay_to: string;
  description: string;
  input?: Mandate;
  /** Present when a payer address was supplied: sign this, then call complete_payment. */
  paymentId?: string;
  unsignedTx?: Record<string, unknown>;
  next_step?: string;
}

const SIGN_THEN_COMPLETE =
  "Sign unsignedTx with your wallet WITHOUT submitting it, then call complete_payment with this paymentId and the signed transaction blob. Submitting it yourself spends the XRP without paying for the resource.";
const PASS_PAYER =
  "Call this tool again with your XRPL classic address in `payer` to receive a ready-to-sign payment transaction in the same response.";

/** Attaches a signable payment to the envelope when the caller named a payer. */
async function withPayment(
  engine: PlatformEngine,
  envelope: PaymentRequiredEnvelope,
  payer: string | undefined,
  body: unknown,
): Promise<PaymentRequiredEnvelope> {
  if (!payer) return { ...envelope, next_step: PASS_PAYER };
  const prepared = await engine.preparePayment(envelope.resource, payer, body);
  return {
    ...envelope,
    paymentId: prepared.paymentId,
    unsignedTx: prepared.unsignedTx,
    next_step: SIGN_THEN_COMPLETE,
  };
}

export function buildPlatformMcpServer(cfg: PlatformConfig, engine: PlatformEngine): McpServer {
  const server = new McpServer({ name: "xrpl-fi-platform", version: "0.2.0" });

  server.registerTool(
    "list_strategies",
    {
      description: `Paid: ${cfg.listPriceDrops} drops of XRP per call via x402 on ${cfg.network}. Lists every strategy with its current headline APY, total capacity, capital already committed, the rate the next unit of capital would earn, risk score, pool risk ceiling and exit time. Figures move as strategies fill, so this is a snapshot rather than a promise. Pass your XRPL address as \`payer\` and the response carries a ready-to-sign payment transaction: sign it without submitting, then call complete_payment.`,
      inputSchema: {
        payer: z.string().optional().describe("Your XRPL classic address, to receive a ready-to-sign payment in this response"),
      },
    },
    async ({ payer }) => {
      const envelope: PaymentRequiredEnvelope = {
        status: "payment_required",
        resource: `${cfg.baseUrl}${LIST_PATH}`,
        method: "POST",
        price_drops: cfg.listPriceDrops,
        asset: "XRP",
        network: cfg.network,
        pay_to: cfg.payTo,
        description: LIST_DESCRIPTION,
      };
      return { content: [{ type: "text", text: JSON.stringify(await withPayment(engine, envelope, payer, {})) }] };
    },
  );

  server.registerTool(
    "allocate",
    {
      description: `Paid: ${cfg.priceDrops} drops of XRP per call via x402 on ${cfg.network}. Splits a mandate across strategies by marginal yield — filling the highest-paying strategy to its capacity before moving to the next — subject to the mandate's risk ceiling, liquidity floor and concentration cap. Returns the split, the reason every rejected strategy lost, and unsigned XRPL transactions ready for a wallet to sign. Pass your XRPL address as \`payer\` and the response carries a ready-to-sign payment transaction: sign it without submitting, then call complete_payment.`,
      inputSchema: { ...MANDATE_SHAPE, payer: z.string().optional().describe("Your XRPL classic address, to receive a ready-to-sign payment in this response") },
    },
    async ({ payer, ...mandate }: Mandate & { payer?: string }) => {
      const envelope: PaymentRequiredEnvelope = {
        status: "payment_required",
        resource: `${cfg.baseUrl}${ALLOCATE_PATH}`,
        method: "POST",
        price_drops: cfg.priceDrops,
        asset: "XRP",
        network: cfg.network,
        pay_to: cfg.payTo,
        description: ALLOCATE_DESCRIPTION,
        input: mandate,
      };
      return { content: [{ type: "text", text: JSON.stringify(await withPayment(engine, envelope, payer, mandate)) }] };
    },
  );

  server.registerTool(
    "prepare_payment",
    {
      description:
        "Free. Escape hatch: normally you do not need this, because list_strategies and allocate already return a ready-to-sign payment when you pass `payer`. Use it only for a resource reached some other way. Give it the resource URL and your XRPL address; it returns an unsigned, autofilled Payment carrying the challenge's invoice id, source tag and ledger deadline. SIGN IT BUT DO NOT SUBMIT IT, then pass the signed blob to complete_payment.",
      inputSchema: {
        resource: z.string().describe("Resource URL from the payment_required envelope"),
        payer: z.string().describe("Your XRPL classic address, which pays and signs"),
        body: z.record(z.string(), z.unknown()).optional().describe("The exact input echoed in the envelope, if any"),
      },
    },
    async ({ resource, payer, body }) => {
      const prepared = await engine.preparePayment(resource, payer, body ?? {});
      return { content: [{ type: "text", text: JSON.stringify(prepared) }] };
    },
  );

  server.registerTool(
    "complete_payment",
    {
      description:
        "Free. Claims a paid resource with a payment you signed but did not submit. Give it the paymentId from prepare_payment and the signed transaction blob; it builds the PAYMENT-SIGNATURE header, settles through the facilitator and returns the resource content. A paymentId can be claimed once and expires ten minutes after it is prepared.",
      inputSchema: {
        paymentId: z.string().describe("The paymentId returned by prepare_payment"),
        signedTxBlob: z.string().describe("Signed transaction blob (tx_blob) — signed, not submitted"),
        body: z.record(z.string(), z.unknown()).optional().describe("The same input passed to prepare_payment"),
      },
    },
    async ({ paymentId, signedTxBlob, body }) => {
      const result = await engine.completePayment(paymentId, signedTxBlob, body ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
