import type { AllocationResult, Mandate, Opportunity } from "../shared/types.js";
import { optimizeAllocation } from "./optimizer.js";
import { scorePool } from "./scoring.js";
import { discoverPools, fetchPoolState, sampleVolume, type XrplRpc } from "./xrplData.js";

export const RLUSD_AMM_ACCOUNT = "rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3";

export interface EngineDeps {
  rpc: XrplRpc;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function listOpportunities(deps: EngineDeps): Promise<Opportunity[]> {
  const pools = await discoverPools(deps.fetchImpl);
  return pools.map((p) => ({
    ammAccount: p.ammAccount,
    pairLabel: p.pairLabel,
    tvlXrp: (Number(p.xrpBalanceDrops) / 1_000_000) * 2,
    tradingFeeBps: p.tradingFee / 10,
  }));
}

export async function runAnalysis(deps: EngineDeps, mandate: Mandate): Promise<AllocationResult> {
  const now = deps.now ?? (() => new Date());
  const discovered = await discoverPools(deps.fetchImpl);
  const live = await Promise.all(
    discovered.map(async (p) => {
      const [state, volume] = await Promise.all([fetchPoolState(deps.rpc, p), sampleVolume(deps.rpc, p.ammAccount)]);
      return { ...state, volume };
    }),
  );

  const rlusd = live.find((l) => l.snapshot.ammAccount === RLUSD_AMM_ACCOUNT);
  if (!rlusd) throw new Error("RLUSD reference pool not found in discovered pools");
  const rlusdPerXrp = Number(rlusd.snapshot.asset2Value) / (Number(rlusd.snapshot.xrpBalanceDrops) / 1_000_000);
  const deployXrp = (mandate.amount * mandate.maximum_protocol_allocation) / rlusdPerXrp;

  const scored = live.map((l) => scorePool(l.snapshot, l.volume.volumeXrpPerDay, deployXrp));
  const ledgerIndex = Math.max(...live.map((l) => l.ledgerIndex));
  return optimizeAllocation(mandate, scored, { rlusdPerXrp, ledgerIndex, sampledAt: now().toISOString(), now: now() });
}
