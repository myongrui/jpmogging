import type { Wallet } from "xrpl";
import type { AuditLog } from "../shared/audit.js";
import { planLegTag, type ExecutionPlan, type PlanLeg, type UnsignedTx } from "../shared/plan.js";
import { explorerTxUrl } from "../shared/types.js";
import { readAmendments } from "./amendments.js";

/** Ledgers of headroom before a submitted leg is allowed to expire. */
const LEDGER_WINDOW = 20;

export type XrplClient = {
  request(req: any): Promise<any>;
  autofill(tx: any): Promise<any>;
  submitAndWait(txBlob: string): Promise<any>;
};

export interface ExecuteDeps {
  client: XrplClient;
  wallet: Wallet;
  audit: AuditLog;
  /** What to do with completed legs when a later one fails. */
  onFailure?: "unwind" | "hold";
  log?: (line: string) => void;
}

export type LegStatus = "validated" | "failed" | "skipped" | "compensated" | "compensation_failed";

export interface LegReport {
  seq: number;
  venue: string;
  kind: string;
  status: LegStatus;
  hash?: string;
  explorer?: string;
  engineResult?: string;
  message?: string;
}

export interface ExecutionReport {
  planId: string;
  /**
   * settled  — every leg validated.
   * partial  — a leg failed and capital is still deployed, either because the
   *            policy was to hold or because a compensation itself failed.
   * unwound  — a leg failed and everything that had settled was rolled back.
   * failed   — nothing settled.
   */
  status: "settled" | "partial" | "unwound" | "failed";
  legs: LegReport[];
  validatedHashes: string[];
}

function hexMemo(text: string): string {
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
}

/** Stamps the plan tag into the memo so a crashed run can reconcile via account_tx. */
function withEnvelope(tx: UnsignedTx, ctx: { account: string; sequence: number; lastLedger: number; tag: string }): UnsignedTx {
  return {
    ...tx,
    Account: ctx.account,
    Sequence: ctx.sequence,
    LastLedgerSequence: ctx.lastLedger,
    Memos: [{ Memo: { MemoType: hexMemo("xrpl-fi/plan"), MemoData: hexMemo(ctx.tag) } }],
  };
}

async function currentLedger(client: XrplClient): Promise<number> {
  const { result } = await client.request({ command: "ledger", ledger_index: "validated" });
  return Number(result.ledger_index ?? result.ledger?.ledger_index);
}

async function accountSequence(client: XrplClient, account: string): Promise<number> {
  const { result } = await client.request({ command: "account_info", account, ledger_index: "validated" });
  return Number(result.account_data.Sequence);
}

/** Hashes already on-ledger for this plan, so a resumed run never double-submits. */
export async function completedLegTags(client: XrplClient, account: string, planId: string): Promise<Set<string>> {
  const { result } = await client.request({
    command: "account_tx",
    account,
    limit: 200,
    ledger_index_min: -1,
    ledger_index_max: -1,
  });
  const tags = new Set<string>();
  for (const entry of result.transactions ?? []) {
    const tx = entry.tx_json ?? entry.tx;
    for (const m of tx?.Memos ?? []) {
      const data = m?.Memo?.MemoData;
      if (typeof data !== "string") continue;
      const text = Buffer.from(data, "hex").toString("utf8");
      if (text.startsWith(`${planId}:`)) tags.add(text);
    }
  }
  return tags;
}

async function submitOne(
  deps: ExecuteDeps,
  tx: UnsignedTx,
): Promise<{ ok: boolean; hash?: string; engineResult?: string; message?: string }> {
  try {
    const prepared = await deps.client.autofill(tx as any);
    const signed = deps.wallet.sign(prepared);
    const res = await deps.client.submitAndWait(signed.tx_blob);
    const engineResult = res.result?.meta?.TransactionResult ?? res.result?.engine_result;
    const validated = res.result?.validated === true;
    const hash = res.result?.hash ?? signed.hash;
    if (engineResult !== "tesSUCCESS") return { ok: false, hash, engineResult, message: `engine result ${engineResult}` };
    if (!validated) return { ok: false, hash, engineResult, message: "transaction not validated" };
    return { ok: true, hash, engineResult };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs a plan leg by leg. Sequence numbers are assigned explicitly rather than
 * left to autofill, because concurrent autofill races produce tefPAST_SEQ; every
 * leg is bounded by LastLedgerSequence so a stuck submission fails definitively
 * instead of hanging in an unknown state.
 */
export async function executePlan(deps: ExecuteDeps, plan: ExecutionPlan): Promise<ExecutionReport> {
  const log = deps.log ?? (() => {});
  const account = deps.wallet.classicAddress;
  const already = await completedLegTags(deps.client, account, plan.planId);
  let sequence = await accountSequence(deps.client, account);
  const lastLedger = (await currentLedger(deps.client)) + LEDGER_WINDOW;

  const reports: LegReport[] = [];
  const done: PlanLeg[] = [];
  let failed = false;

  for (const leg of plan.legs) {
    const tag = planLegTag(plan.planId, leg.seq);
    if (already.has(tag)) {
      log(`leg ${leg.seq} already on ledger, skipping`);
      reports.push({ seq: leg.seq, venue: leg.venue, kind: leg.kind, status: "skipped", message: "already settled" });
      done.push(leg);
      continue;
    }

    deps.audit.append({ type: "leg_submitted", planId: plan.planId, seq: leg.seq, venue: leg.venue, kind: leg.kind, description: leg.description });
    log(`leg ${leg.seq}: ${leg.description}`);

    const tx = withEnvelope(leg.tx, { account, sequence, lastLedger, tag });
    const out = await submitOne(deps, tx);
    sequence += 1;

    if (!out.ok) {
      failed = true;
      deps.audit.append({ type: "leg_failed", planId: plan.planId, seq: leg.seq, venue: leg.venue, reason: out.message ?? "unknown" });
      reports.push({ seq: leg.seq, venue: leg.venue, kind: leg.kind, status: "failed", hash: out.hash, engineResult: out.engineResult, message: out.message });
      break;
    }

    deps.audit.append({
      type: "leg_validated",
      planId: plan.planId,
      seq: leg.seq,
      venue: leg.venue,
      transaction: out.hash!,
      explorer: explorerTxUrl(out.hash!),
    });
    reports.push({ seq: leg.seq, venue: leg.venue, kind: leg.kind, status: "validated", hash: out.hash, explorer: explorerTxUrl(out.hash!), engineResult: out.engineResult });
    done.push(leg);
  }

  if (failed && (deps.onFailure ?? "unwind") === "unwind") {
    for (const leg of [...done].reverse()) {
      if (!leg.compensate) continue;
      const tag = planLegTag(plan.planId, leg.seq);
      log(`compensating leg ${leg.seq}`);
      const tx = withEnvelope(leg.compensate, { account, sequence, lastLedger, tag: `${tag}:undo` });
      const out = await submitOne(deps, tx);
      sequence += 1;
      const status: LegStatus = out.ok ? "compensated" : "compensation_failed";
      deps.audit.append({
        type: "leg_compensated",
        planId: plan.planId,
        seq: leg.seq,
        venue: leg.venue,
        ok: out.ok,
        transaction: out.hash,
        reason: out.message,
      });
      const existing = reports.find((r) => r.seq === leg.seq);
      if (existing) existing.status = status;
    }
  }

  const validatedHashes = reports.filter((r) => r.status === "validated" && r.hash).map((r) => r.hash!);
  const residue = reports.some((r) => r.status === "validated" || r.status === "compensation_failed");
  const rolledBack = reports.some((r) => r.status === "compensated");
  const status: ExecutionReport["status"] = !failed
    ? "settled"
    : residue
      ? "partial"
      : rolledBack
        ? "unwound"
        : "failed";
  deps.audit.append({ type: "plan_executed", planId: plan.planId, status, legs: reports.length, validated: validatedHashes.length });
  return { planId: plan.planId, status, legs: reports, validatedHashes };
}

/**
 * True when the network can wrap a plan into one atomic Batch. Batch is not
 * enabled on mainnet or testnet today, so this is false everywhere and
 * executePlan's sequential path with compensations is what actually runs.
 */
export async function canBatch(client: XrplClient): Promise<boolean> {
  const state = await readAmendments(client);
  return state.known && state.enabled.has("Batch");
}
