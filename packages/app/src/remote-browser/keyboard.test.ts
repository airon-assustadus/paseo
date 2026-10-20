import { describe, expect, it } from "vitest";
import type { RemoteBrowserInputEvent } from "@getpaseo/client";
import {
  COMMIT_THRESHOLD,
  createKeyboardModel,
  KEY_MODIFIER_CTRL,
  splitTextChunks,
  TEXT_CHUNK_LENGTH,
  type HiddenInputSnapshot,
} from "./keyboard";

function typed(text: string, caret = text.length): HiddenInputSnapshot {
  return { text, selectionStart: caret, selectionEnd: caret };
}

function composition(text: string, caret = text.length): RemoteBrowserInputEvent {
  return { kind: "composition", text, selectionStart: caret, selectionEnd: caret };
}

function key(name: string, modifiers = 0): RemoteBrowserInputEvent {
  return { kind: "key", phase: "press", key: name, modifiers };
}

describe("remote browser keyboard model", () => {
  it("forwards each hidden input change as the full composition with its caret", () => {
    const model = createKeyboardModel();
    expect(model.receiveSnapshot(typed("h")).events).toEqual([composition("h")]);
    expect(model.receiveSnapshot(typed("he")).events).toEqual([composition("he")]);
    expect(model.receiveSnapshot(typed("he")).events).toEqual([]);
    expect(model.hasUncommittedText()).toBe(true);
  });

  it("applies a mid-word autocorrect with the suffix preserved and the caret where Android left it", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("helo wrld", 4));
    expect(model.receiveSnapshot(typed("hello wrld", 5)).events).toEqual([
      composition("hello wrld", 5),
    ]);
  });

  it("rewrites CJK syllables, combining marks and emoji atomically without any Backspace", () => {
    const model = createKeyboardModel();
    const steps = ["ㅎ", "하", "한", "한e", "한é", "한é👨‍👩‍👧"];
    const events = steps.flatMap((text) => model.receiveSnapshot(typed(text)).events);
    expect(events).toEqual(steps.map((text) => composition(text)));
    expect(events.some((event) => event.kind === "key")).toBe(false);
    const last = events.at(-1);
    expect(last?.kind === "composition" && last.selectionStart).toBe("한é👨‍👩‍👧".length);
  });

  it("does not send Backspace for deletions inside the composition and cancels it when emptied", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("ab😀"));
    expect(model.receiveKey("Backspace").events).toEqual([]);
    expect(model.receiveSnapshot(typed("ab")).events).toEqual([composition("ab")]);
    model.receiveKey("Backspace");
    model.receiveKey("Backspace");
    expect(model.receiveSnapshot(typed("")).events).toEqual([composition("")]);
    expect(model.hasUncommittedText()).toBe(false);
  });

  it("sends Backspace and Delete as keys only when nothing is composing", () => {
    const model = createKeyboardModel();
    expect(model.receiveKey("Backspace").events).toEqual([key("Backspace")]);
    expect(model.receiveKey("Delete").events).toEqual([key("Delete")]);
    model.receiveSnapshot(typed("x"));
    expect(model.receiveKey("Backspace").events).toEqual([]);
    expect(model.receiveKey("Delete").events).toEqual([]);
  });

  it("commits exactly once before Enter, clears the hidden input and swallows the newline echo", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("hello"));
    const enter = model.receiveKey("Enter");
    expect(enter).toEqual({
      events: [{ kind: "text", text: "hello" }, key("Enter")],
      shouldClear: true,
    });
    expect(model.receiveSnapshot(typed("hello\n"))).toEqual({ events: [], shouldClear: true });
    expect(model.commit()).toEqual({ events: [], shouldClear: false });
    expect(model.receiveKey("Enter").events).toEqual([key("Enter")]);
  });

  it("commits a multiline paste as text with its line breaks and never presses Enter for it", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("note: "));
    const change = model.receiveSnapshot(typed("note: first\nsecond\r\nthird"));
    expect(change).toEqual({
      events: [{ kind: "text", text: "note: first\nsecond\r\nthird" }],
      shouldClear: true,
    });
    expect(change.events.some((event) => event.kind === "key")).toBe(false);
    expect(model.hasUncommittedText()).toBe(false);
  });

  it("commits a bare newline as text when no Enter key event preceded it", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("hi"));
    expect(model.receiveSnapshot(typed("hi\n"))).toEqual({
      events: [{ kind: "text", text: "hi\n" }],
      shouldClear: true,
    });
  });

  it("commits before Tab, Escape and arrows so the key acts on committed text", () => {
    for (const name of ["Tab", "Escape", "ArrowLeft", "Home", "PageDown"]) {
      const model = createKeyboardModel();
      model.receiveSnapshot(typed("abc"));
      expect(model.receiveKey(name)).toEqual({
        events: [{ kind: "text", text: "abc" }, key(name)],
        shouldClear: true,
      });
      expect(model.receiveKey(name)).toEqual({ events: [key(name)], shouldClear: false });
    }
  });

  it("commits before a shortcut and ignores plain printable key presses (the snapshot carries them)", () => {
    const model = createKeyboardModel();
    expect(model.receiveKey("a").events).toEqual([]);
    model.receiveSnapshot(typed("abc"));
    expect(model.receiveKey("a", KEY_MODIFIER_CTRL)).toEqual({
      events: [{ kind: "text", text: "abc" }, key("a", KEY_MODIFIER_CTRL)],
      shouldClear: true,
    });
  });

  it("commits a tap or blur exactly once and is inert afterwards", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("abc"));
    expect(model.commit()).toEqual({ events: [{ kind: "text", text: "abc" }], shouldClear: true });
    expect(model.commit()).toEqual({ events: [], shouldClear: false });
    expect(model.resync()).toEqual([]);
  });

  it("drops the shadow on reset without touching the page", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("abc"));
    model.reset();
    expect(model.hasUncommittedText()).toBe(false);
    expect(model.commit().events).toEqual([]);
    expect(model.receiveSnapshot(typed("d")).events).toEqual([composition("d")]);
  });

  it("re-sends the same composition on resync while composing", () => {
    const model = createKeyboardModel();
    model.receiveSnapshot(typed("abc", 1));
    expect(model.resync()).toEqual([composition("abc", 1)]);
  });

  it("commits long text in schema-sized chunks that never split a surrogate pair", () => {
    const model = createKeyboardModel();
    const pasted = `${"a".repeat(TEXT_CHUNK_LENGTH - 1)}😀${"b".repeat(600)}`;
    expect(pasted.length).toBeGreaterThan(COMMIT_THRESHOLD);
    const change = model.receiveSnapshot(typed(pasted));
    expect(change.shouldClear).toBe(true);
    const chunks = change.events.map((event) => (event.kind === "text" ? event.text : ""));
    expect(chunks.join("")).toBe(pasted);
    expect(chunks.every((chunk) => chunk.length <= TEXT_CHUNK_LENGTH)).toBe(true);
    expect(chunks[0]).toHaveLength(TEXT_CHUNK_LENGTH - 1);
    expect(chunks[1].codePointAt(0)).toBe("😀".codePointAt(0));
    expect(model.hasUncommittedText()).toBe(false);
  });

  it("keeps a growing composition under the schema ceiling by committing past the threshold", () => {
    const model = createKeyboardModel();
    const atThreshold = "x".repeat(COMMIT_THRESHOLD);
    expect(model.receiveSnapshot(typed(atThreshold)).events).toEqual([composition(atThreshold)]);
    const beyond = `${atThreshold}y`;
    expect(model.receiveSnapshot(typed(beyond))).toEqual({
      events: [{ kind: "text", text: beyond }],
      shouldClear: true,
    });
  });

  it("stamps the page's focusId on composition and text events, and stops once focus is unknown", () => {
    const model = createKeyboardModel();
    model.setFocusId(7);
    expect(model.receiveSnapshot(typed("ab")).events).toEqual([
      { kind: "composition", text: "ab", selectionStart: 2, selectionEnd: 2, focusId: 7 },
    ]);
    expect(model.receiveKey("Tab").events).toEqual([
      { kind: "text", text: "ab", focusId: 7 },
      key("Tab"),
    ]);
    model.setFocusId(null);
    expect(model.receiveSnapshot(typed("c")).events).toEqual([composition("c")]);
  });

  it("clamps a caret reported outside the text", () => {
    const model = createKeyboardModel();
    expect(
      model.receiveSnapshot({ text: "ab", selectionStart: 7, selectionEnd: -1 }).events,
    ).toEqual([{ kind: "composition", text: "ab", selectionStart: 2, selectionEnd: 0 }]);
  });
});

describe("splitTextChunks", () => {
  it("splits on fixed lengths and moves a leading high surrogate to the next chunk", () => {
    expect(splitTextChunks("abcdef", 4)).toEqual(["abcd", "ef"]);
    expect(splitTextChunks("abc😀d", 4)).toEqual(["abc", "😀d"]);
    expect(splitTextChunks("", 4)).toEqual([]);
  });

  it("always makes progress on astral text even with a degenerate chunk length", () => {
    expect(splitTextChunks("😀😀a", 1)).toEqual(["😀", "😀", "a"]);
    expect(splitTextChunks("😀😀a", 0.5)).toEqual(["😀", "😀", "a"]);
    expect(splitTextChunks("😀😀a", Number.NaN)).toEqual(["😀😀a"]);
  });
});
