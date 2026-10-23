import { describe, expect, it } from "vitest";

import {
  decodeBinaryFrame,
  encodeFileTransferFrame,
  encodeTerminalStreamFrame,
  FileTransferOpcode,
  TerminalStreamOpcode,
  encodeTunnelFrame,
  TunnelOpcode,
  type TunnelFrame,
  NetworkFetchOpcode,
  encodeNetworkFetchFrame,
  RemoteBrowserOpcode,
  encodeRemoteBrowserFrame,
} from "./index.js";

describe("binary frame demux", () => {
  it("routes fetch frames and retains remote browser routing", () => {
    const fetch = { opcode: NetworkFetchOpcode.Cancel, subscriptionId: "owner", fetchId: 1 };
    expect(decodeBinaryFrame(encodeNetworkFetchFrame(fetch))).toEqual({
      kind: "network_fetch",
      frame: fetch,
    });
    const ack = {
      opcode: RemoteBrowserOpcode.FrameAck,
      subscriptionId: "owner",
      generation: 1,
      seq: 1,
    };
    expect(decodeBinaryFrame(encodeRemoteBrowserFrame(ack))).toEqual({
      kind: "remote_browser",
      frame: ack,
    });
  });
  it("keeps fetch opcode allocation disjoint from other binary protocols", () => {
    const existing = new Set<number>([
      ...Object.values(TerminalStreamOpcode),
      ...Object.values(FileTransferOpcode),
      ...Object.values(TunnelOpcode),
      ...Object.values(RemoteBrowserOpcode),
    ]);
    expect(Object.values(NetworkFetchOpcode).some((opcode) => existing.has(opcode))).toBe(false);
  });
  it("routes terminal frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 7,
          payload: "ls",
        }),
      ),
    ).toEqual({
      kind: "terminal",
      frame: {
        opcode: TerminalStreamOpcode.Input,
        slot: 7,
        payload: new TextEncoder().encode("ls"),
      },
    });
  });

  it("routes file-transfer frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: "req-upload",
          payload: new TextEncoder().encode("hello"),
        }),
      ),
    ).toEqual({
      kind: "file_transfer",
      frame: {
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello"),
      },
    });
  });

  it.each<TunnelFrame>([
    {
      opcode: TunnelOpcode.Open,
      subscriptionId: "s",
      streamId: "t",
      target: { atyp: 3, address: "localhost", port: 80 },
    },
    { opcode: TunnelOpcode.Connected, subscriptionId: "s", streamId: "t" },
    { opcode: TunnelOpcode.Data, subscriptionId: "s", streamId: "t", payload: new Uint8Array([1]) },
    { opcode: TunnelOpcode.Close, subscriptionId: "s", streamId: "t", reason: 0 },
    { opcode: TunnelOpcode.WindowUpdate, subscriptionId: "s", streamId: "t", credit: 1 },
  ])("routes tunnel opcode $opcode", (frame) => {
    expect(decodeBinaryFrame(encodeTunnelFrame(frame))).toEqual({ kind: "tunnel", frame });
  });

  it.each([0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x2f])(
    "rejects malformed or reserved tunnel opcode %i",
    (opcode) => {
      expect(decodeBinaryFrame(new Uint8Array([opcode, 0]))).toBeNull();
    },
  );

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});
