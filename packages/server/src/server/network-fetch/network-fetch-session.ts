import {
  encodeNetworkFetchFrame,
  NetworkFetchOpcode,
  type NetworkFetchBinaryFrame,
  type NetworkFetchServerFrame,
} from "@getpaseo/protocol/binary-frames/network-fetch";
import type {
  NetworkFetchCloseRequest,
  NetworkFetchOpenRequest,
  NetworkFetchReconcileDestinationRequest,
  NetworkFetchRequestCleanupRequest,
  NetworkFetchResolveDestinationRequest,
  NetworkFetchRpcFailure,
} from "@getpaseo/protocol/network-fetch/rpc-schemas";
import type { SessionOutboundMessage } from "../messages.js";
import type { OwnedSubscription } from "../session/owned-subscriptions/index.js";
import { AllowlistEntryError } from "./allowlist.js";
import { NetworkFetchOpenError, NetworkFetchProtocolError } from "./errors.js";
import { NetworkFetchControlError, type NetworkFetchManager } from "./network-fetch-manager.js";
import type { NetworkFetchSession } from "./session.js";

export const NETWORK_FETCH_FAMILY = "network.fetch";

export interface NetworkFetchHost {
  principalId: string | null;
  emit(message: SessionOutboundMessage): void;
  begin(stop: (id: string) => void | Promise<void>): OwnedSubscription;
  currentSource(): object | undefined;
  requestSignal(): AbortSignal;
  supportsFetch(source: object): boolean;
  allowsNetworkProxy(): boolean;
  reportReleaseFailure(): void;
}

type FetchRequest =
  | NetworkFetchResolveDestinationRequest
  | NetworkFetchReconcileDestinationRequest
  | NetworkFetchRequestCleanupRequest
  | NetworkFetchOpenRequest
  | NetworkFetchCloseRequest;

interface Subscription {
  owner: OwnedSubscription;
  core: NetworkFetchSession;
}

export class NetworkFetchProductSession {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly issued = new WeakMap<object, Set<string>>();

  get available(): boolean {
    return this.manager?.available ?? false;
  }

  constructor(
    private readonly host: NetworkFetchHost,
    private readonly manager: NetworkFetchManager | null,
  ) {}

  async handle(request: FetchRequest): Promise<void> {
    try {
      const { manager, principalId, source } = this.admit();
      switch (request.type) {
        case "network.fetch.resolve_destination.request":
          this.host.emit({
            type: "network.fetch.resolve_destination.response",
            payload: {
              requestId: request.requestId,
              ok: true,
              descriptor: manager.resolve(principalId, request),
            },
          });
          return;
        case "network.fetch.reconcile_destination.request":
          this.host.emit({
            type: "network.fetch.reconcile_destination.response",
            payload: {
              requestId: request.requestId,
              ok: true,
              ...manager.reconcile(principalId, request.destinationId),
            },
          });
          return;
        case "network.fetch.request_cleanup.request":
          this.host.emit({
            type: "network.fetch.request_cleanup.response",
            payload: {
              requestId: request.requestId,
              ok: true,
              ...manager.requestCleanup(
                principalId,
                request.destinationId,
                request.expectedAuthorityEpoch,
              ),
            },
          });
          return;
        case "network.fetch.open.request":
          this.open(request, manager, principalId, source);
          return;
        case "network.fetch.close.request": {
          const subscription = this.subscriptions.get(request.subscriptionId);
          if (
            !this.issued.get(source)?.has(request.subscriptionId) ||
            (subscription && subscription.owner.source !== source)
          ) {
            throw new NetworkFetchControlError("permission_denied");
          }
          if (subscription) {
            subscription.core.close();
            await subscription.owner.release();
          }
          this.host.emit({
            type: "network.fetch.close.response",
            payload: {
              requestId: request.requestId,
              ok: true,
              subscriptionId: request.subscriptionId,
            },
          });
        }
      }
    } catch (error) {
      this.fail(request, error);
    }
  }

  async handleFrame(frame: NetworkFetchBinaryFrame, source: object): Promise<void> {
    const subscription = this.subscriptions.get(frame.subscriptionId);
    if (!subscription) {
      if (this.issued.get(source)?.has(frame.subscriptionId)) return;
      throw new NetworkFetchProtocolError("unknown_request", "Unknown owned fetch subscription");
    }
    const { owner, core } = subscription;
    if (owner.source !== source)
      throw new NetworkFetchProtocolError("unknown_request", "Unknown owned fetch subscription");
    if (
      owner.signal.aborted ||
      !this.host.allowsNetworkProxy() ||
      !this.host.supportsFetch(source)
    ) {
      core.revoke();
      return;
    }
    try {
      switch (frame.opcode) {
        case NetworkFetchOpcode.Request:
          core.request({ ...frame.request, requestId: frame.fetchId });
          return;
        case NetworkFetchOpcode.Body:
          core.writeBody(frame.fetchId, frame.data);
          return;
        case NetworkFetchOpcode.End:
          core.endBody(frame.fetchId);
          return;
        case NetworkFetchOpcode.Credit:
          core.grantCredit(frame.fetchId, frame.bytes);
          return;
        case NetworkFetchOpcode.Cancel: {
          const release = core.cancel(frame.fetchId);
          if (!release) return;
          const result = await release;
          if (!owner.signal.aborted && core.isOpen)
            owner.emitBinary(
              encodeNetworkFetchFrame(
                {
                  opcode: NetworkFetchOpcode.Cancelled,
                  subscriptionId: owner.id,
                  fetchId: frame.fetchId,
                  dnsPending: result.dnsPending,
                },
                "host_to_client",
              ),
            );
          return;
        }
        default:
          throw new NetworkFetchProtocolError("unknown_request", "Invalid fetch frame direction");
      }
    } catch (error) {
      core.close();
      throw error;
    }
  }

  revoke(): void {
    for (const { core } of this.subscriptions.values()) core.revoke();
  }

  private admit(): { manager: NetworkFetchManager; principalId: string; source: object } {
    const source = this.host.currentSource();
    if (!this.host.principalId || !this.host.allowsNetworkProxy())
      throw new NetworkFetchControlError("permission_denied");
    if (!source || !this.host.supportsFetch(source))
      throw new NetworkFetchControlError("unsupported_capability");
    if (this.host.requestSignal().aborted) throw new NetworkFetchControlError("permission_denied");
    if (!this.manager) throw new NetworkFetchControlError("unsupported_capability");
    return { manager: this.manager, principalId: this.host.principalId, source };
  }

  private open(
    request: NetworkFetchOpenRequest,
    manager: NetworkFetchManager,
    principalId: string,
    source: object,
  ): void {
    const issued = this.issued.get(source) ?? new Set<string>();
    if (issued.size >= 4096) throw new NetworkFetchControlError("limit_exceeded");
    const owner = this.host.begin((id) => this.stop(id));
    const send = (frame: NetworkFetchServerFrame) =>
      owner.emitBinary(encodeNetworkFetchFrame(frame, "host_to_client"));
    try {
      const opened = manager.open({
        principalId,
        request,
        isAuthorized: () =>
          !owner.signal.aborted &&
          this.host.allowsNetworkProxy() &&
          this.host.supportsFetch(source),
        sink: {
          head: (fetchId, head) =>
            send({ opcode: NetworkFetchOpcode.Head, subscriptionId: owner.id, fetchId, head }),
          body: (fetchId, data) =>
            send({ opcode: NetworkFetchOpcode.Body, subscriptionId: owner.id, fetchId, data }),
          end: (fetchId) =>
            send({ opcode: NetworkFetchOpcode.End, subscriptionId: owner.id, fetchId }),
          fail: (fetchId, failure) =>
            send({ opcode: NetworkFetchOpcode.Fail, subscriptionId: owner.id, fetchId, failure }),
          uploadCredit: (fetchId, bytes) =>
            send({ opcode: NetworkFetchOpcode.Credit, subscriptionId: owner.id, fetchId, bytes }),
          closed: (reason) => {
            try {
              owner.emit({
                type: "network.fetch.closed.update",
                payload: { subscriptionId: owner.id, reason },
              });
            } finally {
              void owner.release().catch(() => this.host.reportReleaseFailure());
            }
          },
        },
      });
      this.subscriptions.set(owner.id, { owner, core: opened.core });
      issued.add(owner.id);
      this.issued.set(source, issued);
      this.host.emit({
        type: "network.fetch.open.response",
        payload: {
          requestId: request.requestId,
          ok: true,
          subscriptionId: owner.id,
          descriptor: opened.descriptor,
          limits: opened.core.limits,
        },
      });
    } catch (error) {
      void owner.release().catch(() => this.host.reportReleaseFailure());
      throw error;
    }
  }

  private async stop(id: string): Promise<void> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    subscription.core.close();
    await subscription.core.released();
  }

  private fail(request: FetchRequest, error: unknown): void {
    let code: NetworkFetchRpcFailure["code"] = "identity_unavailable";
    if (error instanceof NetworkFetchControlError || error instanceof NetworkFetchOpenError)
      code = error.code;
    else if (error instanceof AllowlistEntryError) code = "invalid_configuration";
    const payload = {
      requestId: request.requestId,
      ok: false as const,
      error: { code, message: code },
    };
    switch (request.type) {
      case "network.fetch.resolve_destination.request":
        this.host.emit({ type: "network.fetch.resolve_destination.response", payload });
        return;
      case "network.fetch.reconcile_destination.request":
        this.host.emit({ type: "network.fetch.reconcile_destination.response", payload });
        return;
      case "network.fetch.request_cleanup.request":
        this.host.emit({ type: "network.fetch.request_cleanup.response", payload });
        return;
      case "network.fetch.open.request":
        this.host.emit({ type: "network.fetch.open.response", payload });
        return;
      case "network.fetch.close.request":
        this.host.emit({ type: "network.fetch.close.response", payload });
    }
  }
}
