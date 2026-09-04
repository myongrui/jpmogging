import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import express, { type Express } from "express";
import { listRuns, readRun } from "../shared/audit.js";

export function buildDashboardApp(runsDir: string): Express {
  const app = express();
  app.get("/api/runs", (_req, res) => {
    res.json({ runs: listRuns(runsDir) });
  });
  app.get("/api/runs/:id", (req, res) => {
    res.json({ records: readRun(runsDir, String(req.params.id)) });
  });
  app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "public")));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DASHBOARD_PORT ?? "8090");
  buildDashboardApp("runs").listen(port, "127.0.0.1", () => {
    console.log(`dashboard on http://127.0.0.1:${port}`);
  });
}
