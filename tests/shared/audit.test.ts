import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, listRuns, readRun } from "../../src/shared/audit.js";

describe("AuditLog", () => {
  it("appends JSONL records with increasing seq and reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const log = new AuditLog(dir, "run-1");
    log.append({ type: "discovery", tools: ["a", "b"] });
    log.append({ type: "decision", action: "hold", rationale: "test" });

    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.runId).toBe("run-1");
    expect(first.seq).toBe(1);
    expect(first.event.type).toBe("discovery");

    expect(readRun(dir, "run-1").map((r) => r.seq)).toEqual([1, 2]);
    expect(listRuns(dir)).toEqual(["run-1"]);
  });

  it("generates a runId when none is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const log = new AuditLog(dir);
    expect(log.runId).toMatch(/^\d{8}T\d{6}-[a-f0-9]{6}$/);
  });
});
