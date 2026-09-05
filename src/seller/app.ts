import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type RequestHandler } from "express";
import { requirePayment } from "x402-xrpl/express";
import * as z from "zod/v4";
import { MANDATE_SHAPE, OPTIMIZE_DESCRIPTION, OPTIMIZE_PATH, buildMcpServer, type SellerConfig, type SellerEngine } from "./mcp.js";

const mandateSchema = z.object(MANDATE_SHAPE);

export function buildSellerApp(cfg: SellerConfig, engine: SellerEngine, opts: { paymentGuard?: RequestHandler } = {}): Express {
  const app = express();
  app.use(express.json());

  const guard =
    opts.paymentGuard ??
    requirePayment({
      path: OPTIMIZE_PATH,
      price: cfg.priceDrops,
      payToAddress: cfg.payTo,
      network: cfg.network,
      facilitatorUrl: cfg.facilitatorUrl,
      asset: "XRP",
      resource: "xrpl-fi:optimize_allocation",
      description: OPTIMIZE_DESCRIPTION,
      settle: true,
      sourceTag: 804681468,
    });

  app.get("/health", (_req, res) => {
    const ready = engine.ready ? engine.ready() : true;
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "warming" });
  });

  app.get("/api/quote", (_req, res) => {
    if (!engine.quote) {
      res.status(404).json({ error: "this seller advertises no strategy profile" });
      return;
    }
    res.json(engine.quote());
  });

  app.get("/api/catalog", (_req, res) => {
    res.json({
      tools: [
        { name: "optimize_allocation", price_drops: cfg.priceDrops, asset: "XRP", network: cfg.network, resource: `${cfg.baseUrl}${OPTIMIZE_PATH}` },
      ],
    });
  });

  const validateMandate: RequestHandler = (req, res, next) => {
    const parsed = mandateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid mandate", issues: parsed.error.issues });
      return;
    }
    next();
  };

  // x402 settles payment inside the guard, before the handler runs, so a seller
  // that cannot produce an analysis must refuse *before* the guard rather than
  // charge for a request it is about to fail.
  const requireReady: RequestHandler = (_req, res, next) => {
    if (engine.ready && !engine.ready()) {
      res.status(503).json({ error: "not ready", message: "market data is still loading; no payment was taken" });
      return;
    }
    next();
  };

  app.post(OPTIMIZE_PATH, validateMandate, requireReady, guard, async (req, res) => {
    try {
      res.json(await engine.runAnalysis(mandateSchema.parse(req.body)));
    } catch (err) {
      res.status(500).json({ error: "analysis failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/mcp", async (req, res) => {
    const server = buildMcpServer(cfg, engine);
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
