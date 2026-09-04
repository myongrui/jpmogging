import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDashboardApp } from "../../src/dashboard/index.js";
import { AuditLog } from "../../src/shared/audit.js";

let server: any;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "dash-"));

beforeAll(async () => {
  new AuditLog(dir, "r1").append({ type: "discovery", tools: ["a"] });
  await new Promise<void>((resolve) => {
    server = buildDashboardApp(dir).listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

describe("dashboard api", () => {
  it("lists runs", async () => {
    expect(await (await fetch(`${base}/api/runs`)).json()).toEqual({ runs: ["r1"] });
  });
  it("returns records for a run", async () => {
    const body = await (await fetch(`${base}/api/runs/r1`)).json();
    expect(body.records[0].event).toEqual({ type: "discovery", tools: ["a"] });
  });
  it("serves the page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("XRPL Financial Intelligence");
  });
});
