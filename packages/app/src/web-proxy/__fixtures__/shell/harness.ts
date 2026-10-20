// Paths of the browser-test harness. Vite serves everything under /src, so the mount point is
// a subpath and the worker's scope is the mount point alone: a document the worker controls
// sends every request through it, and the bootstrap's Vite modules live outside the shell
// prefix. A deployment serves the shell under "/__paseo/" with scope and mount point "/".
export const HARNESS = {
  workerPath: "/src/web-proxy/__fixtures__/sw.web.ts",
  workerScope: "/src/web-proxy/__fixtures__/app/",
  shellPathPrefix: "/src/web-proxy/__fixtures__/shell/",
  bootstrapPath: "/src/web-proxy/__fixtures__/shell/bootstrap.html",
  mountPath: "/src/web-proxy/__fixtures__/app/",
  headTimeoutMs: 2000,
  idleChunkTimeoutMs: 2000,
} as const;

export type HarnessContentLabel = "wp-a" | "wp-b";

interface OriginParts {
  protocol: string;
  hostname: string;
  port: string;
}

// Content origins are "<label>.localhost" on the test server's port; the control origin is
// "localhost". Distinct origins, not distinct registrable sites.
export function harnessControlOrigin(location: OriginParts): string {
  const hostname = location.hostname.slice(location.hostname.indexOf(".") + 1);
  return `${location.protocol}//${hostname}:${location.port}`;
}

export function harnessContentOrigin(label: HarnessContentLabel, control: OriginParts): string {
  return `${control.protocol}//${label}.${control.hostname}:${control.port}`;
}
