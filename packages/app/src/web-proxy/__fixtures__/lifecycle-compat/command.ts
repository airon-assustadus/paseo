import type { BridgeCommandContext } from "../../../../vitest.web-proxy-bridge";
import type { Proof } from "./scenarios";

export interface LifecycleCompatResult {
  browser: string;
  hashes: Record<string, string>;
  served: Array<{ file: string; sha256: string }>;
  proofs: Proof[];
}

declare module "vitest/browser" {
  interface BrowserCommands {
    webProxyLifecycleCompat(
      scenario: "probe" | "restart" | "published" | "matrix" | "transitions" | "overlay",
    ): Promise<LifecycleCompatResult>;
  }
}

/** Nothing starts while Vitest loads the config or runs another test file. */
export function lifecycleCompatCommandFor(appRoot: string) {
  return async function webProxyLifecycleCompat(
    context: BridgeCommandContext,
    scenario: "probe" | "restart" | "published" | "matrix" | "transitions" | "overlay",
  ): Promise<LifecycleCompatResult> {
    const { createLifecycleBench } = await import("./bench");
    const { probePreservation, restartWindow, matrix, transitions, overlayResume } =
      await import("./scenarios");
    const bench = await createLifecycleBench(appRoot, context);
    try {
      let proofs: Proof[];
      switch (scenario) {
        case "probe":
          proofs = await probePreservation(bench);
          break;
        case "restart":
          proofs = [await restartWindow(bench)];
          break;
        case "transitions":
          proofs = await transitions(bench);
          break;
        case "overlay":
          proofs = [await overlayResume(bench)];
          break;
        case "published":
          proofs = await matrix(bench, true);
          break;
        case "matrix":
          proofs = await matrix(bench, false);
          break;
      }
      const result = {
        browser: bench.browser.version(),
        hashes: bench.hashes,
        served: bench.served,
        proofs,
      };
      console.log("LIFECYCLE_COMPAT_EVIDENCE", JSON.stringify(result));
      return result;
    } finally {
      await bench.close();
    }
  };
}
