import type { RemoteBrowserFrame } from "@getpaseo/client";

export interface FramePipeline {
  /** A frame arrived for this attachment. Painted in arrival order; nothing is skipped. */
  receive(frame: RemoteBrowserFrame): void;
  /** The presenter finished painting `frame`. Acks it and presents the next one. */
  painted(frame: RemoteBrowserFrame): void;
  /**
   * Pause presentation (hidden pane). Queued frames wait; a frame whose paint was already under
   * way is still acked when that paint completes, so its credit returns to the daemon.
   */
  setPaused(paused: boolean): void;
  /** Forget every queued frame without acking it: the attachment they belong to is gone. */
  dispose(): void;
  queuedCount(): number;
}

/**
 * Flow control for one attachment, matching contract §6: the daemon keeps at most
 * `maxFramesInFlight` frames unacknowledged and coalesces on its side, so every frame that reaches
 * the client is painted and acknowledged exactly once, after the paint. Dropping a received frame
 * here would strand its credit on the daemon until the ack timeout.
 */
export function createFramePipeline(input: {
  generation: number;
  present: (frame: RemoteBrowserFrame) => void;
  ack: (frame: RemoteBrowserFrame) => void;
}): FramePipeline {
  const queue: RemoteBrowserFrame[] = [];
  let presenting: RemoteBrowserFrame | null = null;
  let paused = false;
  let disposed = false;

  function presentNext(): void {
    if (disposed || paused || presenting) {
      return;
    }
    const next = queue.shift();
    if (!next) {
      return;
    }
    presenting = next;
    input.present(next);
  }

  return {
    receive(frame) {
      if (disposed || frame.generation !== input.generation) {
        return;
      }
      queue.push(frame);
      presentNext();
    },
    painted(frame) {
      if (disposed || presenting !== frame) {
        return;
      }
      presenting = null;
      input.ack(frame);
      presentNext();
    },
    setPaused(next) {
      if (disposed || paused === next) {
        return;
      }
      paused = next;
      presentNext();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      presenting = null;
    },
    queuedCount() {
      return queue.length + (presenting ? 1 : 0);
    },
  };
}
