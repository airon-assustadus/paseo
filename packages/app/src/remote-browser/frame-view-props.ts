import type { RemoteBrowserFrame } from "@getpaseo/client";
import type { Rect } from "./viewport";

export interface FrameViewProps {
  frame: RemoteBrowserFrame | null;
  /** Where the frame is drawn inside the pane's viewport box. */
  placement: Rect;
  accessibilityLabel: string;
  /** Called once the frame is on screen; the session acks it then. */
  onPainted: (frame: RemoteBrowserFrame) => void;
  /** The frame could not be decoded or drawn. It is not acked; the session restarts the stream. */
  onPresentationFailed: (frame: RemoteBrowserFrame) => void;
}
