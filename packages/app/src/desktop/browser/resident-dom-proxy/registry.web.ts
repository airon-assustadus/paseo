import {
  createWebProxyProductController,
  type WebProxyProductClient,
  type WebProxyProductConfiguration,
} from "@/web-proxy/product-controller.web";
import { NetworkFetchConfigurationSchema } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import type {
  WebProxyProductController,
  WebProxyProductSnapshot,
  WebProxyProductViewIdentity,
} from "@/web-proxy/product-types";
import { measureSurface, placeSurface } from "./geometry.web";

export interface ResidentBinding {
  view: WebProxyProductViewIdentity;
  client: WebProxyProductClient;
  configuration: WebProxyProductConfiguration;
}

export interface SurfacePresentation {
  anchor: HTMLElement;
  presented: boolean;
  interactive: boolean;
  returnFocus: HTMLElement | null;
}

interface PresentationLease {
  update(presentation: SurfacePresentation): void;
  release(): void;
}

export interface ResidentSurface {
  readonly controller: WebProxyProductController;
  attachPresentation(presentation: SurfacePresentation): PresentationLease;
}

interface PresentationRecord {
  value: SurfacePresentation;
  observer: ResizeObserver;
}

interface SurfaceEntry {
  binding: ResidentBinding;
  key: string;
  window: HTMLDivElement;
  container: HTMLDivElement;
  controller: WebProxyProductController;
  surface: ResidentSurface;
  leases: Map<symbol, PresentationRecord>;
  disposeObservers: Array<() => void>;
  closed: boolean;
}

interface ResidentRegistryOptions {
  root: HTMLElement;
  isBindingValid(binding: ResidentBinding): boolean;
  isPresentationBlocked(): boolean;
  onSnapshot(view: WebProxyProductViewIdentity, snapshot: WebProxyProductSnapshot): void;
}

export interface ResidentRegistry {
  bind(binding: ResidentBinding): ResidentSurface | null;
  closeWhere(predicate: (view: WebProxyProductViewIdentity) => boolean): void;
  reconcile(): void;
  invalidatePresentation(): void;
  dispose(): void;
}

function bindingKey(view: WebProxyProductViewIdentity): string {
  return JSON.stringify([view.serverId, view.workspaceId, view.browserId]);
}

function sameBinding(left: ResidentBinding, right: ResidentBinding): boolean {
  return (
    left.client === right.client &&
    JSON.stringify(left.configuration) === JSON.stringify(right.configuration)
  );
}

function hide(entry: SurfaceEntry): void {
  entry.window.inert = true;
  entry.window.style.visibility = "hidden";
  entry.window.style.pointerEvents = "none";
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && entry.window.contains(focused)) focused.blur();
}

function cleanup(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

export function createResidentRegistry(options: ResidentRegistryOptions): ResidentRegistry {
  const entries = new Map<string, SurfaceEntry>();
  let disposed = false;
  let frame: number | null = null;

  function owns(entry: SurfaceEntry): boolean {
    return !disposed && !entry.closed && entries.get(entry.key) === entry;
  }

  function close(entry: SurfaceEntry): void {
    if (entry.closed) return;
    entry.closed = true;
    entries.delete(entry.key);
    hide(entry);
    for (const lease of entry.leases.values()) lease.observer.disconnect();
    entry.leases.clear();
    for (const unsubscribe of entry.disposeObservers) cleanup(unsubscribe);
    entry.disposeObservers.length = 0;
    try {
      cleanup(entry.controller.closeView);
    } finally {
      entry.window.remove();
    }
  }

  function place(entry: SurfaceEntry): void {
    if (!owns(entry)) return;
    if (!options.isBindingValid(entry.binding)) {
      close(entry);
      return;
    }
    const presented = Array.from(entry.leases.values()).filter((lease) => lease.value.presented);
    if (options.isPresentationBlocked() || presented.length !== 1) {
      hide(entry);
      return;
    }
    const presentation = presented[0].value;
    const bounds = measureSurface(presentation.anchor);
    if (!bounds) {
      hide(entry);
      return;
    }
    placeSurface({ window: entry.window, container: entry.container, bounds });
    entry.window.style.visibility = "visible";
    entry.window.style.pointerEvents = presentation.interactive ? "auto" : "none";
    entry.window.inert = !presentation.interactive;
  }

  function invalidatePresentation(): void {
    if (disposed) return;
    for (const entry of entries.values()) hide(entry);
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      for (const entry of Array.from(entries.values())) place(entry);
    });
  }

  function attach(entry: SurfaceEntry, initial: SurfacePresentation): PresentationLease {
    const token = Symbol("resident-presentation");
    const observer = new ResizeObserver(() => {
      if (owns(entry) && entry.leases.has(token)) invalidatePresentation();
    });
    const record = { value: initial, observer };
    if (owns(entry)) {
      entry.leases.set(token, record);
      observer.observe(initial.anchor);
      place(entry);
    }
    return {
      update(value) {
        if (!owns(entry) || entry.leases.get(token) !== record) return;
        if (value.anchor !== record.value.anchor) {
          observer.disconnect();
          observer.observe(value.anchor);
        }
        record.value = value;
        place(entry);
      },
      release() {
        observer.disconnect();
        if (!owns(entry) || entry.leases.get(token) !== record) return;
        entry.leases.delete(token);
        place(entry);
      },
    };
  }

  function createEntry(binding: ResidentBinding, key: string): SurfaceEntry {
    const clipWindow = document.createElement("div");
    const container = document.createElement("div");
    clipWindow.dataset.testid = "dom-proxy-resident-window";
    container.dataset.testid = "dom-proxy-resident-surface";
    container.dataset.browserId = binding.view.browserId;
    Object.assign(clipWindow.style, {
      position: "fixed",
      overflow: "hidden",
      visibility: "hidden",
      pointerEvents: "none",
    });
    Object.assign(container.style, {
      position: "absolute",
      display: "flex",
      minWidth: "0",
      minHeight: "0",
    });
    clipWindow.inert = true;
    clipWindow.append(container);
    options.root.append(clipWindow);
    const controller = createWebProxyProductController({
      ...binding,
      container,
      enabled: true,
    });
    const entry: SurfaceEntry = {
      binding,
      key,
      window: clipWindow,
      container,
      controller,
      surface: { controller, attachPresentation: (presentation) => attach(entry, presentation) },
      leases: new Map(),
      disposeObservers: [],
      closed: false,
    };
    entries.set(key, entry);
    entry.disposeObservers.push(
      controller.subscribe(() => {
        if (owns(entry)) options.onSnapshot(binding.view, controller.getSnapshot());
      }),
    );
    entry.disposeObservers.push(
      binding.client.subscribeRawMessages((message) => {
        if (message.type === "status" && owns(entry)) reconcile();
      }),
    );
    options.onSnapshot(binding.view, controller.getSnapshot());
    return entry;
  }

  function bind(binding: ResidentBinding): ResidentSurface | null {
    if (disposed || !options.root.isConnected || !options.isBindingValid(binding)) return null;
    const configuration = NetworkFetchConfigurationSchema.safeParse(binding.configuration);
    if (!configuration.success) return null;
    const key = bindingKey(binding.view);
    const existing = entries.get(key);
    if (existing && sameBinding(existing.binding, binding)) return existing.surface;
    if (existing) close(existing);
    return createEntry(
      { ...binding, view: { ...binding.view }, configuration: configuration.data },
      key,
    ).surface;
  }

  function closeWhere(predicate: (view: WebProxyProductViewIdentity) => boolean): void {
    for (const entry of Array.from(entries.values())) {
      if (predicate(entry.binding.view)) close(entry);
    }
  }

  function reconcile(): void {
    for (const entry of Array.from(entries.values())) {
      if (!options.isBindingValid(entry.binding)) close(entry);
    }
  }

  window.addEventListener("resize", invalidatePresentation);
  window.addEventListener("scroll", invalidatePresentation, true);
  window.visualViewport?.addEventListener("resize", invalidatePresentation);
  window.visualViewport?.addEventListener("scroll", invalidatePresentation);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    window.removeEventListener("resize", invalidatePresentation);
    window.removeEventListener("scroll", invalidatePresentation, true);
    window.visualViewport?.removeEventListener("resize", invalidatePresentation);
    window.visualViewport?.removeEventListener("scroll", invalidatePresentation);
    closeWhere(() => true);
  }

  return { bind, closeWhere, reconcile, invalidatePresentation, dispose };
}
