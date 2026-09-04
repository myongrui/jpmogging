import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AuditEvent, AuditRecord } from "./types.js";

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export class AuditLog {
  readonly runId: string;
  readonly path: string;
  private seq = 0;

  constructor(dir: string, runId: string = newRunId()) {
    mkdirSync(dir, { recursive: true });
    this.runId = runId;
    this.path = join(dir, `${runId}.jsonl`);
  }

  append(event: AuditEvent): AuditRecord {
    this.seq += 1;
    const record: AuditRecord = { runId: this.runId, seq: this.seq, ts: new Date().toISOString(), event };
    appendFileSync(this.path, JSON.stringify(record) + "\n");
    return record;
  }
}

export function readRun(dir: string, runId: string): AuditRecord[] {
  const file = join(dir, `${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

export function listRuns(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort()
    .reverse();
}
