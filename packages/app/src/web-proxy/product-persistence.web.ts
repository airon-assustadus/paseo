import { z } from "zod";
import {
  NetworkFetchEpochSchema,
  NetworkFetchDestinationIdSchema,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";

const epochSchema = NetworkFetchEpochSchema.max(128);
const identitySchema = z.string().min(1).max(256);

const recordSchema = z
  .object({
    version: z.literal(1),
    serverId: identitySchema,
    destinationId: NetworkFetchDestinationIdSchema,
    authorityEpoch: epochSchema,
    cleanupRequiredEpoch: epochSchema.nullable(),
    cleanupRequestBaseEpoch: epochSchema.nullable(),
    status: z.enum(["observed", "cleanup_pending"]),
    assetVersion: z.string().min(1).max(256),
  })
  .strict()
  .refine((record) => {
    const hasPending =
      record.cleanupRequiredEpoch !== null || record.cleanupRequestBaseEpoch !== null;
    return !hasPending || record.status === "cleanup_pending";
  });

export type WebProxyProductRecord = z.infer<typeof recordSchema>;
export type WebProxyProductDestinationKey = Pick<
  WebProxyProductRecord,
  "serverId" | "destinationId"
>;

export interface WebProxyProductPersistence {
  read(key: WebProxyProductDestinationKey): Promise<WebProxyProductRecord | null>;
  merge(record: WebProxyProductRecord): Promise<WebProxyProductRecord>;
  close(): void;
}

export class WebProxyProductPersistenceError extends Error {
  constructor() {
    super("Web proxy persistence unavailable");
    this.name = "WebProxyProductPersistenceError";
  }
}

function newerEpoch(previous: string | null, next: string | null): string | null {
  if (previous === null) return next;
  if (next === null) return previous;
  return BigInt(previous) > BigInt(next) ? previous : next;
}

function mergeRecords(
  previous: WebProxyProductRecord | null,
  next: WebProxyProductRecord,
): WebProxyProductRecord {
  if (previous === null) return next;
  const newest = BigInt(previous.authorityEpoch) > BigInt(next.authorityEpoch) ? previous : next;
  const pending = previous.status === "cleanup_pending" || next.status === "cleanup_pending";
  return {
    ...newest,
    cleanupRequiredEpoch: newerEpoch(previous.cleanupRequiredEpoch, next.cleanupRequiredEpoch),
    cleanupRequestBaseEpoch: previous.cleanupRequestBaseEpoch ?? next.cleanupRequestBaseEpoch,
    status: pending ? "cleanup_pending" : "observed",
  };
}

export interface WebProxyProductPersistenceOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
}

export function createWebProxyProductPersistence(
  options: WebProxyProductPersistenceOptions = {},
): WebProxyProductPersistence {
  const databaseName = options.databaseName ?? "paseo-web-proxy-product";
  let database: Promise<IDBDatabase> | null = null;
  let closed = false;

  function connect(): Promise<IDBDatabase> {
    if (closed) return Promise.reject(new WebProxyProductPersistenceError());
    if (database !== null) return database;
    database = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      function fail(): void {
        settled = true;
        reject(new WebProxyProductPersistenceError());
      }
      try {
        const factory = options.indexedDB ?? globalThis.indexedDB;
        if (!factory) {
          fail();
          return;
        }
        const request = factory.open(databaseName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("destinations", {
            keyPath: ["serverId", "destinationId"],
          });
        };
        request.addEventListener("error", fail);
        request.onblocked = fail;
        request.onsuccess = () => {
          const connection = request.result;
          if (settled || closed) {
            connection.close();
            fail();
            return;
          }
          connection.onversionchange = () => {
            closed = true;
            connection.close();
          };
          settled = true;
          resolve(connection);
        };
      } catch {
        fail();
      }
    });
    return database;
  }

  async function transact(
    key: WebProxyProductDestinationKey,
    next: WebProxyProductRecord | null,
  ): Promise<WebProxyProductRecord | null> {
    const connection = await connect();
    return new Promise((resolve, reject) => {
      let result: WebProxyProductRecord | null = null;
      function fail(): void {
        reject(new WebProxyProductPersistenceError());
      }
      try {
        const mode = next === null ? "readonly" : "readwrite";
        const transaction = connection.transaction("destinations", mode, { durability: "strict" });
        transaction.addEventListener("abort", fail);
        transaction.addEventListener("error", fail);
        transaction.oncomplete = () => resolve(result);
        const store = transaction.objectStore("destinations");
        const request = store.get([key.serverId, key.destinationId]);
        request.onsuccess = () => {
          const stored: unknown = request.result;
          const parsed = recordSchema.nullable().safeParse(stored ?? null);
          const matchesKey =
            parsed.success &&
            (parsed.data === null ||
              (parsed.data.serverId === key.serverId &&
                parsed.data.destinationId === key.destinationId));
          if (!parsed.success || !matchesKey) {
            transaction.abort();
            return;
          }
          result = parsed.data;
          if (next !== null) {
            result = mergeRecords(result, next);
            try {
              store.put(result);
            } catch {
              transaction.abort();
            }
          }
        };
      } catch {
        fail();
      }
    });
  }

  return {
    read: (key) => transact(key, null),
    async merge(record) {
      const parsed = recordSchema.safeParse(record);
      if (!parsed.success) throw new WebProxyProductPersistenceError();
      const result = await transact(parsed.data, parsed.data);
      if (result === null) throw new WebProxyProductPersistenceError();
      return result;
    },
    close() {
      closed = true;
      void database?.then(
        (connection) => connection.close(),
        () => undefined,
      );
    },
  };
}
