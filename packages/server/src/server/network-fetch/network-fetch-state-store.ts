import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  NetworkFetchDescriptorSchema,
  NetworkFetchEpochSchema,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { parseTrustedTarget } from "./allowlist.js";

const DestinationRecordSchema = NetworkFetchDescriptorSchema.extend({
  principalId: z.string().min(1),
  allowlistId: z.string().min(1),
  cleanupRequestBaseEpoch: NetworkFetchEpochSchema.nullable(),
  state: z.enum(["active", "revoked", "removed"]),
}).strict();

const StateSchema = z
  .object({
    version: z.literal(1),
    serverId: z.string().min(1),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    running: z.boolean(),
    records: z.array(DestinationRecordSchema).max(10_000),
  })
  .strict();

export type NetworkFetchDestinationRecord = z.infer<typeof DestinationRecordSchema>;
type StoredState = z.infer<typeof StateSchema>;

export interface NetworkFetchStateStorage {
  read(): string | null;
  write(data: string): void;
}

export class NetworkFetchDurabilityError extends Error {
  constructor() {
    super("Network fetch durable state is unavailable");
    this.name = "NetworkFetchDurabilityError";
  }
}

export class FileNetworkFetchStateStorage implements NetworkFetchStateStorage {
  private readonly file: string;
  private fresh = false;

  constructor(private readonly directory: string) {
    this.file = path.join(directory, "state.json");
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      this.fresh = true;
      syncPath(path.dirname(directory));
    }
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
      throw new NetworkFetchDurabilityError();
    }
    chmodSync(directory, 0o700);
  }

  read(): string | null {
    if (!existsSync(this.file) && this.fresh) return null;
    if (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink()) {
      throw new NetworkFetchDurabilityError();
    }
    chmodSync(this.file, 0o600);
    return readFileSync(this.file, "utf8");
  }

  write(data: string): void {
    writePrivateFileAtomicSync(this.file, data);
    chmodSync(this.file, 0o600);
    syncPath(this.file);
    syncPath(this.directory);
    this.fresh = false;
  }
}

function syncPath(target: string): void {
  const descriptor = openSync(target, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function nextNetworkFetchEpoch(epoch: string): string {
  return (BigInt(NetworkFetchEpochSchema.parse(epoch)) + 1n).toString();
}

function destinationIdFor(
  key: string,
  serverId: string,
  principalId: string,
  origin: string,
): string {
  const digest = createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify([1, principalId, serverId, origin]))
    .digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let result = "";
  let bits = 0;
  let accumulator = 0;
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

export class NetworkFetchStateStore {
  private state: StoredState;
  private available = true;
  private closed = false;

  constructor(
    private readonly storage: NetworkFetchStateStorage,
    serverId: string,
  ) {
    try {
      const raw = storage.read();
      this.state =
        raw === null
          ? {
              version: 1,
              serverId,
              key: randomBytes(32).toString("hex"),
              running: false,
              records: [],
            }
          : StateSchema.parse(JSON.parse(raw));
      if (this.state.serverId !== serverId) throw new NetworkFetchDurabilityError();
      const seen = new Set<string>();
      for (const record of this.state.records) {
        const target = parseTrustedTarget(record);
        const expected = destinationIdFor(
          this.state.key,
          serverId,
          record.principalId,
          target.origin,
        );
        if (
          expected !== record.destinationId ||
          target.origin !== record.origin ||
          seen.has(expected)
        ) {
          throw new NetworkFetchDurabilityError();
        }
        if (
          record.cleanupRequiredEpoch !== null &&
          record.cleanupRequiredEpoch !== record.authorityEpoch
        ) {
          throw new NetworkFetchDurabilityError();
        }
        if (
          (record.state !== "active" && record.cleanupRequiredEpoch === null) ||
          (record.cleanupRequestBaseEpoch !== null &&
            (record.cleanupRequiredEpoch === null ||
              BigInt(record.cleanupRequestBaseEpoch) + 1n !== BigInt(record.authorityEpoch)))
        ) {
          throw new NetworkFetchDurabilityError();
        }
        seen.add(expected);
      }
      if (this.state.running) {
        this.state.records = this.state.records.map((record) => {
          const epoch = nextNetworkFetchEpoch(record.authorityEpoch);
          return {
            ...record,
            authorityEpoch: epoch,
            cleanupRequiredEpoch: epoch,
            cleanupRequestBaseEpoch: null,
          };
        });
      }
      this.state.running = true;
      this.persist();
    } catch {
      throw new NetworkFetchDurabilityError();
    }
  }

  get isAvailable(): boolean {
    return this.available && !this.closed;
  }

  identity(principalId: string, origin: string): string {
    this.assertAvailable();
    const target = parseTrustedTarget({ origin, pathPrefix: "/" });
    return destinationIdFor(this.state.key, this.state.serverId, principalId, target.origin);
  }

  get(destinationId: string): NetworkFetchDestinationRecord | null {
    this.assertAvailable();
    const record = this.state.records.find((entry) => entry.destinationId === destinationId);
    return record ? { ...record } : null;
  }

  records(): NetworkFetchDestinationRecord[] {
    this.assertAvailable();
    return this.state.records.map((record) => ({ ...record }));
  }

  put(record: NetworkFetchDestinationRecord): void {
    this.assertAvailable();
    const parsed = DestinationRecordSchema.parse(record);
    if (this.identity(parsed.principalId, parsed.origin) !== parsed.destinationId) {
      throw new NetworkFetchDurabilityError();
    }
    const index = this.state.records.findIndex(
      (entry) => entry.destinationId === parsed.destinationId,
    );
    if (index < 0) {
      if (this.state.records.length >= 10_000) throw new NetworkFetchDurabilityError();
      this.state.records.push(parsed);
    } else {
      const previous = this.state.records[index];
      if (
        BigInt(parsed.authorityEpoch) < BigInt(previous.authorityEpoch) ||
        (previous.cleanupRequiredEpoch !== null && parsed.cleanupRequiredEpoch === null)
      ) {
        throw new NetworkFetchDurabilityError();
      }
      this.state.records[index] = parsed;
    }
    this.persist();
  }

  close(): void {
    this.assertAvailable();
    this.state.running = false;
    this.persist();
    this.closed = true;
  }

  private assertAvailable(): void {
    if (!this.isAvailable) throw new NetworkFetchDurabilityError();
  }

  private persist(): void {
    try {
      this.storage.write(JSON.stringify(this.state));
    } catch {
      this.available = false;
      throw new NetworkFetchDurabilityError();
    }
  }
}
