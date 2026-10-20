import { useCallback, useMemo } from "react";
import { Image } from "expo-image";
import { encodeBase64 } from "./base64";
import type { FrameViewProps } from "./frame-view-props";

/**
 * Native presenter: one JPEG per frame as a data URI. `cachePolicy="none"` keeps page frames out of
 * expo-image's disk cache (the default is `disk`); every frame is disposable and may show private
 * pages. `onDisplay` is the paint signal the pipeline acks on; a decode failure is reported instead
 * so the session restarts the stream rather than acknowledging an image nobody saw.
 */
export function FrameView({
  frame,
  placement,
  accessibilityLabel,
  onPainted,
  onPresentationFailed,
}: FrameViewProps) {
  const source = useMemo(
    () => (frame ? { uri: `data:${frame.mimeType};base64,${encodeBase64(frame.bytes)}` } : null),
    [frame],
  );
  const style = useMemo(
    () => ({
      position: "absolute" as const,
      left: placement.x,
      top: placement.y,
      width: placement.width,
      height: placement.height,
    }),
    [placement.height, placement.width, placement.x, placement.y],
  );
  const handlePainted = useCallback(() => {
    if (frame) {
      onPainted(frame);
    }
  }, [frame, onPainted]);
  const handleError = useCallback(() => {
    if (frame) {
      onPresentationFailed(frame);
    }
  }, [frame, onPresentationFailed]);

  if (!source) {
    return null;
  }
  return (
    <Image
      accessible
      accessibilityLabel={accessibilityLabel}
      source={source}
      style={style}
      contentFit="fill"
      cachePolicy="none"
      transition={0}
      onDisplay={handlePainted}
      onError={handleError}
    />
  );
}
