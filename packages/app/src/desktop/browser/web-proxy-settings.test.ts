import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWebProxySettingsStore } from "./web-proxy-settings";

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { storage, values };
}

describe("web proxy preference", () => {
  it("keeps concurrent host choices separate and restores them before selecting a mode", async () => {
    const { storage } = memoryStorage();
    const first = createWebProxySettingsStore(storage);
    expect(first.getState().ready).toBe(false);
    await first.getState().load();
    await Promise.all([
      first.getState().setDomEnabled("host-a", true),
      first.getState().setDomEnabled("host-b", false),
    ]);
    const restored = createWebProxySettingsStore(storage);
    expect(restored.getState().ready).toBe(false);
    await restored.getState().load();
    expect(restored.getState().domByHost).toEqual({ "host-a": true, "host-b": false });
  });

  it("does not switch a DOM host to image when persisting the explicit choice fails", async () => {
    const { storage } = memoryStorage();
    const preferences = createWebProxySettingsStore(storage);
    await preferences.getState().load();
    await preferences.getState().setDomEnabled("host", true);
    storage.setItem = () => Promise.reject(new Error("storage unavailable"));
    expect(await preferences.getState().setDomEnabled("host", false)).toBe(false);
    expect(preferences.getState().domByHost.host).toBe(true);
    expect(preferences.getState().failed).toBe(true);
  });

  it("keeps mode selection blocked when preferences cannot be read", async () => {
    const { storage } = memoryStorage();
    storage.getItem = () => Promise.reject(new Error("storage unavailable"));
    const preferences = createWebProxySettingsStore(storage);
    await preferences.getState().load();
    expect(preferences.getState().ready).toBe(false);
    expect(preferences.getState().failed).toBe(true);
    expect(await preferences.getState().setDomEnabled("host", false)).toBe(false);
  });
});
