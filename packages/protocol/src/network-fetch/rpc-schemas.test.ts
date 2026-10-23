import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "../messages.js";
import { validateWSOutboundMessage } from "../validation/ws-outbound.js";
import {
  NETWORK_FETCH_LIMITS,
  NetworkFetchDescriptorSchema,
  NetworkFetchEpochSchema,
  NetworkFetchRequestCleanupRequestSchema,
  NetworkFetchConfigurationSchema,
} from "./rpc-schemas.js";

const destinationId = "a".repeat(52);
const descriptor = {
  destinationId,
  origin: "https://destination.test",
  pathPrefix: "/",
  allowlistRevision: 1,
  authorityEpoch: "9007199254740993",
  cleanupRequiredEpoch: null,
  contentOrigin: `https://${destinationId}.content.test`,
  assetVersion: "v1",
};
describe("network fetch RPC contract", () => {
  it("transports configuration without defaults and accepts legacy envelopes", () => {
    const old = { status: "server_info", serverId: "host", hostname: null, version: null };
    const configuration = {
      dedicatedContentDomain: "content.test",
      assetVersion: "v1",
      bootstrapPath: "/bootstrap.html",
      pathPrefix: "/",
      ttlMs: 1000,
      handshakeTimeoutMs: 500,
    };
    expect(ServerInfoStatusPayloadSchema.parse(old)).not.toHaveProperty(
      "networkFetchConfiguration",
    );
    const current = { ...old, networkFetchConfiguration: configuration };
    expect(ServerInfoStatusPayloadSchema.parse(current).networkFetchConfiguration).toEqual(
      configuration,
    );
    const legacy = z
      .object({
        status: z.literal("server_info"),
        serverId: z.string(),
        hostname: z.string().nullable(),
        version: z.string().nullable(),
      })
      .passthrough();
    expect(legacy.parse(current)).toMatchObject(old);
    expect(
      ServerInfoStatusPayloadSchema.safeParse({ ...old, networkFetchConfiguration: null }).success,
    ).toBe(false);
    expect(
      validateWSOutboundMessage({ type: "session", message: { type: "status", payload: current } })
        .success,
    ).toBe(true);
    for (const change of [
      { bootstrapPath: "//foreign.test/x" },
      { bootstrapPath: "/\\foreign.test/x" },
      { bootstrapPath: "https://foreign.test/x" },
      { bootstrapPath: "/x?query" },
      { bootstrapPath: "/x#fragment" },
      { bootstrapPath: "/x\n" },
      { pathPrefix: "//other.test" },
      { dedicatedContentDomain: "content.test\n" },
      { ttlMs: Infinity },
      { ttlMs: 2147483648 },
      { handshakeTimeoutMs: 0 },
      { assetVersion: "a".repeat(257) },
    ])
      expect(
        NetworkFetchConfigurationSchema.safeParse({ ...configuration, ...change }).success,
      ).toBe(false);
  });
  it.each([
    {
      type: "network.fetch.resolve_destination.request",
      origin: descriptor.origin,
      pathPrefix: "/",
    },
    { type: "network.fetch.reconcile_destination.request", destinationId, knownEpoch: "0" },
    {
      type: "network.fetch.open.request",
      destinationId,
      expectedAuthorityEpoch: descriptor.authorityEpoch,
      allowlistRevision: 1,
      scope: { origin: descriptor.origin, pathPrefix: "/" },
      ttlMs: 1000,
    },
    { type: "network.fetch.close.request", subscriptionId: "owned-source" },
    {
      type: "network.fetch.request_cleanup.request",
      destinationId,
      expectedAuthorityEpoch: descriptor.authorityEpoch,
    },
  ])("accepts $type", (message) => {
    const request = { ...message, requestId: "correlation" };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  });
  it.each([
    { type: "network.fetch.resolve_destination.response", result: { descriptor } },
    {
      type: "network.fetch.reconcile_destination.response",
      result: { descriptor, state: "active", cleanupRequiredEpoch: null },
    },
    {
      type: "network.fetch.open.response",
      result: { subscriptionId: "owned-source", descriptor, limits: NETWORK_FETCH_LIMITS },
    },
    { type: "network.fetch.close.response", result: { subscriptionId: "owned-source" } },
    {
      type: "network.fetch.request_cleanup.response",
      result: {
        destinationId,
        authorityEpoch: "9007199254740994",
        cleanupRequiredEpoch: "9007199254740994",
        status: "cleanup_pending",
      },
    },
  ])("validates $type with both wire validators", ({ type, result }) => {
    for (const payload of [
      { requestId: "correlation", ok: true, ...result },
      {
        requestId: "correlation",
        ok: false,
        error: { code: "durability_unavailable", message: "Persistence unavailable" },
      },
    ]) {
      const message = { type, payload };
      expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(true);
      expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
    }
  });
  it.each(["-1", "01", "+1", "1.0", "1e3", "", " 1", "1\n"])(
    "rejects noncanonical epoch %j",
    (epoch) => {
      expect(NetworkFetchEpochSchema.safeParse(epoch).success).toBe(false);
    },
  );
  it("preserves epochs above the safe integer range", () => {
    expect(NetworkFetchDescriptorSchema.parse(descriptor).authorityEpoch).toBe("9007199254740993");
  });
  it("requests cleanup without a subscription and rejects client attestations", () => {
    const request = {
      type: "network.fetch.request_cleanup.request",
      requestId: "cleanup",
      destinationId,
      expectedAuthorityEpoch: "1",
    };
    expect(NetworkFetchRequestCleanupRequestSchema.parse(request)).toEqual(request);
    for (const extra of [
      { subscriptionId: "owner" },
      { principalId: "other" },
      { clean: true },
      { ack: true },
    ]) {
      expect(
        NetworkFetchRequestCleanupRequestSchema.safeParse({ ...request, ...extra }).success,
      ).toBe(false);
    }
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "network.fetch.request_cleanup.response",
        payload: {
          requestId: "cleanup",
          ok: true,
          destinationId,
          authorityEpoch: "2",
          cleanupRequiredEpoch: "2",
          status: "clean",
        },
      }).success,
    ).toBe(false);
  });
  it("accepts old server info and leaves the new feature absent", () => {
    const old = {
      status: "server_info",
      serverId: "host",
      hostname: null,
      version: null,
      features: { ownedSubscriptions: true },
    };
    expect(ServerInfoStatusPayloadSchema.parse(old).features?.networkFetch).toBeUndefined();
    const withFeature = { ...old, features: { ...old.features, networkFetch: false } };
    expect(ServerInfoStatusPayloadSchema.parse(withFeature).features?.networkFetch).toBe(false);
  });
  it("accepts persistent owned closure and rejects cleanup completion as closure", () => {
    for (const reason of ["closed", "revoked", "expired", "allowlist_changed"]) {
      const message = {
        type: "network.fetch.closed.update",
        payload: { subscriptionId: "owner", reason },
      };
      expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
    }
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "network.fetch.closed.update",
        payload: { subscriptionId: "owner", reason: "clean" },
      }).success,
    ).toBe(false);
  });
});
