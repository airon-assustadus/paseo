import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WebProxyProductClient,
  WebProxyProductControllerOptions,
} from "@/web-proxy/product-controller.web";
import type { WebProxyProductController, WebProxyProductSnapshot } from "@/web-proxy/product-types";
import {
  createResidentRegistry,
  type ResidentBinding,
  type ResidentRegistry,
} from "./registry.web";
import { measureSurface } from "./geometry.web";

const factory = vi.hoisted(() => vi.fn());
vi.mock("@/web-proxy/product-controller.web", () => ({ createWebProxyProductController: factory }));

const configuration = {
  dedicatedContentDomain: "content.example.test",
  assetVersion: "lifetime",
  bootstrapPath: "/bootstrap.html",
  pathPrefix: "/",
  ttlMs: 1000,
  handshakeTimeoutMs: 500,
};
async function unused(): Promise<never> {
  throw new Error("network operation outside this test");
}
const client: WebProxyProductClient = {
  isNetworkFetchSupported: () => true,
  getConnectionState: () => ({ status: "connected" }),
  getLastServerInfoMessage: () => null,
  subscribeRawMessages: () => () => {},
  subscribeConnectionStatus: () => () => {},
  resolveNetworkFetchDestination: unused,
  reconcileNetworkFetchDestination: unused,
  requestNetworkFetchCleanup: unused,
  openNetworkFetch: unused,
};

function makeController(options: WebProxyProductControllerOptions) {
  const frame = document.createElement("iframe");
  frame.title = "resident test";
  options.container.append(frame);
  const listeners = new Set<() => void>();
  let snapshot: WebProxyProductSnapshot = {
    phase: "active",
    url: "https://example.test/",
    title: "test",
    canNavigate: true,
    canReload: true,
    canGoBack: false,
    canGoForward: false,
    canResume: false,
    canRequestClear: false,
    error: null,
    cleanup: { status: "unknown", requiredEpoch: null },
  };
  const closeView = vi.fn(() => {
    frame.remove();
    snapshot = { ...snapshot, phase: "closed", canNavigate: false };
    for (const listener of listeners) listener();
  });
  const controller: WebProxyProductController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    open: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    stop: closeView,
    resume: vi.fn(async () => {}),
    requestClear: vi.fn(async () => {}),
    closeView,
  };
  return { frame, controller, closeView };
}

let root: HTMLDivElement;
let registry: ResidentRegistry;
let valid: boolean;
let blocked: boolean;
let control: ReturnType<typeof makeController>;
const binding: ResidentBinding = {
  view: { serverId: "host", workspaceId: "workspace", browserId: "browser" },
  client,
  configuration,
};

function anchor(): HTMLDivElement {
  const node = document.createElement("div");
  Object.assign(node.style, {
    position: "fixed",
    left: "10px",
    top: "10px",
    width: "200px",
    height: "120px",
  });
  document.body.append(node);
  return node;
}
function presentation(node: HTMLElement) {
  return { anchor: node, presented: true, interactive: true, returnFocus: null };
}

function residentWindow(): HTMLElement {
  const node = root.firstElementChild;
  if (!(node instanceof HTMLElement)) throw new Error("Resident window missing");
  return node;
}

beforeEach(() => {
  factory.mockReset();
  factory.mockImplementation((options: WebProxyProductControllerOptions) => {
    control = makeController(options);
    return control.controller;
  });
  valid = true;
  blocked = false;
  root = document.createElement("div");
  document.body.append(root);
  registry = createResidentRegistry({
    root,
    isBindingValid: () => valid,
    isPresentationBlocked: () => blocked,
    onSnapshot: () => {},
  });
});
afterEach(() => {
  registry.dispose();
  document.body.replaceChildren();
});

describe("resident DOM lifetime (controller substituted, no proxy E2E)", () => {
  it("clips a scrolling slot without changing its viewport or document", async () => {
    const clip = document.createElement("div");
    Object.assign(clip.style, {
      position: "fixed",
      left: "10px",
      top: "10px",
      width: "150px",
      height: "80px",
      overflow: "scroll",
      border: "2px solid black",
    });
    document.body.append(clip);
    const slot = anchor();
    Object.assign(slot.style, { position: "relative", left: "0px", top: "0px" });
    clip.append(slot);
    const surface = registry.bind(binding)!;
    surface.attachPresentation(presentation(slot));
    const frame = control.frame;
    const doc = frame.contentDocument;
    const initial = measureSurface(slot)!;
    expect(initial.width).toBe(200);
    expect(initial.height).toBe(120);
    expect(initial.clipRight - initial.clipLeft).toBe(clip.clientWidth);
    expect(initial.clipBottom - initial.clipTop).toBe(clip.clientHeight);
    clip.scrollTop = 20;
    clip.dispatchEvent(new Event("scroll"));
    expect(residentWindow().inert).toBe(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const after = measureSurface(slot)!;
    expect(after.top).toBe(initial.top - 20);
    expect(after.width).toBe(initial.width);
    expect(frame.parentElement?.style.width).toBe("200px");
    expect(frame.parentElement?.style.height).toBe("120px");
    expect(frame.contentDocument).toBe(doc);
    expect(control.controller.open).not.toHaveBeenCalled();
  });

  it("fences a zero, disconnected or hidden slot and never steals focus on return", () => {
    const slot = anchor();
    const surface = registry.bind(binding)!;
    const lease = surface.attachPresentation(presentation(slot));
    const outside = document.createElement("button");
    document.body.append(outside);
    control.frame.focus();
    expect(document.activeElement).toBe(control.frame);
    slot.style.width = "0px";
    lease.update(presentation(slot));
    expect(residentWindow().inert).toBe(true);
    expect(document.activeElement).not.toBe(control.frame);
    slot.style.width = "200px";
    slot.remove();
    lease.update(presentation(slot));
    expect(residentWindow().inert).toBe(true);
    document.body.append(slot);
    slot.style.visibility = "hidden";
    lease.update(presentation(slot));
    expect(residentWindow().inert).toBe(true);
    slot.style.visibility = "visible";
    outside.focus();
    lease.update(presentation(slot));
    expect(residentWindow().inert).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(control.frame.isConnected).toBe(true);
    expect(control.controller.resume).not.toHaveBeenCalled();
  });

  it("closes every logical owner even when the first controller teardown throws", () => {
    const reports: VoidFunction[] = [];
    const schedule = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      reports.push(callback);
    });
    try {
      registry.bind(binding);
      const first = control;
      const failure = new Error("controller close failed");
      first.closeView.mockImplementation(() => {
        throw failure;
      });
      registry.bind({ ...binding, view: { ...binding.view, browserId: "second" } });
      const second = control;
      registry.closeWhere(() => true);
      expect(first.closeView).toHaveBeenCalledOnce();
      expect(second.closeView).toHaveBeenCalledOnce();
      expect(first.frame.isConnected).toBe(false);
      expect(second.frame.isConnected).toBe(false);
      expect(root.childElementCount).toBe(0);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toThrow(failure);
    } finally {
      schedule.mockRestore();
    }
  });

  it("keeps the same connected iframe and Document across presentation teardown and return", () => {
    const surface = registry.bind(binding)!;
    const oldAnchor = anchor();
    const first = surface.attachPresentation(presentation(oldAnchor));
    const frame = control.frame;
    const doc = frame.contentDocument!;
    const state = doc.createElement("input");
    state.value = "state not persisted";
    doc.body.append(state);
    first.release();
    oldAnchor.remove();
    expect(frame.isConnected).toBe(true);
    const next = registry.bind(binding)!;
    expect(next).toBe(surface);
    next.attachPresentation(presentation(anchor()));
    expect(frame.contentDocument).toBe(doc);
    expect(state.value).toBe("state not persisted");
    expect(factory).toHaveBeenCalledOnce();
    expect(control.controller.open).not.toHaveBeenCalled();
    expect(control.controller.resume).not.toHaveBeenCalled();
    expect(control.closeView).not.toHaveBeenCalled();
  });

  it("fences ambiguous presentations and ignores a released lease after a new attachment", () => {
    const surface = registry.bind(binding)!;
    const first = surface.attachPresentation(presentation(anchor()));
    const second = surface.attachPresentation(presentation(anchor()));
    const window = residentWindow();
    expect(window.inert).toBe(true);
    first.release();
    expect(window.inert).toBe(false);
    first.update({ ...presentation(anchor()), presented: false });
    first.release();
    expect(window.inert).toBe(false);
    second.release();
    expect(window.inert).toBe(true);
    expect(control.frame.isConnected).toBe(true);
  });

  it("hides synchronously for an overlay and preserves C's iframe inert flag", async () => {
    const surface = registry.bind(binding)!;
    surface.attachPresentation(presentation(anchor()));
    const window = residentWindow();
    control.frame.inert = true;
    blocked = true;
    registry.invalidatePresentation();
    expect(window.inert).toBe(true);
    blocked = false;
    registry.invalidatePresentation();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(window.inert).toBe(false);
    expect(control.frame.inert).toBe(true);
  });

  it("invalidates old leases on logical close/config loss and closes once", () => {
    const surface = registry.bind(binding)!;
    const lease = surface.attachPresentation(presentation(anchor()));
    valid = false;
    registry.reconcile();
    registry.closeWhere(() => true);
    lease.update(presentation(anchor()));
    lease.release();
    expect(control.closeView).toHaveBeenCalledOnce();
    expect(control.frame.isConnected).toBe(false);
    expect(registry.bind(binding)).toBeNull();
  });

  it("does not reopen a stopped controller on reattachment", () => {
    const surface = registry.bind(binding)!;
    const lease = surface.attachPresentation(presentation(anchor()));
    surface.controller.stop();
    lease.release();
    registry.bind(binding)!.attachPresentation(presentation(anchor()));
    expect(factory).toHaveBeenCalledOnce();
    expect(surface.controller.getSnapshot().phase).toBe("closed");
    expect(surface.controller.open).not.toHaveBeenCalled();
    expect(surface.controller.resume).not.toHaveBeenCalled();
  });
});
