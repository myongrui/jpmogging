import type { XrplRpc } from "./xrplData.js";

const OVERLOADED = /too much load|slowDown|tooBusy|noCurrent|amendmentBlocked/i;

export interface ThrottleOptions {
  /** Minimum gap between requests, in ms. */
  minIntervalMs?: number;
  /** Attempts per request, including the first. */
  attempts?: number;
  /** Delay before the first retry; doubles thereafter. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isOverloaded(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return OVERLOADED.test(message);
}

/**
 * Serialises and paces calls to a public XRPL node, retrying the "you are
 * placing too much load on the server" response with exponential backoff.
 *
 * Public nodes tolerate steady traffic far better than bursts, so requests are
 * queued behind one another rather than fired in parallel.
 */
export function throttledRpc(rpc: XrplRpc, opts: ThrottleOptions = {}): XrplRpc {
  const minIntervalMs = opts.minIntervalMs ?? 120;
  const attempts = opts.attempts ?? 4;
  const backoffMs = opts.backoffMs ?? 400;
  const sleep = opts.sleep ?? wait;

  let chain: Promise<unknown> = Promise.resolve();
  let lastAt = 0;

  return {
    request(req: any) {
      const run = chain.then(async () => {
        const since = Date.now() - lastAt;
        if (since < minIntervalMs) await sleep(minIntervalMs - since);

        let delay = backoffMs;
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await rpc.request(req);
            lastAt = Date.now();
            return res;
          } catch (err) {
            lastAt = Date.now();
            if (attempt >= attempts || !isOverloaded(err)) throw err;
            await sleep(delay);
            delay *= 2;
          }
        }
      });
      // Keep the queue going even when a call rejects.
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
