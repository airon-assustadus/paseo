import { decodeTunnelFrame, TunnelOpcode, type TunnelFrame } from "./tunnel.js";
import {
  decodeNetworkFetchFrame,
  NetworkFetchOpcode,
  type NetworkFetchBinaryFrame,
} from "./network-fetch.js";
import {
  decodeRemoteBrowserFrame,
  RemoteBrowserOpcode,
  type RemoteBrowserBinaryFrame,
} from "./remote-browser.js";
import {
  decodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "./file-transfer.js";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "./terminal.js";

export type BinaryFrame =
  | { kind: "network_fetch"; frame: NetworkFetchBinaryFrame }
  | { kind: "terminal"; frame: TerminalStreamFrame }
  | { kind: "file_transfer"; frame: FileTransferFrame }
  | { kind: "tunnel"; frame: TunnelFrame }
  | { kind: "remote_browser"; frame: RemoteBrowserBinaryFrame };

const networkFetchOpcodes = new Set<number>(Object.values(NetworkFetchOpcode));
const terminalOpcodes = new Set<number>(Object.values(TerminalStreamOpcode));
const fileTransferOpcodes = new Set<number>(Object.values(FileTransferOpcode));
const tunnelOpcodes = new Set<number>(Object.values(TunnelOpcode));
const remoteBrowserOpcodes = new Set<number>(Object.values(RemoteBrowserOpcode));

export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  if (networkFetchOpcodes.has(bytes[0])) {
    const frame = decodeNetworkFetchFrame(bytes);
    return frame ? { kind: "network_fetch", frame } : null;
  }
  if (terminalOpcodes.has(bytes[0])) {
    const frame = decodeTerminalStreamFrame(bytes);
    return frame ? { kind: "terminal", frame } : null;
  }
  if (fileTransferOpcodes.has(bytes[0])) {
    const frame = decodeFileTransferFrame(bytes);
    return frame ? { kind: "file_transfer", frame } : null;
  }
  if (tunnelOpcodes.has(bytes[0])) {
    const frame = decodeTunnelFrame(bytes);
    return frame ? { kind: "tunnel", frame } : null;
  }
  if (remoteBrowserOpcodes.has(bytes[0])) {
    const frame = decodeRemoteBrowserFrame(bytes);
    return frame ? { kind: "remote_browser", frame } : null;
  }
  return null;
}
