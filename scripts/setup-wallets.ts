import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "xrpl";

/**
 * Provisions every testnet account the demo needs, and is safe to re-run:
 * anything already configured is left alone.
 *
 * The platform's seed is written, not just its address. Fees land in that
 * account and `npm run settle` pays authors out of it, so without the seed the
 * money arrives somewhere nobody can spend from.
 */
const wsUrl = process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233";
const envPath = ".env";
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(".env.example", "utf8");

function setVar(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  return new RegExp(`^${key}=`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text.trimEnd()}\n${line}\n`;
}

function readVar(text: string, key: string): string | undefined {
  const found = text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
  return found ? found : undefined;
}

const PLACEHOLDER = /Placeholder$/;
const STRATEGY_FILES = ["alpha", "beta", "gamma"].map((id) => join("strategies", `${id}.json`));

const client = new Client(wsUrl);
await client.connect();
let next = current;

try {
  if (readVar(current, "XRPL_BUYER_SEED")) {
    console.log("buyer     already configured, left alone");
  } else {
    const { wallet, balance } = await client.fundWallet();
    next = setVar(next, "XRPL_BUYER_SEED", wallet.seed!);
    console.log(`buyer     ${wallet.classicAddress}  ${balance} XRP  (seed written)`);
  }

  if (readVar(current, "XRPL_PLATFORM_SEED")) {
    console.log("platform  already configured, left alone");
  } else {
    const { wallet, balance } = await client.fundWallet();
    next = setVar(next, "XRPL_PLATFORM_SEED", wallet.seed!);
    next = setVar(next, "XRPL_PAY_TO", wallet.classicAddress);
    next = setVar(next, "XRPL_PLATFORM_PAY_TO", wallet.classicAddress);
    console.log(`platform  ${wallet.classicAddress}  ${balance} XRP  (receives fees, pays authors)`);
  }

  for (const file of STRATEGY_FILES) {
    const profile = JSON.parse(readFileSync(file, "utf8")) as { id: string; payoutAddress?: string };
    if (profile.payoutAddress && !PLACEHOLDER.test(profile.payoutAddress)) {
      console.log(`${profile.id.padEnd(9)} already has ${profile.payoutAddress}`);
      continue;
    }
    // Authors must exist on ledger before they can be paid: a Payment to an
    // unfunded account below the base reserve fails with tecNO_DST_INSUF_XRP.
    const { wallet, balance } = await client.fundWallet();
    profile.payoutAddress = wallet.classicAddress;
    writeFileSync(file, JSON.stringify(profile, null, 2) + "\n");
    console.log(`${profile.id.padEnd(9)} ${wallet.classicAddress}  ${balance} XRP  (author payout account)`);
  }
} finally {
  await client.disconnect();
}

writeFileSync(envPath, next);
console.log(`\nwrote ${envPath} and strategies/*.json`);
