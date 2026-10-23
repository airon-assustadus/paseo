import { createHash } from "node:crypto";

const script = String.raw`(() => {
  const input = document.querySelector("#synthetic-input");
  const output = document.querySelector("#synthetic-output");
  const button = document.querySelector("#synthetic-click");
  const state = document.querySelector("#synthetic-state");
  let capture = null;
  let clicks = 0;
  function record(action, start, end) {
    if (!capture) return;
    capture.attempted += 1;
    if (capture.finished) {
      capture.late += 1;
      capture.result.status = "INC";
      capture.result.attempted = capture.attempted;
      capture.result.late = capture.late;
      return;
    }
    if (end > capture.deadline) capture.deadlineExceeded = true;
    if (capture.samples.length >= capture.capacity || capture.deadlineExceeded) {
      capture.dropped += 1;
      return;
    }
    capture.samples.push({
      metric: "event_handler_ms", boundary: "javascript-handler", unit: "ms",
      action, clockId: capture.clockId, startMs: start, endMs: end, value: end - start,
      sequence: capture.samples.length + 1
    });
  }
  input.addEventListener("input", () => {
    const start = performance.now();
    output.textContent = "Synthetic length: " + input.value.length;
    record("typing", start, performance.now());
  });
  button.addEventListener("click", () => {
    const start = performance.now();
    clicks += 1;
    state.textContent = "Synthetic local state: " + clicks;
    record("click", start, performance.now());
  });
  document.querySelector("#synthetic-form").addEventListener("submit", event => event.preventDefault());
  document.documentElement.dataset.ready = "true";
  const readyMs = performance.now();
  window.p05SyntheticFixture = Object.freeze({
    begin(clockId, capacity, durationMs) {
      if (capture || !/^[a-z][a-z0-9_-]{0,47}$/.test(clockId) ||
          !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000 ||
          !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 2147483647) {
        throw new Error("Invalid synthetic capture");
      }
      capture = { clockId, capacity, deadline: performance.now() + durationMs, deadlineExceeded: false,
        attempted: 0, dropped: 0, late: 0, finished: false, samples: [], result: null };
    },
    finish() {
      if (!capture) throw new Error("Synthetic capture not started");
      if (capture.finished) return capture.result;
      capture.deadlineExceeded = capture.deadlineExceeded || performance.now() > capture.deadline;
      capture.finished = true;
      capture.result = {
        metric: "data_ready_ms", boundary: "navigation-to-dom-marker", unit: "ms",
        clockId: capture.clockId, readyMs, origin: "synthetic", productVerdict: "not_evaluated",
        status: capture.dropped || capture.late || capture.deadlineExceeded ? "INC" : "complete",
        attempted: capture.attempted, accepted: capture.samples.length,
        dropped: capture.dropped, late: capture.late, deadlineExceeded: capture.deadlineExceeded,
        samples: capture.samples.map(sample => ({ ...sample }))
      };
      return capture.result;
    }
  });
})();`;

export function createSyntheticFixture() {
  const paragraphs = Array.from(
    { length: 180 },
    (_, index) =>
      `<p>Row ${index + 1}: synthetic selectable text for local scrolling and visual comparison.</p>`,
  ).join("\n");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic performance fixture</title>
<style>body{font-family:monospace;margin:16px}textarea{width:90%;height:96px}p{min-height:24px}button{min-height:44px}</style></head>
<body><h1>Synthetic performance fixture</h1><form id="synthetic-form"><textarea id="synthetic-input" aria-label="Synthetic input" maxlength="128"></textarea><button id="synthetic-click" type="button">Local update</button></form>
<p id="synthetic-output">Synthetic length: 0</p><p id="synthetic-state">Synthetic local state: 0</p><main>${paragraphs}</main><script>${script}</script></body></html>`;
  const targetBytes = 48_000;
  const padding = targetBytes - Buffer.byteLength(body, "utf8") - 7;
  if (padding < 0) throw new Error("Synthetic fixture exceeds finite size");
  const html = `${body}<!--${".".repeat(padding)}-->`;
  return {
    html,
    script,
    byteLength: Buffer.byteLength(html, "utf8"),
    sha256: createHash("sha256").update(html).digest("hex"),
    scriptSha256: createHash("sha256").update(script).digest("hex"),
  };
}
