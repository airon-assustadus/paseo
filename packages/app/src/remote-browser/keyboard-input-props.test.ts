import { describe, expect, it } from "vitest";
import { resolveEnterKeyHint, resolveInputMode, resolveInputPrivacy } from "./keyboard-input-props";

describe("resolveInputPrivacy", () => {
  it("treats a known password field as secure", () => {
    expect(resolveInputPrivacy({ inputMode: "", inputType: "password", enterKeyHint: "" })).toBe(
      "password",
    );
  });

  it("treats a known ordinary field as plain", () => {
    expect(
      resolveInputPrivacy({ inputMode: "email", inputType: "email", enterKeyHint: "go" }),
    ).toBe("plain");
  });

  it("treats a missing focus hint (no field, or a cross-origin iframe) as unknown", () => {
    expect(resolveInputPrivacy(null)).toBe("unknown");
  });
});

describe("hidden input hints", () => {
  it("maps page inputmode values to React Native's and falls back to text", () => {
    expect(resolveInputMode("numeric")).toBe("numeric");
    expect(resolveInputMode("search")).toBe("search");
    expect(resolveInputMode("")).toBe("text");
    expect(resolveInputMode("unknown-mode")).toBe("text");
    expect(resolveInputMode(null)).toBe("text");
  });

  it("passes only known enterkeyhint values through", () => {
    expect(resolveEnterKeyHint("go")).toBe("go");
    expect(resolveEnterKeyHint("")).toBeUndefined();
    expect(resolveEnterKeyHint("launch")).toBeUndefined();
    expect(resolveEnterKeyHint(null)).toBeUndefined();
  });
});
