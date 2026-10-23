import { describe, expect, it } from "vitest";
import { openNetworkFetchSession, type NetworkFetchSink } from "./session.js";

describe("daemon exchange budget", () => {
  it("rejects before DNS when the shared budget is exhausted", async () => {
    const failures: string[] = [];
    let lookups = 0;
    const sink: NetworkFetchSink = {
      head() {},
      body() {},
      end() {},
      uploadCredit() {},
      closed() {},
      fail(_id, failure) {
        failures.push(failure.code);
      },
    };
    const session = openNetworkFetchSession({
      allowlists: {
        get: () => ({
          id: "local",
          revision: 1,
          targets: [{ origin: "https://target.test", pathPrefix: "/" }],
        }),
      },
      allowlistRef: { id: "local", revision: 1 },
      scope: { origin: "https://target.test", pathPrefix: "/" },
      ttlMs: 10000,
      isAuthorized: () => true,
      protectedLocalPorts: () => new Set(),
      lookup: async () => {
        lookups += 1;
        return [];
      },
      acquireRequestSlot: () => null,
      sink,
    });
    session.request({
      requestId: 1,
      method: "GET",
      url: "https://target.test/",
      headers: [],
      redirect: "manual",
      body: { kind: "none" },
    });
    expect(failures).toEqual(["stream_limit"]);
    expect(lookups).toBe(0);
    expect(session.activeRequests).toBe(0);
    session.close();
    await session.released();
  });

  it("releases a slot after cancellation even when the close notification fails", async () => {
    let released = 0;
    const sink: NetworkFetchSink = {
      head() {},
      body() {},
      end() {},
      uploadCredit() {},
      fail() {},
      closed() {
        throw new Error("Delivery unavailable");
      },
    };
    const session = openNetworkFetchSession({
      allowlists: {
        get: () => ({
          id: "local",
          revision: 1,
          targets: [{ origin: "https://target.test", pathPrefix: "/" }],
        }),
      },
      allowlistRef: { id: "local", revision: 1 },
      scope: { origin: "https://target.test", pathPrefix: "/" },
      ttlMs: 10000,
      isAuthorized: () => true,
      protectedLocalPorts: () => new Set(),
      lookup: async () => [],
      acquireRequestSlot: () => () => {
        released += 1;
      },
      sink,
    });
    session.request({
      requestId: 1,
      method: "GET",
      url: "https://target.test/",
      headers: [],
      redirect: "manual",
      body: { kind: "none" },
    });
    expect(() => session.revoke()).toThrow("Delivery unavailable");
    expect(session.isOpen).toBe(false);
    await session.released();
    expect(released).toBe(1);
    session.close();
    expect(released).toBe(1);
  });
});
