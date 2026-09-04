import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type OpenAI from "openai";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpBridge {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export async function connectMcp(url: string): Promise<McpBridge> {
  const client = new Client({ name: "xrpl-treasury-buyer", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
    },
    async callTool(name, args) {
      const result: any = await client.callTool({ name, arguments: args });
      const text = result.content?.find((c: any) => c.type === "text")?.text ?? "";
      if (result.isError) throw new Error(`MCP tool ${name} failed: ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}

export function mcpToolsToOpenAiTools(tools: McpTool[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema,
    strict: false,
  }));
}
