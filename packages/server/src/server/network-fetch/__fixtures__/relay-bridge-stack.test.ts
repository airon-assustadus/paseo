import { describe, expect, it } from "vitest";
import { startWsTap } from "../../test-utils/ws-tap.js";
import { wsTapOptions } from "./relay-bridge-stack.js";

/**
 * Contract of the tap capture budget without starting a relay: the options both taps receive, the
 * defaults R1 and R2 rely on when no budget is given, and the tap's own refusal of an invalid cap.
 */

describe("wsTapOptions", () => {
  it("keeps the tap's defaults when no budget is given: only the target port is set", () => {
    expect(wsTapOptions(4321)).toEqual({ targetPort: 4321 });
    expect(wsTapOptions(4321, {})).toEqual({ targetPort: 4321 });
    expect(Object.keys(wsTapOptions(4321, { maxMessages: undefined }))).toEqual(["targetPort"]);
  });

  it("passes a finite budget through, per field", () => {
    expect(
      wsTapOptions(4321, { maxBytesPerDirection: 64 * 1024 * 1024, maxMessages: 20_000 }),
    ).toEqual({
      targetPort: 4321,
      maxBytesPerDirection: 67_108_864,
      maxMessages: 20_000,
    });
    expect(wsTapOptions(4321, { maxBytesPerDirection: 1024 })).toEqual({
      targetPort: 4321,
      maxBytesPerDirection: 1024,
    });
  });

  it("lets the tap refuse an invalid cap before it listens", async () => {
    await expect(startWsTap(wsTapOptions(1, { maxBytesPerDirection: 0 }))).rejects.toThrow(
      RangeError,
    );
    await expect(startWsTap(wsTapOptions(1, { maxMessages: 1.5 }))).rejects.toThrow(RangeError);
  });
});
