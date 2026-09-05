import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type RequestHandler } from "express";
import { requirePayment } from "x402-xrpl/express";
import { MATCH_DESCRIPTION, MATCH_PATH, buildPlatformMcpServer, matchSchema, type PlatformConfig, type PlatformEngine } from "./mcp.js";

export function buildPlatformApp(cfg: PlatformConfig, engine: PlatformEngine, opts: { paymentGuard?: RequestHandler } = {}): Express {
  const app = express();
  app.use(express.json());

  const guard =
    opts.paymentGuard ??
    requirePayment({
      path: MATCH_PATH,
      price: cfg.priceDrops,
      payToAddress: cfg.payTo,
      network: cfg.network,
      facilitatorUrl: cfg.facilitatorUrl,
      asset: "XRP",
      resource: "xrpl-fi:find_strategy",
      description: MATCH_DESCRIPTION,
      settle: true,
      sourceTag: 804681468,
    });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/sellers", (_req, res) => {
    res.json({ sellers: engine.listSellers() });
  });

  const validateMandate: RequestHandler = (req, res, next) => {
    const parsed = matchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid mandate", issues: parsed.error.issues });
      return;
    }
    next();
  };

  app.post(MATCH_PATH, validateMandate, guard, async (req, res) => {
    try {
      const result = await engine.orchestrate(matchSchema.parse(req.body));
      if (result.legs.length === 0) {
        res.status(422).json({ error: "no eligible seller", ...result });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "orchestration failed", message: err instanceof Error ? err.message : String(err) });
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
