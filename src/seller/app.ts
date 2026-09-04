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
    });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/catalog", (_req, res) => {
    res.json({
      tools: [
        { name: "optimize_allocation", price_drops: cfg.priceDrops, asset: "XRP", network: cfg.network, resource: `${cfg.baseUrl}${OPTIMIZE_PATH}` },
      ],
    });
  });

  app.post(OPTIMIZE_PATH, guard, async (req, res) => {
    const parsed = mandateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid mandate", issues: parsed.error.issues });
      return;
    }
    res.json(await engine.runAnalysis(parsed.data));
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
