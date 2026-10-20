/* eslint-disable complexity -- the fixture router is one case per test page */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemoteBrowserInputEvent } from "@getpaseo/protocol/remote-browser/rpc-schemas";
import type { EnginePageState, ManagedRemoteBrowserEngine } from "./engine.js";
import { mapInputEvent } from "./input-mapping.js";
import { RemoteBrowserManager } from "./remote-browser-manager.js";

/**
 * Real Chromium on this host against loopback fixtures on ephemeral ports. No user profile, no
 * port 6767, no external network. Skipped where no Chrome/Chromium is installed.
 */

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true };
const EVIDENCE_DIR = process.env.PASEO_RB_EVIDENCE_DIR;
const manager = new RemoteBrowserManager({
  logger: pino({ level: process.env.PASEO_RB_E2E_LOG ?? "silent" }, pino.destination(2)),
});
const canRun = process.platform === "linux" && manager.available;

interface Fixtures {
  origin: string;
  httpPort: number;
  tlsPort: number;
  turnPort: number;
  udpPackets: number;
  turnConnections: number;
  assetHits: number;
  postedBodies: string[];
  close(): Promise<void>;
}

function page(pageTitle: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle}</title><style>body{margin:0;font:20px sans-serif} .hit{display:block;width:100%;height:120px;background:#0a7;color:#fff}</style></head><body>${body}</body></html>`;
}

async function startFixtures(): Promise<Fixtures> {
  const state = { udpPackets: 0, turnConnections: 0, assetHits: 0, postedBodies: [] as string[] };
  const udp = dgram.createSocket("udp4");
  udp.on("message", () => {
    state.udpPackets += 1;
  });
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const udpPort = udp.address().port;
  const turn = net.createServer((socket) => {
    state.turnConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => turn.listen(0, "127.0.0.1", resolve));
  const turnPort = (turn.address() as net.AddressInfo).port;

  let httpPort = 0;
  let tlsPort = 0;
  let closeTls: () => Promise<void> = async () => {};
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const html = (body: string, headers: http.OutgoingHttpHeaders = {}) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
      response.end(body);
    };
    switch (url.pathname) {
      case "/":
        return html(
          page(
            "Home",
            `<a class="hit" href="/redir">next</a><input id="field" style="display:block;height:80px;width:100%;font-size:30px" oninput="document.title='typed:'+this.value"><div style="height:4000px"></div><script>addEventListener('scroll',()=>{document.title='scroll:'+Math.round(scrollY)})</script>`,
          ),
        );
      case "/redir":
        response.writeHead(302, { Location: "/next" });
        return response.end();
      case "/next":
        return html(page("Next", `<img src="/pixel.svg" onload="document.title='Next+asset'">`));
      case "/pixel.svg":
        state.assetHits += 1;
        response.writeHead(200, { "Content-Type": "image/svg+xml" });
        return response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      case "/form":
        return html(
          page(
            "Form",
            `<form method="post" action="/login"><input type="hidden" name="user" value="ana"><button class="hit" type="submit">login</button></form>`,
          ),
        );
      case "/login": {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          state.postedBodies.push(body);
          response.writeHead(303, {
            Location: "/me",
            "Set-Cookie": "sid=s3cr3t; HttpOnly; Path=/",
          });
          response.end();
        });
        return;
      }
      case "/me":
        return html(page(`me:${request.headers.cookie ?? "none"}`, ""));
      case "/metadata":
        response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        return response.end();
      case "/ws":
        return html(
          page(
            "ws:pending",
            `<script>const s=new WebSocket('ws://127.0.0.1:${httpPort}/echo');s.onopen=()=>s.send('hi');s.onmessage=(e)=>{document.title='ws:'+e.data};s.onerror=()=>{document.title='ws:error'}</script>`,
          ),
        );
      case "/wss":
        return html(
          page(
            "wss:pending",
            `<script>const s=new WebSocket('wss://localhost:${tlsPort}/echo');s.onopen=()=>{document.title='wss:open'};s.onerror=()=>{document.title='wss:error'}</script>`,
          ),
        );
      case "/download":
        return html(page("Download", `<a class="hit" href="/file.bin" download>get</a>`));
      case "/file.bin":
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": "attachment; filename=file.bin",
        });
        return response.end("payload");
      case "/popup":
        return html(page("Popup", `<a class="hit" href="/next" target="_blank">open</a>`));
      case "/dialog":
        return html(
          page(
            "Dialog",
            `<button class="hit" onclick="alert('x');document.title='after-alert'">alert</button>`,
          ),
        );
      case "/upload":
        return html(
          page(
            "Upload",
            `<input class="hit" type="file" style="display:block;height:120px;width:100%">`,
          ),
        );
      case "/focus":
        return html(
          page(
            "focus",
            `<input id="a" type="text" style="display:block;height:100px;width:100%;font-size:30px"><input id="b" type="text" style="display:block;height:100px;width:100%;font-size:30px"><script>const a=document.getElementById('a'),b=document.getElementById('b');const show=()=>{document.title='a='+a.value+'|b='+b.value};a.addEventListener('input',show);b.addEventListener('input',show);a.addEventListener('compositionstart',()=>setTimeout(()=>b.focus(),100),{once:true})</script>`,
          ),
        );
      case "/permissions":
        return html(
          page(
            "perm:pending",
            `<button class="hit" id="go">probe</button><script>
document.getElementById('go').addEventListener('click', async () => {
  const out = {};
  for (const name of ['camera','microphone','geolocation','notifications','clipboard-read','clipboard-write','midi']) {
    try { out[name] = (await navigator.permissions.query({ name })).state; } catch (e) { out[name] = 'error:' + e.name; }
  }
  const attempt = async (key, run) => { try { await run(); out[key] = 'allowed'; } catch (e) { out[key] = e.name || 'error'; } };
  await attempt('getUserMedia', () => navigator.mediaDevices.getUserMedia({ video: true, audio: true }));
  await attempt('clipboardRead', () => navigator.clipboard.readText());
  await attempt('geolocationCall', () => new Promise((ok, fail) => navigator.geolocation.getCurrentPosition(ok, (e) => fail(Object.assign(new Error(e.message), { name: 'GeolocationError' + e.code })), { timeout: 3000 })));
  out.notificationRequest = await Notification.requestPermission();
  document.title = 'perm:' + JSON.stringify(out);
});
</script>`,
          ),
        );
      case "/rtc":
        return html(
          page(
            "rtc:pending",
            `<script>(async()=>{const types=[];const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'},{urls:'turn:127.0.0.1:${turnPort}?transport=tcp',username:'u',credential:'p'},{urls:'turn:127.0.0.1:${udpPort}?transport=udp',username:'u',credential:'p'}]});pc.createDataChannel('x');pc.onicecandidate=(e)=>{if(e.candidate)types.push(e.candidate.type+'/'+e.candidate.protocol+'/'+(e.candidate.address||''));else document.title='rtc:'+(types.join(',')||'none')};await pc.setLocalDescription(await pc.createOffer());setTimeout(()=>{if(document.title==='rtc:pending')document.title='rtc:timeout:'+types.join(',')},8000)})()</script>`,
          ),
        );
      default:
        response.writeHead(404);
        return response.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  httpPort = (server.address() as net.AddressInfo).port;

  // Private 0700 dir; the key never outlives setup, even when setup fails.
  const certDir = mkdtempSync(path.join(os.tmpdir(), "paseo-rb-e2e-cert-"));
  {
    let key: Buffer;
    let cert: Buffer;
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-keyout",
          path.join(certDir, "key.pem"),
          "-out",
          path.join(certDir, "cert.pem"),
        ],
        { stdio: "ignore" },
      );
      key = readFileSync(path.join(certDir, "key.pem"));
      cert = readFileSync(path.join(certDir, "cert.pem"));
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
    const tlsServer = https.createServer({ key, cert });
    const tlsWss = new WebSocketServer({ server: tlsServer });
    tlsWss.on("connection", (ws) => ws.send("tls"));
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    tlsPort = (tlsServer.address() as net.AddressInfo).port;
    closeTls = async () => {
      tlsServer.closeAllConnections();
      await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    };
  }

  return {
    get origin() {
      return `http://127.0.0.1:${httpPort}`;
    },
    httpPort,
    get tlsPort() {
      return tlsPort;
    },
    turnPort,
    get udpPackets() {
      return state.udpPackets;
    },
    get turnConnections() {
      return state.turnConnections;
    },
    get assetHits() {
      return state.assetHits;
    },
    get postedBodies() {
      return state.postedBodies;
    },
    async close() {
      udp.close();
      turn.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeTls();
    },
  };
}

function waitForState(
  engine: ManagedRemoteBrowserEngine,
  predicate: (state: EnginePageState) => boolean,
  timeoutMs = 15_000,
): Promise<EnginePageState> {
  if (predicate(engine.state)) return Promise.resolve(engine.state);
  return new Promise((resolve, reject) => {
    // The session probes title and focus while visible; do the same here.
    const poll = setInterval(() => {
      void engine.refreshFocus(new AbortController().signal).catch(() => undefined);
    }, 150);
    const finish = () => {
      clearInterval(poll);
      clearTimeout(timer);
      unsubscribe();
    };
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `Timed out waiting for state; last: ${JSON.stringify(engine.state).slice(0, 400)}`,
        ),
      );
    }, timeoutMs);
    const unsubscribe = engine.onStateChange(() => {
      if (!predicate(engine.state)) return;
      finish();
      resolve(engine.state);
    });
  });
}

async function input(
  engine: ManagedRemoteBrowserEngine,
  events: RemoteBrowserInputEvent[],
): Promise<void> {
  const signal = new AbortController().signal;
  for (const event of events) {
    for (const command of mapInputEvent(event, VIEWPORT)) await engine.dispatch(command, signal);
  }
}

async function tap(engine: ManagedRemoteBrowserEngine, x: number, y: number): Promise<void> {
  await input(engine, [
    { kind: "touch", phase: "start", points: [{ id: 0, x, y }] },
    { kind: "touch", phase: "end", points: [] },
  ]);
}

async function go(engine: ManagedRemoteBrowserEngine, url: string): Promise<void> {
  await engine.navigate({ kind: "url", url }, new AbortController().signal);
}

/** Title and a finished load: input sent before layout would miss its target. */
function title(
  engine: ManagedRemoteBrowserEngine,
  expected: string | RegExp,
): Promise<EnginePageState> {
  return waitForState(
    engine,
    (state) =>
      !state.loading &&
      (typeof expected === "string" ? state.title === expected : expected.test(state.title)),
  );
}

function remoteBrowserTempDirs(): string[] {
  return readdirSync(os.tmpdir()).filter((name) => name.startsWith("paseo-remote-browser-"));
}

function processAlive(pid: number, startTime: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === startTime;
  } catch {
    return false;
  }
}

describe.skipIf(!canRun)("remote browser with real Chromium", () => {
  let fixtures: Fixtures;
  let engine: ManagedRemoteBrowserEngine;
  const evidence: Record<string, unknown> = {};
  const frameTimes: number[] = [];
  let tempDirsBefore: string[] = [];

  beforeAll(async () => {
    fixtures = await startFixtures();
    tempDirsBefore = remoteBrowserTempDirs();
    const launchStart = Date.now();
    engine = (await manager.launch({
      viewport: VIEWPORT,
      renderScale: 2,
      initialUrl: null,
    })) as ManagedRemoteBrowserEngine;
    evidence.launchMs = Date.now() - launchStart;
    engine.onFrame((frame) => {
      frameTimes.push(Date.now());
      frame.release();
    });
    await engine.startScreencast(
      { quality: 60, maxWidth: 780, maxHeight: 1688 },
      new AbortController().signal,
    );
  }, 60_000);

  afterAll(async () => {
    if (EVIDENCE_DIR) {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        path.join(EVIDENCE_DIR, "engine-e2e.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }
    await manager.close();
    await fixtures?.close();
  }, 60_000);

  it("runs sandboxed renderers in their own namespaces", async () => {
    await go(engine, `${fixtures.origin}/next`);
    await title(engine, "Next+asset");
    await engine.sampleProcesses();
    const identities = engine.processIdentities();
    const renderers = identities.filter(({ pid }) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--type=renderer");
      } catch {
        return false;
      }
    });
    expect(renderers.length).toBeGreaterThan(0);
    const ownUserNs = readlinkSync("/proc/self/ns/user");
    const ownPidNs = readlinkSync("/proc/self/ns/pid");
    const sandbox = renderers.map(({ pid }) => {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      return {
        seccomp: /^Seccomp:\s+(\d)/m.exec(status)?.[1],
        userNsDiffers: readlinkSync(`/proc/${pid}/ns/user`) !== ownUserNs,
        pidNsDiffers: readlinkSync(`/proc/${pid}/ns/pid`) !== ownPidNs,
      };
    });
    evidence.sandbox = sandbox;
    for (const entry of sandbox) {
      expect(entry.seccomp).toBe("2");
      expect(entry.pidNsDiffers).toBe(true);
    }
    const cmdlines = identities
      .map(({ pid }) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    expect(cmdlines).not.toContain("--no-sandbox");
    expect(cmdlines).not.toContain("--remote-debugging-port");
  });

  it("navigates over the host loopback through redirects and assets, with history", async () => {
    const started = Date.now();
    await go(engine, `${fixtures.origin}/`);
    await title(engine, "Home");
    evidence.firstLoadMs = Date.now() - started;
    await tap(engine, 100, 60);
    const next = await title(engine, "Next+asset");
    expect(next.url).toBe(`${fixtures.origin}/next`);
    expect(fixtures.assetHits).toBeGreaterThan(0);
    // History is refreshed after the navigation commits; wait for it rather than racing it.
    await waitForState(engine, (state) => state.canGoBack);
    await engine.navigate({ kind: "back" }, new AbortController().signal);
    await title(engine, "Home");
    await waitForState(engine, (state) => state.canGoForward);
  });

  it("types through focus, composition and text, and scrolls by touch", async () => {
    await go(engine, `${fixtures.origin}/`);
    await title(engine, "Home");
    await tap(engine, 100, 160);
    await engine.refreshFocus(new AbortController().signal);
    expect(engine.state.focusedEditable).toMatchObject({ inputType: "text" });
    await input(engine, [{ kind: "composition", text: "ol", selectionStart: 2, selectionEnd: 2 }]);
    await input(engine, [{ kind: "text", text: "olá" }]);
    await title(engine, "typed:olá");
    await input(engine, [{ kind: "key", phase: "press", key: "Backspace", modifiers: 0 }]);
    await title(engine, "typed:ol");
    const frameCountBefore = frameTimes.length;
    const scrollStart = Date.now();
    await input(engine, [
      { kind: "touch", phase: "start", points: [{ id: 0, x: 200, y: 700 }] },
      { kind: "touch", phase: "move", points: [{ id: 0, x: 200, y: 600 }] },
      { kind: "touch", phase: "move", points: [{ id: 0, x: 200, y: 450 }] },
      { kind: "touch", phase: "move", points: [{ id: 0, x: 200, y: 300 }] },
      { kind: "touch", phase: "end", points: [] },
    ]);
    await title(engine, /^scroll:[1-9]/);
    evidence.scrollToStateMs = Date.now() - scrollStart;
    await waitForState(engine, () => frameTimes.length > frameCountBefore, 5000).catch(
      () => undefined,
    );
    const firstFrameAfter = frameTimes.find((time) => time >= scrollStart);
    evidence.inputToFrameMs = firstFrameAfter ? firstFrameAfter - scrollStart : null;
  });

  it("gives a new focusId when a script moves focus to a same-type field during composition", async () => {
    await go(engine, `${fixtures.origin}/focus`);
    await title(engine, "focus");
    const signal = new AbortController().signal;
    await tap(engine, 100, 50);
    const first = await engine.refreshFocus(signal);
    expect(first).not.toBeNull();
    await input(engine, [{ kind: "composition", text: "ab", selectionStart: 2, selectionEnd: 2 }]);
    expect(await engine.refreshFocus(signal)).toBe(first);
    evidence.composingAfterFirstComposition = engine.state.focusedEditable?.composing ?? null;
    // The page focuses the second field 100 ms after composition started.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await engine.refreshFocus(signal);
    evidence.focusMove = { first, second, hint: engine.state.focusedEditable };
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(engine.state.focusedEditable).toMatchObject({ inputType: "text", composing: false });
    // The client resets its shadow on the new focusId and composes only new text.
    await input(engine, [
      { kind: "composition", text: "cd", selectionStart: 2, selectionEnd: 2 },
      { kind: "text", text: "cd" },
    ]);
    const final = await title(engine, /\|b=cd$/);
    expect(final.title).not.toMatch(/^a=[^|]*cd/);
    evidence.focusMoveTitle = final.title;
  });

  it("keeps form posts and cookies inside the session", async () => {
    await go(engine, `${fixtures.origin}/form`);
    await title(engine, "Form");
    await tap(engine, 100, 60);
    await title(engine, "me:sid=s3cr3t");
    expect(fixtures.postedBodies).toContain("user=ana");
  });

  it("denies a redirect to cloud metadata and names the reason", async () => {
    await go(engine, `${fixtures.origin}/metadata`);
    const state = await waitForState(engine, (current) => current.error !== null);
    evidence.metadataRedirect = state.error;
    expect(state.error?.code).toBe("policy_denied");
  });

  it("relays ws:// through a policy-approved dial and records how Chromium addressed the proxy", async () => {
    await go(engine, `${fixtures.origin}/ws`);
    await title(engine, "ws:echo:hi");
    const metrics = engine.metrics();
    const dials = metrics.proxyRecentDials.filter(
      (dial) => dial.port === fixtures.httpPort && dial.kind !== "http",
    );
    evidence.wsProxyShapes = metrics.proxyRequestShapes;
    evidence.wsDials = dials;
    // Either CONNECT or an absolute-form Upgrade; both pass the same policy.
    expect(dials.some((dial) => dial.outcome === "approved")).toBe(true);
  });

  it("sends wss:// through CONNECT and does not accept a self-signed certificate", async () => {
    // Evidence of no TLS bypass only; a successful wss:// needs a certificate the browser trusts.
    await go(engine, `${fixtures.origin}/wss`);
    const wss = await title(engine, /^wss:(open|error)$/);
    expect(wss.title).toBe("wss:error");
    const dials = engine
      .metrics()
      .proxyRecentDials.filter((dial) => dial.port === fixtures.tlsPort);
    evidence.wssDials = dials;
    expect(dials).toContainEqual({
      kind: "connect",
      host: "localhost",
      port: fixtures.tlsPort,
      outcome: "approved",
    });
  });

  it("denies camera, microphone, geolocation, notifications, clipboard and MIDI to pages", async () => {
    await go(engine, `${fixtures.origin}/permissions`);
    await title(engine, "perm:pending");
    await tap(engine, 100, 60);
    const state = await title(engine, /^perm:\{/);
    const result = JSON.parse(state.title.slice("perm:".length)) as Record<string, string>;
    evidence.permissions = result;
    for (const name of [
      "camera",
      "microphone",
      "geolocation",
      "notifications",
      "clipboard-read",
      "clipboard-write",
      "midi",
    ]) {
      expect(result[name], name).toBe("denied");
    }
    expect(result.getUserMedia).toBe("NotAllowedError");
    expect(result.clipboardRead).toBe("NotAllowedError");
    expect(result.geolocationCall).toBe("GeolocationError1");
    expect(result.notificationRequest).toBe("denied");
  });

  it("gathers no WebRTC path outside the proxy", async () => {
    // mDNS probe scope: IPv4 multicast 224.0.0.251:5353 on this host. IPv6 (ff02::fb) is
    // recorded as not validated; an unavailable listener is never reported as "no traffic".
    const mdnsNames: string[] = [];
    const controlMarker = randomUUID();
    let controlReceived = false;
    let mdnsProbe = "listening";
    const mdns = dgram.createSocket({ type: "udp4", reuseAddr: true });
    await new Promise<void>((resolve) => {
      mdns.once("error", (error: NodeJS.ErrnoException) => {
        mdnsProbe = `unavailable: ${error.code ?? error.message}`;
        resolve();
      });
      mdns.bind(5353, () => {
        try {
          mdns.addMembership("224.0.0.251");
          mdns.setMulticastLoopback(true);
        } catch (error) {
          mdnsProbe = `unavailable: ${String(error)}`;
        }
        resolve();
      });
    });
    // Chromium's obfuscated host candidates are random UUID .local names.
    mdns.on("message", (packet) => {
      const text = packet.toString("latin1");
      if (text.includes(controlMarker)) {
        controlReceived = true;
        return;
      }
      const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(text);
      if (match) mdnsNames.push(match[0]);
    });
    // Positive control: the listener must see a multicast packet before its silence counts.
    const sender = dgram.createSocket({ type: "udp4", reuseAddr: true });
    await new Promise<void>((resolve) => sender.bind(0, "0.0.0.0", resolve));
    sender.setMulticastLoopback(true);
    sender.send(Buffer.from(`control ${controlMarker}.local`), 5353, "224.0.0.251");
    await new Promise((resolve) => setTimeout(resolve, 500));
    sender.close();
    expect(mdnsProbe).toBe("listening");
    expect(controlReceived).toBe(true);
    try {
      await go(engine, `${fixtures.origin}/rtc`);
      const state = await title(engine, /^rtc:(?!pending)/);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const turnDials = engine
        .metrics()
        .proxyRecentDials.filter((dial) => dial.port === fixtures.turnPort);
      evidence.webrtc = {
        candidates: state.title,
        udpPacketsAtStunTurnFixture: fixtures.udpPackets,
        turnTcpConnectionsAtFixture: fixtures.turnConnections,
        turnTcpDialsThroughProxy: turnDials,
        mdnsProbe: { ipv4: mdnsProbe, ipv4ControlReceived: controlReceived, ipv6: "not validated" },
        mdnsUuidNames: mdnsNames,
      };
      expect(fixtures.udpPackets).toBe(0);
      expect(state.title).not.toMatch(/host\/udp|srflx\/udp|\.local/);
      // Every TCP connection the TURN fixture saw came from an approved proxy dial.
      const approvedTurnDials = turnDials.filter(
        (dial) => dial.kind === "connect" && dial.outcome === "approved",
      );
      expect(fixtures.turnConnections).toBeLessThanOrEqual(approvedTurnDials.length);
      expect(mdnsNames).toEqual([]);
    } finally {
      mdns.close();
    }
  });

  it("blocks downloads, file choosers and dialogs, and opens popups in place", async () => {
    await go(engine, `${fixtures.origin}/download`);
    await title(engine, "Download");
    await tap(engine, 100, 60);
    await waitForState(engine, (state) => state.notice?.kind === "download_blocked");
    await go(engine, `${fixtures.origin}/upload`);
    await title(engine, "Upload");
    await tap(engine, 100, 60);
    await waitForState(engine, (state) => state.notice?.kind === "file_chooser_blocked");
    await go(engine, `${fixtures.origin}/dialog`);
    await title(engine, "Dialog");
    await tap(engine, 100, 60);
    await waitForState(engine, (state) => state.notice?.kind === "dialog_dismissed");
    await title(engine, "after-alert");
    await go(engine, `${fixtures.origin}/popup`);
    await title(engine, "Popup");
    await tap(engine, 100, 60);
    await waitForState(engine, (state) => state.notice?.kind === "popup_opened_in_place");
    await title(engine, "Next+asset");
    const downloads = path.join(os.homedir(), "Downloads", "file.bin");
    expect(existsSync(downloads)).toBe(false);
  });

  it("measures the browser and then leaves no process, profile or proxy behind", async () => {
    // Measure, close, record; assertions come last so a failure never skips the close proof.
    const usage = await engine.sampleProcesses();
    const metrics = engine.metrics();
    const windowMs = frameTimes.length > 1 ? frameTimes[frameTimes.length - 1] - frameTimes[0] : 0;
    evidence.usage = {
      ...usage,
      rssMiB: Math.round(usage.rssBytes / 1024 / 1024),
      pssMiB: usage.pssBytes === null ? "unknown" : Math.round(usage.pssBytes / 1024 / 1024),
    };
    evidence.traffic = {
      proxyBytesUp: metrics.proxyBytesUp,
      proxyBytesDown: metrics.proxyBytesDown,
      proxyConnections: metrics.proxyConnections,
    };
    evidence.frames = { count: frameTimes.length, windowMs };
    const approvedTargets = [
      ...new Set(
        metrics.proxyRecentDials
          .filter((dial) => dial.outcome === "approved")
          .map((dial) => dial.host),
      ),
    ];
    evidence.approvedTargets = approvedTargets;
    evidence.browserInternalRefused = metrics.browserInternalRefused.map(
      (dial) => `${dial.kind} ${dial.host}:${dial.port} ${dial.outcome}`,
    );
    const identities = engine.processIdentities();
    evidence.rssByProcessType = identities.map(({ pid }) => {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? "browser";
        const subtype = /--utility-sub-type=([A-Za-z.]+)/.exec(cmdline)?.[1];
        const rssKb = Number(
          /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0,
        );
        return { type: subtype ? `${type}:${subtype}` : type, rssMiB: Math.round(rssKb / 1024) };
      } catch {
        return { type: "gone", rssMiB: 0 };
      }
    });
    const closeStart = Date.now();
    await manager.closeBrowser(engine);
    evidence.closeMs = Date.now() - closeStart;
    const survivors = identities.filter(({ pid, startTime }) => processAlive(pid, startTime));
    evidence.processesAtClose = identities.length;
    evidence.survivors = survivors;
    evidence.tempDirsLeft = remoteBrowserTempDirs().filter(
      (name) => !tempDirsBefore.includes(name),
    );

    expect(identities.length).toBeGreaterThan(1);
    expect(survivors).toEqual([]);
    expect(evidence.tempDirsLeft).toEqual([]);
    expect(manager.activeCount).toBe(0);
    // The page context only ever dialed the loopback fixtures; browser-internal traffic used the
    // process-wide proxy, which refuses everything.
    expect(new Set(approvedTargets)).toEqual(new Set(["127.0.0.1", "localhost"]));
    expect(metrics.browserInternalRefused.every((dial) => dial.outcome !== "approved")).toBe(true);
    expect(usage.memoryBytes).toBeLessThanOrEqual(1536 * 1024 * 1024);
  }, 30_000);
});

describe.skipIf(!canRun)("remote browser memory watchdog with real Chromium", () => {
  it("closes a browser whose process tree stays above its RSS limit, and only its processes", async () => {
    // A separate manager with a deliberately low limit; the contract's 1536 MiB is unchanged.
    const lowLimit = new RemoteBrowserManager({
      logger: pino({ level: "silent" }),
      limits: {
        perBrowserMemoryBytes: 64 * 1024 * 1024,
        sampleIntervalMs: 500,
        overLimitSamples: 2,
      },
    });
    try {
      const engine = (await lowLimit.launch({
        viewport: VIEWPORT,
        renderScale: 2,
        initialUrl: null,
      })) as ManagedRemoteBrowserEngine;
      await engine.sampleProcesses();
      const identities = engine.processIdentities();
      const started = Date.now();
      const reason = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("watchdog did not act")), 15_000);
        engine.onExit((exitReason) => {
          clearTimeout(timer);
          resolve(exitReason);
        });
      });
      await vi.waitFor(() => expect(lowLimit.activeCount).toBe(0), { timeout: 15_000 });
      const survivors = identities.filter(({ pid, startTime }) => processAlive(pid, startTime));
      if (EVIDENCE_DIR) {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(
          path.join(EVIDENCE_DIR, "watchdog-e2e.json"),
          `${JSON.stringify({ reason, actedAfterMs: Date.now() - started, processes: identities.length, survivors }, null, 2)}\n`,
        );
      }
      expect(reason).toBe("memory_limit");
      expect(survivors).toEqual([]);
    } finally {
      await lowLimit.close();
    }
  }, 60_000);
});
