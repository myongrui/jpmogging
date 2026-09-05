import { quoteFor, type StrategyProfile, type StrategyQuote } from "../platform/strategy.js";

/**
 * Tracks how much capital a strategy has committed, so the APY and capacity it
 * broadcasts fall as the pool fills rather than staying at a headline figure.
 * Commitments are held for this process only — a restart re-opens the book.
 */
export class CapacityBook {
  private committed = 0;
  private readonly planIds = new Set<string>();

  constructor(private readonly profile: StrategyProfile) {}

  get deployed(): number {
    return this.committed;
  }

  /** Commits capital against a plan. Re-committing the same plan is a no-op. */
  commit(planId: string, amount: number): void {
    if (this.planIds.has(planId) || amount <= 0) return;
    this.planIds.add(planId);
    this.committed += amount;
  }

  release(planId: string, amount: number): void {
    if (!this.planIds.delete(planId)) return;
    this.committed = Math.max(0, this.committed - amount);
  }

  quote(now = new Date()): StrategyQuote {
    return quoteFor(this.profile, this.committed, now);
  }
}
