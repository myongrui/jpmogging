import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { AuditLog } from "../../src/shared/audit.js";
import { executePlan, type XrplClient } from "../../src/execute/executor.js";
import type { ExecutionPlan, PlanLeg } from "../../src/shared/plan.js";
import type { Mandate } from "../../src/shared/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wallet = Wallet.generate();
const mandate: Mandate = {
  asset: "RLUSD", amount: 100000, horizon_hours: 72,
  minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25,
};

const deposit = (seq: number, venue: string): PlanLeg => ({
  seq,
  venue,
  kind: "deposit",
  description: `deposit into ${venue}`,
  tx: {
    TransactionType: "AMMDeposit",
    Asset: { currency: "XRP" },
    Asset2: { currency: "USD", issuer: "rhFtuNth7j4BicYLf28mhY2CjfnbwUdz3w" },
    Amount: "1000000",
    Flags: 0x00080000,
  },
  amountRlusd: 25000,
  compensate: {
    TransactionType: "AMMWithdraw",
    Asset: { currency: "XRP" },
    Asset2: { currency: "USD", issuer: "rhFtuNth7j4BicYLf28mhY2CjfnbwUdz3w" },
    Amount: "1000000",
    Flags: 0x00080000,
  },
});

function plan(legs: PlanLeg[]): ExecutionPlan {
  return {
    planId: "pl_exec", network: "xrpl:0",
    createdAt: new Date().toISOString(), validUntil: "2099-01-01T00:00:00.000Z",
    mandate, legs,
    totals: { deployed: legs.reduce((s, l) => s + l.amountRlusd, 0), reserve: 0, venues: legs.length },
  };
}

/** Fake node. `results` drives the engine result of each successive submit. */
function fakeClient(results: string[], history: any[] = []) {
  const submitted: any[] = [];
  let i = 0;
  const client: XrplClient = {
    async request(req: any) {
      if (req.command === "account_info") return { result: { account_data: { Sequence: 100 } } };
      if (req.command === "ledger") return { result: { ledger_index: 5000 } };
      if (req.command === "account_tx") return { result: { transactions: history } };
      return { result: {} };
    },
    async autofill(tx: any) {
      return { ...tx, Fee: "12" };
    },
    async submitAndWait(blob: string) {
      const engineResult = results[i++] ?? "tesSUCCESS";
      return { result: { hash: `HASH${i}`, validated: true, meta: { TransactionResult: engineResult } } };
    },
  };
  const origSign = wallet.sign.bind(wallet);
  (wallet as any).sign = (tx: any) => {
    submitted.push(tx);
    return origSign(tx);
  };
  return { client, submitted };
}

function audit() {
  return new AuditLog(mkdtempSync(join(tmpdir(), "xrplfi-")));
}

describe("executePlan", () => {
  it("settles every leg and reports validated hashes", async () => {
    const { client, submitted } = fakeClient(["tesSUCCESS", "tesSUCCESS"]);
    const report = await executePlan({ client, wallet, audit: audit() }, plan([deposit(1, "amm:rA"), deposit(2, "amm:rB")]));
    expect(report.status).toBe("settled");
    expect(report.validatedHashes).toEqual(["HASH1", "HASH2"]);
    expect(submitted.map((t) => t.Sequence)).toEqual([100, 101]);
    expect(submitted.every((t) => t.LastLedgerSequence === 5020)).toBe(true);
  });

  it("assigns the buyer's own account, never one the plan chose", async () => {
    const { client, submitted } = fakeClient(["tesSUCCESS"]);
    await executePlan({ client, wallet, audit: audit() }, plan([deposit(1, "amm:rA")]));
    expect(submitted[0].Account).toBe(wallet.classicAddress);
  });

  it("stops at the first failure and unwinds what already settled", async () => {
    const { client, submitted } = fakeClient(["tesSUCCESS", "tecUNFUNDED_AMM", "tesSUCCESS"]);
    const report = await executePlan({ client, wallet, audit: audit() }, plan([deposit(1, "amm:rA"), deposit(2, "amm:rB")]));
    expect(report.status).toBe("unwound");
    expect(report.legs[1].status).toBe("failed");
    expect(report.legs[0].status).toBe("compensated");
    // leg 1, leg 2, then the compensating AMMWithdraw for leg 1
    expect(submitted.map((t) => t.TransactionType)).toEqual(["AMMDeposit", "AMMDeposit", "AMMWithdraw"]);
  });

  it("holds the position instead of unwinding when asked to", async () => {
    const { client, submitted } = fakeClient(["tesSUCCESS", "tecUNFUNDED_AMM"]);
    const report = await executePlan({ client, wallet, audit: audit(), onFailure: "hold" }, plan([deposit(1, "amm:rA"), deposit(2, "amm:rB")]));
    expect(report.status).toBe("partial");
    expect(report.legs[0].status).toBe("validated");
    expect(submitted).toHaveLength(2);
  });

  it("reports residue as partial when a compensation itself fails", async () => {
    const { client } = fakeClient(["tesSUCCESS", "tecUNFUNDED_AMM", "tecPATH_DRY"]);
    const report = await executePlan({ client, wallet, audit: audit() }, plan([deposit(1, "amm:rA"), deposit(2, "amm:rB")]));
    expect(report.legs[0].status).toBe("compensation_failed");
    expect(report.status).toBe("partial");
  });

  it("treats an unvalidated result as a failure", async () => {
    const { client } = fakeClient([]);
    client.submitAndWait = async () => ({ result: { hash: "H", validated: false, meta: { TransactionResult: "tesSUCCESS" } } });
    const report = await executePlan({ client, wallet, audit: audit() }, plan([deposit(1, "amm:rA")]));
    expect(report.status).toBe("failed");
    expect(report.legs[0].message).toMatch(/not validated/);
  });

  it("skips legs already on ledger so a resumed run never double-submits", async () => {
    const memo = Buffer.from("pl_exec:1", "utf8").toString("hex").toUpperCase();
    const history = [{ tx: { Memos: [{ Memo: { MemoData: memo } }] } }];
    const { client, submitted } = fakeClient(["tesSUCCESS"], history);
    const report = await executePlan({ client, wallet, audit: audit() }, plan([deposit(1, "amm:rA"), deposit(2, "amm:rB")]));
    expect(report.legs[0].status).toBe("skipped");
    expect(submitted).toHaveLength(1);
    expect(report.status).toBe("settled");
  });

  it("tags each leg with the plan id so it can be reconciled later", async () => {
    const { client, submitted } = fakeClient(["tesSUCCESS"]);
    await executePlan({ client, wallet, audit: audit() }, plan([deposit(1, "amm:rA")]));
    const memo = Buffer.from(submitted[0].Memos[0].Memo.MemoData, "hex").toString("utf8");
    expect(memo).toBe("pl_exec:1");
  });
});
