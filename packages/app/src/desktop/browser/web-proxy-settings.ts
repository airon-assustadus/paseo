import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const preferenceSchema = z.strictObject({
  domByHost: z.record(z.string(), z.boolean()),
});
const storageKey = "workspace-web-proxy-preferences";

interface WebProxySettings {
  ready: boolean;
  loading: boolean;
  failed: boolean;
  domByHost: Record<string, boolean>;
  load(): Promise<void>;
  setDomEnabled(serverId: string, enabled: boolean): Promise<boolean>;
}

export function createWebProxySettingsStore(backingStorage: StateStorage) {
  const storage = createValidatedPersistStorage(backingStorage, preferenceSchema);
  let loading: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();

  return createStore<WebProxySettings>((set, get) => ({
    ready: false,
    loading: false,
    failed: false,
    domByHost: {},
    load() {
      if (get().ready) return Promise.resolve();
      if (loading) return loading;
      set({ loading: true, failed: false });
      loading = Promise.resolve(storage.getItem(storageKey))
        .then((saved) =>
          set({ domByHost: saved?.state.domByHost ?? {}, ready: true, failed: false }),
        )
        .catch(() => set({ failed: true }))
        .finally(() => {
          set({ loading: false });
          loading = null;
        });
      return loading;
    },
    setDomEnabled(serverId, enabled) {
      if (!get().ready || !serverId.trim()) return Promise.resolve(false);
      const change = writes.then(async () => {
        const domByHost = { ...get().domByHost, [serverId]: enabled };
        try {
          await storage.setItem(storageKey, { state: { domByHost } });
          set({ domByHost, failed: false });
          return true;
        } catch {
          set({ failed: true });
          return false;
        }
      });
      writes = change.then(() => undefined);
      return change;
    },
  }));
}

export const webProxySettings = createWebProxySettingsStore(AsyncStorage);

export function useWebProxySettings<T>(selector: (state: WebProxySettings) => T): T {
  return useStore(webProxySettings, selector);
}
