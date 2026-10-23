import { expect, it, vi } from "vitest";
import { useCanOpenBrowserTab } from "./capability";

// Platform constants are fixed at module load, as in a native bundle. Mutating a
// browser mock's getter after import cannot emulate that separate platform.
const runtime = vi.hoisted(() => ({ remote: false }));
vi.mock("@/constants/platform", () => ({ isWeb: false, getIsElectron: () => false }));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_id: string, feature: string) =>
    feature === "remoteBrowser" ? runtime.remote : true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: () => ({
    dedicatedContentDomain: "ticket04-content.test",
    assetVersion: "ticket04-product-nav-v2",
    bootstrapPath: "/bootstrap.html",
    pathPrefix: "/app/",
    ttlMs: 120_000,
    handshakeTimeoutMs: 20_000,
  }),
}));
function NativeEligibility() {
  return useCanOpenBrowserTab("a");
}
it("preserves native image eligibility without enabling DOM from valid networkFetch configuration", () => {
  runtime.remote = false;
  expect(NativeEligibility()).toBe(false);
  runtime.remote = true;
  expect(NativeEligibility()).toBe(true);
});
