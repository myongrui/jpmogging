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
  data: { ledger_index: number; rlusd_per_xrp: number; sampled_at: string };
  timestamp: string;
  valid_until: string;
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
  | { type: "payment_settled"; transaction: string; payer: string; amountDrops: string; network: string; explorer: string }
  | { type: "payment_declined"; resource: string; reason: string }
  | { type: "result"; result: AllocationResult }
  | { type: "decision"; action: string; rationale: string }
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
