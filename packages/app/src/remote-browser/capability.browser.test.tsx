import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanOpenBrowserTab } from "./capability";

const state = vi.hoisted(() => ({
  electron: false,
  features: {} as Record<string, Record<string, boolean>>,
  configurations: {} as Record<string, unknown>,
}));
vi.mock("@/constants/platform", () => ({
  isWeb: true,
  getIsElectron: () => state.electron,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (id: string | null | undefined, feature: string) =>
    id ? state.features[id]?.[feature] === true : false,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (value: {
      sessions: Record<string, { serverInfo: { networkFetchConfiguration: unknown } }>;
    }) => unknown,
  ) =>
    selector({
      sessions: Object.fromEntries(
        Object.entries(state.configurations).map(([id, config]) => [
          id,
          { serverInfo: { networkFetchConfiguration: config } },
        ]),
      ),
    }),
}));

const configuration = {
  dedicatedContentDomain: "ticket04-content.test",
  assetVersion: "ticket04-product-nav-v2",
  bootstrapPath: "/__paseo/ticket04-product-nav-v2/bootstrap.html",
  pathPrefix: "/app/",
  ttlMs: 120_000,
  handshakeTimeoutMs: 20_000,
};
let root: Root;
let container: HTMLDivElement;
function Eligibility({ serverId }: { serverId?: string | null }) {
  return <output>{String(useCanOpenBrowserTab(serverId))}</output>;
}
async function check(expected: boolean, serverId: string | null | undefined = "a") {
  await act(async () => root.render(<Eligibility serverId={serverId} />));
  expect(container.textContent).toBe(String(expected));
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  state.electron = false;
  state.features = { a: { networkFetch: true, remoteBrowser: false } };
  state.configurations = { a: configuration };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("browser tab eligibility for a DOM-only host", () => {
  it("allows valid browser web configuration without an image renderer or an opt-in input", async () => {
    await check(true);
  });
  it.each([
    undefined,
    null,
    {},
    { ...configuration, ttlMs: 0 },
    { ...configuration, bootstrapPath: "//outside.test/" },
  ])("refuses absent or malformed authenticated configuration %j", async (invalid) => {
    state.configurations.a = invalid;
    await check(false);
  });
  it("reacts to feature and configuration removal and restoration", async () => {
    await check(true);
    state.features.a.networkFetch = false;
    await check(false);
    state.features.a.networkFetch = true;
    delete state.configurations.a;
    await check(false);
    state.configurations.a = configuration;
    await check(true);
  });
  it("does not borrow configuration or capability from another host", async () => {
    state.features.b = { networkFetch: true };
    await check(true, "a");
    await check(false, "b");
    state.configurations.b = configuration;
    state.features.b.networkFetch = false;
    await check(false, "b");
    await check(false, null);
    await check(false, "unknown");
  });
  it("preserves Electron eligibility without host capabilities", async () => {
    state.electron = true;
    state.features = {};
    state.configurations = {};
    await check(true, null);
  });
  it("preserves remote browser eligibility without local DOM configuration", async () => {
    state.features.a = { remoteBrowser: true };
    state.configurations = {};
    await check(true);
  });
});
