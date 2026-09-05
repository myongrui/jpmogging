import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type RequestHandler } from "express";
import { requirePayment } from "x402-xrpl/express";
import { mandateSchema } from "../shared/mandate.js";
import { ALLOCATE_DESCRIPTION, ALLOCATE_PATH, LIST_DESCRIPTION, LIST_PATH, buildPlatformMcpServer, type PlatformConfig, type PlatformEngine } from "./mcp.js";

export function buildPlatformApp(
  cfg: PlatformConfig,
  engine: PlatformEngine,
  opts: { paymentGuard?: RequestHandler; listGuard?: RequestHandler } = {},
): Express {
  const app = express();
  app.use(express.json());

  const guard =
    opts.paymentGuard ??
    requirePayment({
      path: ALLOCATE_PATH,
      price: cfg.priceDrops,
      payToAddress: cfg.payTo,
      network: cfg.network,
      facilitatorUrl: cfg.facilitatorUrl,
      asset: "XRP",
      resource: "xrpl-fi:allocate",
      description: ALLOCATE_DESCRIPTION,
      settle: true,
      sourceTag: 804681468,
    });

  app.get("/health", (_req, res) => {
    const ready = engine.ready();
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "warming" });
  });

  const listGuard =
    opts.listGuard ??
    requirePayment({
      path: LIST_PATH,
      price: cfg.listPriceDrops,
      payToAddress: cfg.payTo,
      network: cfg.network,
      facilitatorUrl: cfg.facilitatorUrl,
      asset: "XRP",
      resource: "xrpl-fi:list_strategies",
      description: LIST_DESCRIPTION,
      settle: true,
      sourceTag: 804681468,
    });

  app.post(LIST_PATH, listGuard, (_req, res) => {
    engine.recordListingFee();
    res.json({ strategies: engine.quotes() });
  });

  const validateMandate: RequestHandler = (req, res, next) => {
    const parsed = mandateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid mandate", issues: parsed.error.issues });
      return;
    }
    next();
  };

  // x402 settles payment inside the guard, before the handler runs, so the
  // platform must refuse *before* the guard rather than charge for a request it
  // is about to fail.
  const requireReady: RequestHandler = (_req, res, next) => {
    if (!engine.ready()) {
      res.status(503).json({ error: "not ready", message: "market data is still loading; no payment was taken" });
      return;
    }
    next();
  };

  app.post(ALLOCATE_PATH, validateMandate, requireReady, guard, async (req, res) => {
    try {
      // The mandate schema strips unknown keys, so the chosen strategies are
      // read off the raw body before parsing.
      const raw = req.body as { strategies?: unknown };
      const only = Array.isArray(raw?.strategies) ? raw.strategies.filter((x): x is string => typeof x === "string") : undefined;
      const result = await engine.allocate(mandateSchema.parse(req.body), only);
      if (result.legs.length === 0) {
        res.status(422).json({ error: "no eligible strategy", ...result });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "allocation failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/mcp", async (req, res) => {
    const server = buildPlatformMcpServer(cfg, engine);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const reject: RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", reject);
  app.delete("/mcp", reject);

  return app;
}
