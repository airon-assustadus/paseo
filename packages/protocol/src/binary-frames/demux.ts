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

export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  switch (bytes[0]) {
    case NetworkFetchOpcode.Request:
    case NetworkFetchOpcode.Body:
    case NetworkFetchOpcode.End:
    case NetworkFetchOpcode.Cancel:
    case NetworkFetchOpcode.Credit:
    case NetworkFetchOpcode.Head:
    case NetworkFetchOpcode.Fail:
    case NetworkFetchOpcode.Cancelled: {
      const frame = decodeNetworkFetchFrame(bytes);
      return frame ? { kind: "network_fetch", frame } : null;
    }
    case TerminalStreamOpcode.Output:
    case TerminalStreamOpcode.Input:
    case TerminalStreamOpcode.Resize:
    case TerminalStreamOpcode.Snapshot:
    case TerminalStreamOpcode.Restore: {
      const frame = decodeTerminalStreamFrame(bytes);
      return frame ? { kind: "terminal", frame } : null;
    }
    case FileTransferOpcode.FileBegin:
    case FileTransferOpcode.FileChunk:
    case FileTransferOpcode.FileEnd: {
      const frame = decodeFileTransferFrame(bytes);
      return frame ? { kind: "file_transfer", frame } : null;
    }
    case TunnelOpcode.Open:
    case TunnelOpcode.Connected:
    case TunnelOpcode.Data:
    case TunnelOpcode.Close:
    case TunnelOpcode.WindowUpdate: {
      const frame = decodeTunnelFrame(bytes);
      return frame ? { kind: "tunnel", frame } : null;
    }
    case RemoteBrowserOpcode.Frame:
    case RemoteBrowserOpcode.FrameAck: {
      const frame = decodeRemoteBrowserFrame(bytes);
      return frame ? { kind: "remote_browser", frame } : null;
    }
    default:
      return null;
  }
}
