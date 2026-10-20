import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** Explicit executable for the remote browser; must be an absolute path. */
export const REMOTE_BROWSER_EXECUTABLE_ENV = "PASEO_REMOTE_BROWSER_EXECUTABLE";

const PATH_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
const MACOS_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export interface ExecutableLookupInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable?: (file: string) => boolean;
}

export type ExecutableLookupResult =
  | { kind: "found"; path: string }
  | { kind: "unsupported_platform" }
  | { kind: "not_found" }
  | { kind: "invalid_configuration"; reason: string };

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds an installed Chrome or Chromium. Nothing is downloaded, and Playwright's browser cache is
 * not searched. Containment and cleanup are POSIX designs, so Windows is unsupported even with an
 * explicit path.
 */
export function findRemoteBrowserExecutable(input: ExecutableLookupInput): ExecutableLookupResult {
  if (input.platform !== "linux" && input.platform !== "darwin") {
    return { kind: "unsupported_platform" };
  }
  const isExecutable = input.isExecutable ?? isExecutableFile;
  const configured = input.env[REMOTE_BROWSER_EXECUTABLE_ENV]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      return {
        kind: "invalid_configuration",
        reason: `${REMOTE_BROWSER_EXECUTABLE_ENV} must be absolute`,
      };
    }
    return isExecutable(configured)
      ? { kind: "found", path: configured }
      : {
          kind: "invalid_configuration",
          reason: `${REMOTE_BROWSER_EXECUTABLE_ENV} is not executable`,
        };
  }
  const searchPath = (input.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir));
  for (const name of PATH_CANDIDATES) {
    for (const dir of searchPath) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return { kind: "found", path: candidate };
    }
  }
  if (input.platform === "darwin") {
    for (const candidate of MACOS_CANDIDATES) {
      if (isExecutable(candidate)) return { kind: "found", path: candidate };
    }
  }
  return { kind: "not_found" };
}
