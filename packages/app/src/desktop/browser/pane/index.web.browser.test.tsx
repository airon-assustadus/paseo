import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor, within } from "@testing-library/dom";
import { userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkFetchConfiguration } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import type { WebProxyProductController, WebProxyProductSnapshot } from "@/web-proxy/product-types";
import { i18n } from "@/i18n/i18next";
import { useBrowserStore } from "../store";
import { webProxySettings } from "../web-proxy-settings";
import { BrowserPane } from "./index.web";
import { createResidentRegistry, type ResidentRegistry } from "../resident-dom-proxy/registry.web";

// These tests exercise the real panel and controls. The controller seam is substituted;
// they do not prove host transport, navigation, storage removal, or an end-to-end proxy.
const runtime = vi.hoisted(() => ({
  supported: true,
  client: { subscribeRawMessages: () => () => {} },
  configuration: null as NetworkFetchConfiguration | null,
  create: vi.fn(),
}));
const resident = vi.hoisted(() => ({ registry: null as ResidentRegistry | null }));
vi.mock("../resident-dom-proxy/provider.web", () => ({
  useResidentDomProxy: () => resident.registry,
}));

vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => runtime.supported }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => runtime.client }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: {
      sessions: Record<
        string,
        { serverInfo: { networkFetchConfiguration?: NetworkFetchConfiguration } }
      >;
    }) => unknown,
  ) =>
    selector({
      sessions: {
        "host-a": { serverInfo: { networkFetchConfiguration: runtime.configuration ?? undefined } },
        "host-b": { serverInfo: { networkFetchConfiguration: runtime.configuration ?? undefined } },
      },
    }),
}));
vi.mock("@/web-proxy/product-controller.web", () => ({
  createWebProxyProductController: runtime.create,
}));
vi.mock("@/remote-browser/pane", () => ({
  RemoteBrowserPane: () => <div data-testid="image-pane" />,
}));

const configuration: NetworkFetchConfiguration = {
  dedicatedContentDomain: "content.example.test",
  assetVersion: "test-version",
  bootstrapPath: "/bootstrap.html",
  pathPrefix: "/proxy/",
  ttlMs: 1000,
  handshakeTimeoutMs: 500,
};

function fakeController() {
  let snapshot: WebProxyProductSnapshot = {
    phase: "unavailable",
    url: null,
    title: null,
    canNavigate: false,
    canReload: false,
    canGoBack: false,
    canGoForward: false,
    canResume: false,
    canRequestClear: false,
    error: null,
    cleanup: { status: "unknown", requiredEpoch: null },
  };
  const listeners = new Set<() => void>();
  const controller = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    open: vi.fn(async (_url: string) => {}),
    navigate: vi.fn(async (_url: string) => {}),
    reload: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    stop: vi.fn(),
    resume: vi.fn(async () => {}),
    closeView: vi.fn(),
    requestClear: vi.fn(async () => {}),
  } satisfies WebProxyProductController;
  return {
    controller,
    emit(patch: Partial<WebProxyProductSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement;
let browserId: string;
let controls: ReturnType<typeof fakeController>[];
let residentHost: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("React", React);
  runtime.supported = true;
  runtime.configuration = configuration;
  runtime.create.mockReset();
  controls = [];
  runtime.create.mockImplementation(() => {
    const control = fakeController();
    controls.push(control);
    return control.controller;
  });
  webProxySettings.setState({ ready: true, loading: false, failed: false, domByHost: {} });
  browserId = useBrowserStore
    .getState()
    .createBrowser({ initialUrl: "https://before.example.test/" });
  container = document.createElement("div");
  document.body.appendChild(container);
  residentHost = document.createElement("div");
  document.body.append(residentHost);
  resident.registry = createResidentRegistry({
    root: residentHost,
    isBindingValid: (binding) =>
      runtime.supported &&
      webProxySettings.getState().domByHost[binding.view.serverId] === true &&
      JSON.stringify(binding.configuration) === JSON.stringify(runtime.configuration),
    isPresentationBlocked: () => false,
    onSnapshot: (view, snapshot) => {
      if (snapshot.url === null) return;
      useBrowserStore.getState().updateBrowser(view.browserId, {
        url: snapshot.url,
        ...(snapshot.title === null ? {} : { title: snapshot.title }),
      });
    },
  });
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  resident.registry?.dispose();
  resident.registry = null;
  residentHost.remove();
  container.remove();
  useBrowserStore.getState().removeBrowser(browserId);
});

function renderPane(serverId = "host-a", isInteractive = true) {
  act(() => resident.registry?.reconcile());
  act(() =>
    root?.render(
      <BrowserPane
        browserId={browserId}
        serverId={serverId}
        workspaceId="workspace-a"
        cwd={null}
        isInteractive={isInteractive}
      />,
    ),
  );
  return within(container);
}

function optIn(host = "host-a") {
  act(() => webProxySettings.setState({ domByHost: { [host]: true } }));
}

describe("workspace web proxy panel contract", () => {
  it("requires per-host opt-in and changes to image mode only on an explicit choice", async () => {
    const view = renderPane();
    expect(view.getByTestId("image-pane")).toBeTruthy();
    expect(runtime.create).not.toHaveBeenCalled();
    await userEvent.click(view.getByRole("button", { name: i18n.t("webProxy.useDom") }));
    await waitFor(() => expect(controls).toHaveLength(1));
    expect(webProxySettings.getState().domByHost["host-a"]).toBe(true);
    expect(webProxySettings.getState().domByHost["host-b"]).toBeUndefined();
    expect(view.queryByTestId("image-pane")).toBeNull();
    runtime.supported = false;
    renderPane();
    expect(controls[0].controller.closeView).toHaveBeenCalledOnce();
    expect(view.queryByTestId("image-pane")).toBeNull();
    expect(view.getByText(i18n.t("webProxy.unavailable"))).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: i18n.t("webProxy.useImage") }));
    await waitFor(() => expect(view.getByTestId("image-pane")).toBeTruthy());
  });

  it("closes invalid bindings but preserves a view when its presentation unmounts", () => {
    optIn();
    renderPane();
    expect(controls).toHaveLength(1);
    runtime.configuration = { ...configuration, assetVersion: "next-version" };
    renderPane();
    expect(controls[0].controller.closeView).toHaveBeenCalledOnce();
    expect(controls).toHaveLength(2);
    runtime.configuration = null;
    const view = renderPane();
    expect(controls[1].controller.closeView).toHaveBeenCalledOnce();
    expect(view.queryByTestId("image-pane")).toBeNull();
    runtime.configuration = configuration;
    renderPane();
    optIn("host-b");
    renderPane("host-b");
    expect(controls[2].controller.closeView).toHaveBeenCalledOnce();
    expect(runtime.create.mock.lastCall?.[0].view.serverId).toBe("host-b");
    act(() => root?.unmount());
    root = null;
    expect(controls.at(-1)?.controller.closeView).not.toHaveBeenCalled();
    resident.registry?.dispose();
    expect(controls.at(-1)?.controller.closeView).toHaveBeenCalledOnce();
  });

  it("submits a draft without inventing confirmed metadata and separates Stop from cleanup", async () => {
    optIn();
    const view = renderPane();
    const control = controls[0];
    expect(
      view
        .getByRole("button", { name: i18n.t("workspace.browser.controls.navigate") })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
    await userEvent.fill(view.getByTestId("dom-proxy-url"), "http://localhost:4321/requested");
    await userEvent.click(
      view.getByRole("button", { name: i18n.t("workspace.browser.controls.navigate") }),
    );
    expect(control.controller.open).toHaveBeenCalledWith("http://localhost:4321/requested");
    expect(useBrowserStore.getState().browsersById[browserId]?.url).toBe(
      "https://before.example.test/",
    );
    act(() =>
      control.emit({
        phase: "active",
        canRequestClear: true,
        error: { code: "navigation_unavailable" },
      }),
    );
    expect(view.getByText(i18n.t("webProxy.navigationUnavailable"))).toBeTruthy();
    expect(
      view
        .getByRole("button", { name: i18n.t("workspace.browser.controls.refresh") })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(view.getByRole("button", { name: i18n.t("webProxy.stop") }));
    expect(control.controller.stop).toHaveBeenCalledOnce();
    expect(control.controller.requestClear).not.toHaveBeenCalled();
    await userEvent.click(view.getByRole("button", { name: i18n.t("webProxy.requestCleanup") }));
    expect(control.controller.requestClear).toHaveBeenCalledOnce();
    act(() =>
      control.emit({
        url: "http://localhost:4321/confirmed",
        title: "Confirmed title",
        error: null,
        cleanup: { status: "pending_local", requiredEpoch: "2" },
      }),
    );
    expect(useBrowserStore.getState().browsersById[browserId]?.title).toBe("Confirmed title");
    expect(view.getByText(i18n.t("webProxy.cleanupLocal"))).toBeTruthy();
    expect(control.controller.closeView).not.toHaveBeenCalled();
  });

  it("makes a hidden retained surface inert and disables commands", () => {
    optIn();
    renderPane();
    act(() => controls[0].emit({ phase: "active", canResume: true, canRequestClear: true }));
    const view = renderPane("host-a", false);
    const residentWindow = residentHost.querySelector<HTMLElement>(
      '[data-testid="dom-proxy-resident-window"]',
    );
    expect(residentWindow?.inert).toBe(true);
    expect(
      view.getByRole("button", { name: i18n.t("webProxy.stop") }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      view
        .getByRole("button", { name: i18n.t("webProxy.requestCleanup") })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(controls[0].controller.closeView).not.toHaveBeenCalled();
  });

  it("preserves an address draft when only confirmed title or cleanup state changes", async () => {
    optIn();
    const view = renderPane();
    const control = controls[0];
    act(() => control.emit({ phase: "active", url: "https://before.example.test/" }));
    const address = view.getByTestId("dom-proxy-url");
    await userEvent.fill(address, "https://next.example.test/draft");
    act(() =>
      control.emit({
        title: "New title",
        cleanup: { status: "pending_local", requiredEpoch: "3" },
      }),
    );
    expect(view.getByDisplayValue("https://next.example.test/draft")).toBeTruthy();
    expect(useBrowserStore.getState().browsersById[browserId]?.title).toBe("New title");
    expect(useBrowserStore.getState().browsersById[browserId]?.url).toBe(
      "https://before.example.test/",
    );
    expect(control.controller.navigate).not.toHaveBeenCalled();
  });
});
