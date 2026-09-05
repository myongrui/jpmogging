import type { XrplRpc } from "../engine/xrplData.js";

export interface AmendmentState {
  /** False when the node would not answer `feature`, so nothing can be inferred. */
  known: boolean;
  enabled: Set<string>;
}

/** Reads the live amendment set so venue availability tracks the network, not a constant. */
export async function readAmendments(rpc: XrplRpc): Promise<AmendmentState> {
  try {
    const { result } = await rpc.request({ command: "feature" });
    const features = result?.features as Record<string, { name: string; enabled: boolean }> | undefined;
    if (!features) return { known: false, enabled: new Set() };
    const enabled = new Set<string>();
    for (const f of Object.values(features)) if (f.enabled) enabled.add(f.name);
    return { known: true, enabled };
  } catch {
    return { known: false, enabled: new Set() };
  }
}
