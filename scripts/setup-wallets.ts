import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "xrpl";

const wsUrl = process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233";
const envPath = ".env";
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(".env.example", "utf8");

function setVar(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  return new RegExp(`^${key}=`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
}

const client = new Client(wsUrl);
await client.connect();
const { wallet: seller, balance: sellerBalance } = await client.fundWallet();
const { wallet: buyer, balance: buyerBalance } = await client.fundWallet();
await client.disconnect();

let next = setVar(current, "XRPL_PAY_TO", seller.classicAddress);
next = setVar(next, "XRPL_BUYER_SEED", buyer.seed!);
writeFileSync(envPath, next);

console.log(`seller ${seller.classicAddress} balance ${sellerBalance} XRP`);
console.log(`buyer  ${buyer.classicAddress} balance ${buyerBalance} XRP`);
console.log(`wrote ${envPath}`);
