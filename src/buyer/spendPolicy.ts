export interface SpendPolicy {
  maxDropsPerRequest: bigint;
  maxDropsPerSession: bigint;
}

export class SpendTracker {
  spentDrops = 0n;

  constructor(private readonly policy: SpendPolicy) {}

  authorize(amountDrops: string): { ok: true } | { ok: false; reason: string } {
    const amount = BigInt(amountDrops);
    if (amount > this.policy.maxDropsPerRequest) {
      return { ok: false, reason: `${amount} drops exceeds per-request limit of ${this.policy.maxDropsPerRequest} drops` };
    }
    if (this.spentDrops + amount > this.policy.maxDropsPerSession) {
      return {
        ok: false,
        reason: `${amount} drops would exceed session budget: ${this.spentDrops} spent of ${this.policy.maxDropsPerSession} drops`,
      };
    }
    return { ok: true };
  }

  record(amountDrops: string): void {
    this.spentDrops += BigInt(amountDrops);
  }
}

export function policyFromEnv(env: NodeJS.ProcessEnv): SpendPolicy {
  return {
    maxDropsPerRequest: BigInt(env.BUYER_MAX_DROPS_PER_REQUEST ?? "1000000"),
    maxDropsPerSession: BigInt(env.BUYER_MAX_DROPS_PER_SESSION ?? "3000000"),
  };
}
