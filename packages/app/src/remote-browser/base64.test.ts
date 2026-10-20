import { describe, expect, it } from "vitest";
import { encodeBase64 } from "./base64";

describe("encodeBase64", () => {
  it("matches the platform encoder for every remainder length", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      const bytes = new TextEncoder().encode(text);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("encodes binary bytes including high values", () => {
    const bytes = new Uint8Array(1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 37 + 11) & 0xff;
    }
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
