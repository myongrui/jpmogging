import { describe, expect, it } from "vitest";
import { throttledRpc } from "../../src/engine/throttle.js";

const noSleep = async () => {};

describe("throttledRpc", () => {
  it("retries an overload response and returns the eventual success", async () => {
    let calls = 0;
    const rpc = {
      request: async () => {
        calls++;
        if (calls < 3) throw new Error("You are placing too much load on the server.");
        return { result: { ok: true } };
      },
    };
    const out = await throttledRpc(rpc, { sleep: noSleep, minIntervalMs: 0 }).request({ command: "x" });
    expect(out).toEqual({ result: { ok: true } });
    expect(calls).toBe(3);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    const rpc = {
      request: async () => {
        calls++;
        throw new Error("You are placing too much load on the server.");
      },
    };
    await expect(
      throttledRpc(rpc, { sleep: noSleep, minIntervalMs: 0, attempts: 3 }).request({ command: "x" }),
    ).rejects.toThrow(/too much load/);
    expect(calls).toBe(3);
  });

  it("does not retry an error that is not an overload", async () => {
    let calls = 0;
    const rpc = {
      request: async () => {
        calls++;
        throw new Error("actNotFound");
      },
    };
    await expect(throttledRpc(rpc, { sleep: noSleep, minIntervalMs: 0 }).request({})).rejects.toThrow("actNotFound");
    expect(calls).toBe(1);
  });

  it("serialises concurrent callers instead of bursting the node", async () => {
    let inFlight = 0;
    let peak = 0;
    const rpc = {
      request: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { result: {} };
      },
    };
    const t = throttledRpc(rpc, { sleep: noSleep, minIntervalMs: 0 });
    await Promise.all([t.request({}), t.request({}), t.request({}), t.request({})]);
    expect(peak).toBe(1);
  });

  it("keeps serving later callers after one request fails", async () => {
    let calls = 0;
    const rpc = {
      request: async () => {
        calls++;
        if (calls === 1) throw new Error("actNotFound");
        return { result: { n: calls } };
      },
    };
    const t = throttledRpc(rpc, { sleep: noSleep, minIntervalMs: 0 });
    await expect(t.request({})).rejects.toThrow("actNotFound");
    await expect(t.request({})).resolves.toEqual({ result: { n: 2 } });
  });
});
