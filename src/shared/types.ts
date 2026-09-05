import type { ExecutionPlan } from "./plan.js";

export interface Mandate {
  asset: "RLUSD";
  amount: number;
  horizon_hours: number;
  minimum_liquidity: number;
  maximum_risk_score: number;
  maximum_protocol_allocation: number;
}

export interface PoolSnapshot {
  ammAccount: string;
  pairLabel: string;
  asset2Currency: string;
  asset2Issuer: string;
  asset2Name: string | null;
  issuerVerified: boolean;
  xrpBalanceDrops: string;
  asset2Value: string;
  tradingFee: number;
  frozen: boolean;
}

export interface PoolMetrics extends PoolSnapshot {
  tvlXrp: number;
  volumeXrpPerDay: number;
  feeApy: number;
  riskScore: number;
  liquidityScore: number;
  riskAdjustedScore: number;
}

export interface AllocationLine {
  ammAccount: string;
  pairLabel: string;
  weight: number;
  amount: number;
  feeApy: number;
  riskScore: number;
  liquidityScore: number;
}

export interface AllocationResult {
  recommendation: string;
  allocations: AllocationLine[];
  liquid_reserve: { weight: number; amount: number };
  expected_apy: number;
  portfolio_risk_score: number;
  portfolio_liquidity_score: number;
  reasoning: string;
  opportunities_considered: number;
  data: { ledger_index: number; rlusd_per_xrp: number; sampled_at: string; rate_source?: string };
  timestamp: string;
  valid_until: string;
  /** Unsigned execution plan, present when the engine can build one. */
  plan?: ExecutionPlan;
}

export interface Opportunity {
  ammAccount: string;
  pairLabel: string;
  tvlXrp: number;
  tradingFeeBps: number;
}

export type AuditEvent =
  | { type: "mandate"; mandate: Mandate }
  | { type: "discovery"; tools: string[] }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "payment_required"; resource: string; amountDrops: string; asset: string; network: string; payTo: string }
  | { type: "payment_settled"; transaction: string; payer: string; amountDrops: string; network: string; explorer: string; payTo: string }
  | { type: "payment_declined"; resource: string; reason: string }
  | { type: "result"; result: AllocationResult }
  | { type: "decision"; action: string; rationale: string }
  | { type: "match"; seller: string; endpoint: string; rating: string; reason: string; evaluated: number }
  | { type: "plan_received"; planId: string; legs: number; deployed: number; reserve: number }
  | { type: "plan_rejected"; planId: string; violations: string[] }
  | { type: "leg_submitted"; planId: string; seq: number; venue: string; kind: string; description: string }
  | { type: "leg_validated"; planId: string; seq: number; venue: string; transaction: string; explorer: string }
  | { type: "leg_failed"; planId: string; seq: number; venue: string; reason: string }
  | { type: "leg_compensated"; planId: string; seq: number; venue: string; ok: boolean; transaction?: string; reason?: string }
  | { type: "plan_executed"; planId: string; status: string; legs: number; validated: number }
  | { type: "error"; message: string };

export interface AuditRecord {
  runId: string;
  seq: number;
  ts: string;
  event: AuditEvent;
}

export const EXPLORER_TX_URL = "https://testnet.xrpl.org/transactions";

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_TX_URL}/${hash}`;
}
