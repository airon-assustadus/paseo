import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWindowDimensions } from "react-native";
import { NetworkFetchConfigurationSchema } from "@getpaseo/protocol/network-fetch/rpc-schemas";
import { getIsElectron, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useKeyboardShift } from "@/keyboard/shift";
import {
  hasActiveWebOverlay,
  subscribeWebOverlayState,
  WEB_SURFACE_PLANE,
} from "@/lib/overlay-root";
import { useMobileSurfacePresentation } from "@/mobile-panels/surface-presentation.web";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { subscribeWorkspaceRemoval } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { WebProxyProductSnapshot } from "@/web-proxy/product-types";
import { useBrowserStore } from "../store";
import { webProxySettings } from "../web-proxy-settings";
import {
  createResidentRegistry,
  type ResidentBinding,
  type ResidentRegistry,
} from "./registry.web";

const ResidentContext = createContext<ResidentRegistry | null>(null);
const hostStyle = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  zIndex: WEB_SURFACE_PLANE.browser,
} as const;
let nextKeyboardListener = -1_000_000;

function isBindingValid(binding: ResidentBinding): boolean {
  const { view, client } = binding;
  const runtime = getHostRuntimeStore();
  if (runtime.getClient(view.serverId) !== client) return false;
  if (!useBrowserStore.getState().browsersById[view.browserId]) return false;
  if (webProxySettings.getState().domByHost[view.serverId] !== true) return false;
  if (
    runtime.isHostRegistryLoaded() &&
    !runtime.getHosts().some((host) => host.serverId === view.serverId)
  )
    return false;
  // A transport loss suspends C; it does not erase the authenticated identity.
  if (client.getConnectionState().status !== "connected") return true;
  const info = client.getLastServerInfoMessage();
  if (info?.serverId !== view.serverId || !client.isNetworkFetchSupported()) return false;
  const current = NetworkFetchConfigurationSchema.safeParse(info.networkFetchConfiguration);
  return current.success && JSON.stringify(current.data) === JSON.stringify(binding.configuration);
}

function publishMetadata(view: ResidentBinding["view"], snapshot: WebProxyProductSnapshot): void {
  if (snapshot.url === null) return;
  useBrowserStore.getState().updateBrowser(view.browserId, {
    url: snapshot.url,
    ...(snapshot.title !== null ? { title: snapshot.title } : {}),
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    isLoading: snapshot.phase === "opening",
  });
}

function WebResidentDomProxyProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [registry, setRegistry] = useState<ResidentRegistry | null>(null);
  const compact = useIsCompactFormFactor();
  const dimensions = useWindowDimensions();
  const presentation = useMobileSurfacePresentation();
  const keyboard = useKeyboardShift();
  const presentationGate = useRef<() => boolean>(() => true);
  presentationGate.current = () => {
    const layoutPending = dimensions.width !== window.innerWidth;
    const panelBlocked = compact && presentation.getSnapshot();
    return layoutPending || panelBlocked || keyboard.isMoving.value || hasActiveWebOverlay();
  };

  useLayoutEffect(() => {
    if (!host) return;
    const next = createResidentRegistry({
      root: host,
      isBindingValid,
      isPresentationBlocked: () => presentationGate.current(),
      onSnapshot: publishMetadata,
    });
    const runtime = getHostRuntimeStore();
    const dispose = [
      subscribeWebOverlayState(next.invalidatePresentation),
      runtime.subscribeAll(next.reconcile),
      runtime.subscribeHostList(next.reconcile),
      webProxySettings.subscribe(next.reconcile),
      useBrowserStore.subscribe((state, previous) => {
        if (state.browsersById === previous.browsersById) return;
        next.closeWhere((view) => !state.browsersById[view.browserId]);
      }),
      subscribeWorkspaceRemoval((removal) =>
        next.closeWhere(
          (view) =>
            view.serverId === removal.serverId &&
            normalizeWorkspaceOpaqueId(view.workspaceId) ===
              normalizeWorkspaceOpaqueId(removal.workspaceId),
        ),
      ),
    ];
    next.reconcile();
    setRegistry(next);
    return () => {
      for (const unsubscribe of dispose) unsubscribe();
      next.dispose();
    };
  }, [host]);

  useLayoutEffect(() => {
    if (!registry) return;
    const unsubscribe = presentation.subscribe(registry.invalidatePresentation);
    const keyboardListener = nextKeyboardListener--;
    keyboard.isMoving.addListener(keyboardListener, registry.invalidatePresentation);
    keyboard.shift.addListener(keyboardListener, registry.invalidatePresentation);
    keyboard.layoutShift.addListener(keyboardListener, registry.invalidatePresentation);
    registry.invalidatePresentation();
    return () => {
      unsubscribe();
      keyboard.isMoving.removeListener(keyboardListener);
      keyboard.shift.removeListener(keyboardListener);
      keyboard.layoutShift.removeListener(keyboardListener);
    };
  }, [registry, keyboard, presentation]);

  useLayoutEffect(() => registry?.invalidatePresentation(), [compact, dimensions.width, registry]);

  return (
    <ResidentContext.Provider value={registry}>
      {children}
      <div
        key="resident-dom-host"
        ref={setHost}
        style={hostStyle}
        data-testid="dom-proxy-resident-host"
      />
    </ResidentContext.Provider>
  );
}

export function ResidentDomProxyProvider({ children }: { children: ReactNode }) {
  if (!isWeb || getIsElectron()) return children;
  return <WebResidentDomProxyProvider>{children}</WebResidentDomProxyProvider>;
}

export function useResidentDomProxy(): ResidentRegistry | null {
  return useContext(ResidentContext);
}
