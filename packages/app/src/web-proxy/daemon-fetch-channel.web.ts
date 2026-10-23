import {
  NetworkFetchOpcode,
  NetworkFetchRpcError,
  type NetworkFetch,
  type NetworkFetchEnd,
  type NetworkFetchServerFrame,
} from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { NetworkFetchDescriptor } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import type {
  NetworkFetchChannel,
  NetworkFetchChannelHandlers,
  NetworkFetchOutboundFrame,
  SessionOpenFrame,
} from "./network-fetch-transport";
import type { WebProxyProductErrorCode } from "./product-types";

export interface DaemonFetchChannelOptions {
  client: Pick<DaemonClient, "openNetworkFetch">;
  descriptor: NetworkFetchDescriptor;
  onError(code: WebProxyProductErrorCode): void;
}

export function createDaemonFetchChannel(options: DaemonFetchChannelOptions): NetworkFetchChannel {
  let handlers: NetworkFetchChannelHandlers | null = null;
  let handle: NetworkFetch | null = null;
  let opening = false;
  let admitted = false;
  let closed = false;
  let unsubscribeFrame = () => {};
  let unsubscribeEnd = () => {};

  function closeHandle(current: NetworkFetch): void {
    void current.close().catch((error: unknown) => {
      const code = error instanceof NetworkFetchRpcError ? error.code : "protocol_error";
      options.onError(code);
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    unsubscribeFrame();
    unsubscribeEnd();
    if (handle !== null) closeHandle(handle);
    handle = null;
  }

  function fail(error: unknown): void {
    if (closed) return;
    const code = error instanceof NetworkFetchRpcError ? error.code : "protocol_error";
    options.onError(code);
    close();
    handlers?.lost();
  }

  function onEnd(reason: NetworkFetchEnd): void {
    if (closed) return;
    if (!admitted) {
      let code: WebProxyProductErrorCode = "channel_lost";
      if (reason === "revoked" || reason === "allowlist_changed") code = "cleanup_pending";
      else if (reason === "expired" || reason === "protocol_error") code = reason;
      options.onError(code);
    }
    closed = true;
    unsubscribeFrame();
    unsubscribeEnd();
    handle = null;
    if (reason === "channel_lost") handlers?.lost();
    else if (reason === "protocol_error") {
      handlers?.frame({ type: "protocol_error", violation: "session_closed" });
    } else handlers?.frame({ type: "closed", reason });
  }

  function onFrame(frame: NetworkFetchServerFrame): void {
    if (closed) return;
    const requestId = frame.fetchId;
    switch (frame.opcode) {
      case NetworkFetchOpcode.Head:
        handlers?.frame({ type: "head", requestId, head: frame.head });
        break;
      case NetworkFetchOpcode.Body:
        handlers?.frame({ type: "body", requestId, data: frame.data });
        break;
      case NetworkFetchOpcode.End:
        handlers?.frame({ type: "end", requestId });
        break;
      case NetworkFetchOpcode.Credit:
        handlers?.frame({ type: "uploadCredit", requestId, bytes: frame.bytes });
        break;
      case NetworkFetchOpcode.Fail:
        handlers?.frame({ type: "fail", requestId, code: frame.failure.code });
        break;
      case NetworkFetchOpcode.Cancelled:
        handlers?.frame({ type: "cancelled", requestId, dnsPending: frame.dnsPending });
        break;
    }
  }

  async function open(frame: SessionOpenFrame): Promise<void> {
    const expected = options.descriptor;
    const matchesScope =
      frame.scope.origin === expected.origin && frame.scope.pathPrefix === expected.pathPrefix;
    if (!matchesScope) {
      fail(new NetworkFetchRpcError("open", "scope_not_allowlisted"));
      return;
    }
    try {
      const opened = await options.client.openNetworkFetch({
        destinationId: expected.destinationId,
        expectedAuthorityEpoch: expected.authorityEpoch,
        allowlistRevision: expected.allowlistRevision,
        scope: frame.scope,
        ttlMs: frame.ttlMs,
        limits: frame.limits,
      });
      if (closed) {
        closeHandle(opened);
        return;
      }
      handle = opened;
      const descriptor = opened.descriptor;
      const matchesDescriptor =
        descriptor.destinationId === expected.destinationId &&
        descriptor.authorityEpoch === expected.authorityEpoch &&
        descriptor.allowlistRevision === expected.allowlistRevision &&
        descriptor.origin === expected.origin &&
        descriptor.pathPrefix === expected.pathPrefix &&
        descriptor.contentOrigin === expected.contentOrigin &&
        descriptor.assetVersion === expected.assetVersion &&
        descriptor.cleanupRequiredEpoch === null;
      if (!matchesDescriptor) throw new NetworkFetchRpcError("open", "protocol_error");
      unsubscribeFrame = opened.onFrame(onFrame);
      unsubscribeEnd = opened.onEnd(onEnd);
      if (!closed) {
        admitted = true;
        handlers?.frame({ type: "session.opened", limits: opened.limits });
      }
    } catch (error) {
      fail(error);
    }
  }

  function send(frame: NetworkFetchOutboundFrame): void {
    if (closed) return;
    if (frame.type === "close") {
      close();
      return;
    }
    if (frame.type === "session.open") {
      if (opening || handlers === null) {
        fail(new NetworkFetchRpcError("open", "protocol_error"));
        return;
      }
      opening = true;
      void open(frame);
      return;
    }
    if (handle === null) {
      fail(new NetworkFetchRpcError("open", "protocol_error"));
      return;
    }
    const fetchId = frame.requestId;
    try {
      switch (frame.type) {
        case "request": {
          const { method, url, headers, redirect, body } = frame;
          handle.send({
            opcode: NetworkFetchOpcode.Request,
            fetchId,
            request: { method, url, headers, redirect, body },
          });
          break;
        }
        case "body":
          handle.send({ opcode: NetworkFetchOpcode.Body, fetchId, data: frame.data });
          break;
        case "endBody":
          handle.send({ opcode: NetworkFetchOpcode.End, fetchId });
          break;
        case "cancel":
          handle.send({ opcode: NetworkFetchOpcode.Cancel, fetchId });
          break;
        case "grantCredit":
          handle.send({ opcode: NetworkFetchOpcode.Credit, fetchId, bytes: frame.bytes });
          break;
      }
    } catch (error) {
      fail(error);
    }
  }

  return {
    send,
    listen(next) {
      if (handlers !== null) {
        fail(new NetworkFetchRpcError("open", "protocol_error"));
        return;
      }
      handlers = next;
      if (closed) handlers.lost();
    },
    close,
  };
}
