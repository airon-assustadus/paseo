import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileNetworkFetchStateStorage,
  NetworkFetchDurabilityError,
  NetworkFetchStateStore,
  type NetworkFetchDestinationRecord,
  type NetworkFetchStateStorage,
} from "./network-fetch-state-store.js";

class MemoryStorage implements NetworkFetchStateStorage {
  data: string | null = null;
  failWrites = false;

  read(): string | null {
    return this.data;
  }

  write(data: string): void {
    if (this.failWrites) throw new Error("Disk unavailable");
    this.data = data;
  }
}

function recordFor(store: NetworkFetchStateStore): NetworkFetchDestinationRecord {
  return {
    destinationId: store.identity("principal-a", "https://example.test"),
    principalId: "principal-a",
    origin: "https://example.test",
    pathPrefix: "/",
    allowlistId: "configured",
    allowlistRevision: 1,
    authorityEpoch: "1",
    cleanupRequiredEpoch: null,
    cleanupRequestBaseEpoch: null,
    state: "active",
    contentOrigin: "https://destination.content.test",
    assetVersion: "v1",
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("network fetch durable identities", () => {
  it("keeps canonical identities stable across clean restarts and separates principals and hosts", () => {
    const storage = new MemoryStorage();
    const first = new NetworkFetchStateStore(storage, "host-a");
    const identity = first.identity("principal-a", "https://EXAMPLE.test:443");
    expect(identity).toMatch(/^[a-z2-7]{52}$/);
    expect(first.identity("principal-b", "https://example.test")).not.toBe(identity);
    first.put(recordFor(first));
    first.close();
    const second = new NetworkFetchStateStore(storage, "host-a");
    expect(second.identity("principal-a", "https://example.test")).toBe(identity);
    expect(second.get(identity)?.cleanupRequiredEpoch).toBeNull();
    expect(() => new NetworkFetchStateStore(storage, "host-b")).toThrow(
      NetworkFetchDurabilityError,
    );
  });

  it("recovers an unfinished run with a new epoch and a pending tombstone", () => {
    const storage = new MemoryStorage();
    const first = new NetworkFetchStateStore(storage, "host-a");
    const record = recordFor(first);
    first.put({ ...record, authorityEpoch: "9007199254740993" });
    const restarted = new NetworkFetchStateStore(storage, "host-a");
    expect(restarted.get(record.destinationId)).toMatchObject({
      authorityEpoch: "9007199254740994",
      cleanupRequiredEpoch: "9007199254740994",
      cleanupRequestBaseEpoch: null,
    });
  });

  it("never acknowledges memory-only tombstones and preserves a crash fence after failed writes", () => {
    const storage = new MemoryStorage();
    const first = new NetworkFetchStateStore(storage, "host-a");
    const record = recordFor(first);
    first.put(record);
    storage.failWrites = true;
    expect(() =>
      first.put({
        ...record,
        authorityEpoch: "2",
        cleanupRequiredEpoch: "2",
        cleanupRequestBaseEpoch: "1",
      }),
    ).toThrow(NetworkFetchDurabilityError);
    expect(first.isAvailable).toBe(false);
    expect(() => first.get(record.destinationId)).toThrow(NetworkFetchDurabilityError);
    expect(() => first.close()).toThrow(NetworkFetchDurabilityError);
    storage.failWrites = false;
    expect(() => first.put(record)).toThrow(NetworkFetchDurabilityError);
    const restarted = new NetworkFetchStateStore(storage, "host-a");
    expect(restarted.get(record.destinationId)).toMatchObject({
      authorityEpoch: "2",
      cleanupRequiredEpoch: "2",
    });
  });

  it("preserves a committed cleanup request across clean restart", () => {
    const storage = new MemoryStorage();
    const first = new NetworkFetchStateStore(storage, "host-a");
    const record = recordFor(first);
    first.put({
      ...record,
      authorityEpoch: "2",
      cleanupRequiredEpoch: "2",
      cleanupRequestBaseEpoch: "1",
    });
    first.close();
    const restarted = new NetworkFetchStateStore(storage, "host-a");
    expect(restarted.get(record.destinationId)).toMatchObject({
      authorityEpoch: "2",
      cleanupRequiredEpoch: "2",
      cleanupRequestBaseEpoch: "1",
    });
  });

  it("refuses corrupted state and key rotation instead of silently replacing identity", () => {
    const storage = new MemoryStorage();
    const first = new NetworkFetchStateStore(storage, "host-a");
    first.put(recordFor(first));
    first.close();
    const saved = JSON.parse(storage.data!);
    saved.key = "00".repeat(32);
    storage.data = JSON.stringify(saved);
    expect(() => new NetworkFetchStateStore(storage, "host-a")).toThrow(
      NetworkFetchDurabilityError,
    );
    storage.data = "{";
    expect(() => new NetworkFetchStateStore(storage, "host-a")).toThrow(
      NetworkFetchDurabilityError,
    );
  });

  it("uses private real files and refuses missing state in an existing identity directory", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "fetch-state-"));
    directories.push(parent);
    const directory = path.join(parent, "network-fetch");
    const file = path.join(directory, "state.json");
    const first = new NetworkFetchStateStore(new FileNetworkFetchStateStorage(directory), "host-a");
    const record = recordFor(first);
    first.put(record);
    first.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8")).running).toBe(false);
    const restarted = new NetworkFetchStateStore(
      new FileNetworkFetchStateStorage(directory),
      "host-a",
    );
    expect(restarted.get(record.destinationId)).toEqual(record);
    restarted.close();
    writeFileSync(file, "corrupted");
    expect(
      () => new NetworkFetchStateStore(new FileNetworkFetchStateStorage(directory), "host-a"),
    ).toThrow(NetworkFetchDurabilityError);
    rmSync(file);
    expect(
      () => new NetworkFetchStateStore(new FileNetworkFetchStateStorage(directory), "host-a"),
    ).toThrow(NetworkFetchDurabilityError);
  });
});
