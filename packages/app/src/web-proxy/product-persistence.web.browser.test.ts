import { afterEach, describe, expect, it } from "vitest";
import {
  createWebProxyProductPersistence,
  WebProxyProductPersistenceError,
  type WebProxyProductPersistence,
  type WebProxyProductRecord,
} from "./product-persistence.web";

const stores: WebProxyProductPersistence[] = [];
const databases: string[] = [];
const observed: WebProxyProductRecord = {
  version: 1,
  serverId: "server-one",
  destinationId: "a".repeat(52),
  authorityEpoch: "9007199254740993",
  cleanupRequiredEpoch: null,
  cleanupRequestBaseEpoch: null,
  status: "observed",
  assetVersion: "assets-one",
};

function open(databaseName = crypto.randomUUID()): WebProxyProductPersistence {
  const store = createWebProxyProductPersistence({ databaseName });
  stores.push(store);
  databases.push(databaseName);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const name of new Set(databases.splice(0))) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.addEventListener("error", () => reject(request.error));
    });
  }
});

describe("product persistence", () => {
  it("preserves an unconfirmed cleanup intention after closing and reopening storage", async () => {
    const databaseName = crypto.randomUUID();
    const first = open(databaseName);
    const pending: WebProxyProductRecord = {
      ...observed,
      cleanupRequestBaseEpoch: observed.authorityEpoch,
      status: "cleanup_pending",
    };
    await first.merge(pending);
    first.close();
    expect(await open(databaseName).read(observed)).toEqual(pending);
  });

  it("does not erase a pending request with a racing stale observation from another connection", async () => {
    const databaseName = crypto.randomUUID();
    const first = open(databaseName);
    const second = open(databaseName);
    await first.merge(observed);
    const pending: WebProxyProductRecord = {
      ...observed,
      authorityEpoch: "9007199254740994",
      cleanupRequiredEpoch: "9007199254740994",
      cleanupRequestBaseEpoch: observed.authorityEpoch,
      status: "cleanup_pending",
    };
    await Promise.all([first.merge(pending), second.merge(observed)]);
    expect(await second.read(observed)).toEqual(pending);
  });

  it("isolates records by host and treats absence as unknown", async () => {
    const store = open();
    await store.merge(observed);
    expect(await store.read({ ...observed, serverId: "another-server" })).toBeNull();
    expect(await store.read({ ...observed, destinationId: "another-destination" })).toBeNull();
  });

  it("rejects unexpected persisted credentials and noncanonical epochs", async () => {
    const store = open();
    await expect(store.merge({ ...observed, authorityEpoch: "01" })).rejects.toBeInstanceOf(
      WebProxyProductPersistenceError,
    );
    const withSecret = { ...observed, token: "must-not-persist" };
    await expect(store.merge(withSecret)).rejects.toBeInstanceOf(WebProxyProductPersistenceError);
    expect(await store.read(observed)).toBeNull();
  });

  it("fails closed on corrupted stored records", async () => {
    const databaseName = crypto.randomUUID();
    const store = open(databaseName);
    await store.merge(observed);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.addEventListener("error", () => reject(request.error));
      request.onsuccess = () => {
        const connection = request.result;
        const transaction = connection.transaction("destinations", "readwrite");
        transaction.objectStore("destinations").put({ ...observed, version: 99 });
        transaction.oncomplete = () => {
          connection.close();
          resolve();
        };
        transaction.addEventListener("error", () => reject(transaction.error));
      };
    });
    await expect(store.read(observed)).rejects.toBeInstanceOf(WebProxyProductPersistenceError);
    await expect(store.merge(observed)).rejects.toBeInstanceOf(WebProxyProductPersistenceError);
  });
});
