import * as z from "zod/v4";

/** The mandate a buyer states. Shared by the MCP tool schema and HTTP validation. */
export const MANDATE_SHAPE = {
  asset: z.literal("RLUSD").describe("Capital asset. Only RLUSD is supported."),
  amount: z.number().positive().describe("Total capital in RLUSD"),
  horizon_hours: z.number().positive().describe("Investment horizon in hours"),
  minimum_liquidity: z.number().min(0).max(1).describe("Fraction of capital that must stay liquid"),
  maximum_risk_score: z.number().min(0).max(100).describe("Reject any pool or strategy above this risk score"),
  maximum_protocol_allocation: z.number().min(0).max(1).describe("Maximum fraction of capital in one venue"),
};

export const mandateSchema = z.object(MANDATE_SHAPE);
