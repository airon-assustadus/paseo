import { DEFAULT_BRIDGE_LIMITS } from "../bridge-messages";
import { installShellWorker } from "../shell/worker.web";
import { HARNESS, harnessControlOrigin } from "./shell/harness";

installShellWorker(globalThis, {
  controlOrigin: harnessControlOrigin(globalThis.location),
  shellPathPrefix: HARNESS.shellPathPrefix,
  bootstrapPath: HARNESS.bootstrapPath,
  mountPath: HARNESS.mountPath,
  enterPath: HARNESS.enterPath,
  headTimeoutMs: HARNESS.headTimeoutMs,
  idleChunkTimeoutMs: HARNESS.idleChunkTimeoutMs,
  ticketTtlMs: HARNESS.ticketTtlMs,
  formationTtlMs: HARNESS.formationTtlMs,
  resyncTimeoutMs: HARNESS.resyncTimeoutMs,
  maxRequestBodyBytes: DEFAULT_BRIDGE_LIMITS.maxRequestBodyBytes,
});
