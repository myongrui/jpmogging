import "dotenv/config";
import { Client, Wallet } from "xrpl";
import { loadRegistry } from "../src/platform/registry.js";
import { RevenueLedger } from "../src/platform/revenue.js";

/**
 * Pays strategy authors what the revenue ledger says they are owed.
 *
 * Kept out of the server so the platform process holds no key: fees accrue
 * while it runs, and an operator settles deliberately. Pass --dry-run to see
 * the payouts without sending anything.
 */
const dryRun = process.argv.includes("--dry-run");
const ledger = new RevenueLedger(process.env.REVENUE_DIR ?? "runs");
const profiles = loadRegistry(process.env.PLATFORM_REGISTRY);
const byId = new Map(profiles.map((p) => [p.id, p]));

const owed = ledger.owed();
const totals = ledger.totals();

console.log(`revenue ledger ${ledger.path}`);
console.log(`platform earned ${totals.platformDrops} drops`);
if (Object.keys(owed).length === 0) {
  console.log("nothing owed to strategy authors");
  process.exit(0);
}

console.log("owed:");
for (const [id, drops] of Object.entries(owed)) {
  console.log(`  ${id.padEnd(8)} ${String(drops).padStart(10)} drops -> ${byId.get(id)?.payoutAddress ?? "(unknown strategy)"}`);
}

if (dryRun) {
  console.log("\n--dry-run: nothing sent");
  process.exit(0);
}

const seed = process.env.XRPL_PLATFORM_SEED;
if (!seed) throw new Error("XRPL_PLATFORM_SEED is required to settle (omit it and use --dry-run to preview)");

const wallet = Wallet.fromSeed(seed);
const ws = process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233";
const client = new Client(ws);
await client.connect();

try {
  for (const [id, drops] of Object.entries(owed)) {
    const profile = byId.get(id);
    if (!profile) {
      console.log(`skipping ${id}: not in the registry`);
      continue;
    }
    const tx = await client.autofill({
      TransactionType: "Payment",
      Account: wallet.classicAddress,
      Destination: profile.payoutAddress,
      Amount: drops,
    } as never);
    const res = await client.submitAndWait(wallet.sign(tx).tx_blob);
    const result = (res.result.meta as { TransactionResult?: string })?.TransactionResult;
    if (result !== "tesSUCCESS") {
      console.log(`  ${id}: FAILED ${result}`);
      continue;
    }
    ledger.settle(id, drops, res.result.hash);
    console.log(`  ${id}: paid ${drops} drops · ${res.result.hash}`);
  }
} finally {
  await client.disconnect();
}
