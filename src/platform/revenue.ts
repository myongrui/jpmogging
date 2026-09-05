import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RevenueSplit {
  /** Drops the platform keeps. */
  platformDrops: string;
  /** Drops owed to each strategy author, keyed by strategy id. */
  strategyDrops: Record<string, string>;
}

export interface FeeEntry {
  ts: string;
  kind: "list" | "allocate";
  /** Plan the fee was charged for, when there is one. */
  planId?: string;
  feeDrops: string;
  split: RevenueSplit;
}

export interface SettlementEntry {
  ts: string;
  kind: "settlement";
  strategyId: string;
  drops: string;
  transaction: string;
}

export type RevenueEntry = FeeEntry | SettlementEntry;

export interface Payout {
  strategyId: string;
  address: string;
  drops: string;
}

/**
 * Splits a fee between the platform and the strategies that earned it.
 *
 * The platform takes its cut off the top; the remainder is shared pro rata by
 * the capital each strategy actually placed, so a strategy that was crowded out
 * earns nothing. Integer drops throughout — the platform absorbs the rounding
 * remainder rather than paying out more than it took in.
 */
export function splitFee(
  feeDrops: string,
  cutBps: number,
  placed: Array<{ strategyId: string; amount: number }>,
): RevenueSplit {
  const fee = BigInt(feeDrops);
  if (cutBps < 0 || cutBps > 10_000) throw new Error(`cutBps must be within 0..10000, got ${cutBps}`);

  const platformCut = (fee * BigInt(cutBps)) / 10_000n;
  const pool = fee - platformCut;
  const total = placed.reduce((s, p) => s + p.amount, 0);

  const strategyDrops: Record<string, string> = {};
  let distributed = 0n;
  if (total > 0 && pool > 0n) {
    for (const p of placed) {
      const share = (pool * BigInt(Math.round(p.amount * 1e6))) / BigInt(Math.round(total * 1e6));
      strategyDrops[p.strategyId] = String((BigInt(strategyDrops[p.strategyId] ?? "0") + share));
      distributed += share;
    }
  }

  // Anything not distributed — rounding dust, or a call that placed nothing —
  // stays with the platform rather than vanishing.
  return { platformDrops: String(platformCut + (pool - distributed)), strategyDrops };
}

/** Append-only record of what was earned and owed. Payouts are a separate step. */
export class RevenueLedger {
  readonly path: string;

  constructor(dir: string, file = "revenue.jsonl") {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, file);
  }

  record(entry: RevenueEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  /** Records a payout so the same drops are never sent twice. */
  settle(strategyId: string, drops: string, transaction: string, now = new Date()): void {
    this.record({ ts: now.toISOString(), kind: "settlement", strategyId, drops, transaction });
  }

  entries(): RevenueEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RevenueEntry);
  }

  /** Drops earned to date, by strategy id, plus the platform's own total. */
  totals(): { platformDrops: string; strategyDrops: Record<string, string> } {
    let platform = 0n;
    const strategies: Record<string, bigint> = {};
    for (const e of this.entries()) {
      if (e.kind === "settlement") continue;
      platform += BigInt(e.split.platformDrops);
      for (const [id, drops] of Object.entries(e.split.strategyDrops)) {
        strategies[id] = (strategies[id] ?? 0n) + BigInt(drops);
      }
    }
    return {
      platformDrops: String(platform),
      strategyDrops: Object.fromEntries(Object.entries(strategies).map(([k, v]) => [k, String(v)])),
    };
  }

  /** Earned minus already paid out, by strategy id. Zero balances are omitted. */
  owed(): Record<string, string> {
    const earned = this.totals().strategyDrops;
    const paid: Record<string, bigint> = {};
    for (const e of this.entries()) {
      if (e.kind !== "settlement") continue;
      paid[e.strategyId] = (paid[e.strategyId] ?? 0n) + BigInt(e.drops);
    }
    const out: Record<string, string> = {};
    for (const [id, drops] of Object.entries(earned)) {
      const balance = BigInt(drops) - (paid[id] ?? 0n);
      if (balance > 0n) out[id] = String(balance);
    }
    return out;
  }
}
