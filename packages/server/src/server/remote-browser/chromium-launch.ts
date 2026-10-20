import path from "node:path";

/**
 * Flags that would weaken containment or open a control channel. The launcher never emits them,
 * and `assertSafeChromiumArgs` refuses any argument list that contains one.
 */
export const FORBIDDEN_CHROMIUM_FLAGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--single-process",
  "--no-zygote",
  "--in-process-gpu",
  "--ignore-certificate-errors",
  "--ignore-certificate-errors-spki-list",
  "--ignore-ssl-errors",
  "--allow-insecure-localhost",
  "--remote-debugging-port",
  "--remote-debugging-address",
  "--remote-allow-origins",
  "--user-data-dir-from-env",
  "--load-extension",
  "--disable-web-security",
] as const;

export interface ChromiumArgsInput {
  userDataDir: string;
  proxyPort: number;
  /** JS heap ceiling per renderer; a secondary bound, the RSS watchdog is the real limit. */
  maxOldSpaceMb: number;
  rendererProcessLimit: number;
}

export function buildChromiumArgs(input: ChromiumArgsInput): string[] {
  const proxy = `http://127.0.0.1:${input.proxyPort}`;
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${input.userDataDir}`,
    // Every connection, loopback included, goes through the daemon's proxy and its policy.
    `--proxy-server=${proxy}`,
    "--proxy-bypass-list=<-loopback>",
    // Fail closed: any resolution that is not through the proxy finds nothing.
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    "--no-pings",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-client-side-phishing-detection",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    "--mute-audio",
    "--hide-scrollbars",
    // BackForwardCache and SpareRendererForSitePerProcess keep extra renderers alive; the RSS
    // watchdog sums every process, so idle renderers count against the browser's limit.
    // AimEnabled & co.: the omnibox AI-mode eligibility service fetches google.com/async/folae
    // from the page's own context at startup (found with NetLog; gate in
    // components/omnibox/browser/aim_eligibility_service_features.cc).
    "--disable-features=OptimizationHints,OptimizationGuideModelDownloading,Translate,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,PrivacySandboxSettings4,NetworkTimeServiceQuerying,LensOverlay,AimEnabled,AimServerEligibilityEnabled,AimServerRequestOnStartupEnabled,BackForwardCache,SpareRendererForSitePerProcess",
    `--js-flags=--max-old-space-size=${input.maxOldSpaceMb}`,
    `--renderer-process-limit=${input.rendererProcessLimit}`,
    "about:blank",
  ];
}

export class UnsafeChromiumArgsError extends Error {
  constructor(readonly flag: string) {
    super(`Refusing to launch Chromium with ${flag}`);
    this.name = "UnsafeChromiumArgsError";
  }
}

export function assertSafeChromiumArgs(args: readonly string[]): void {
  for (const arg of args) {
    const name = arg.split("=", 1)[0];
    const forbidden = FORBIDDEN_CHROMIUM_FLAGS.find((flag) => flag === name);
    if (forbidden) throw new UnsafeChromiumArgsError(forbidden);
  }
}

const PASSED_ENV = ["PATH", "LANG", "LANGUAGE", "TZ", "FONTCONFIG_PATH", "FONTCONFIG_FILE"];

/**
 * Minimal environment. HOME and XDG point into the browser's temp dir so the user's NSS database
 * (client certificates, user-added CAs), keyrings and Chrome profiles are never read.
 */
export function buildChromiumEnv(input: {
  parentEnv: NodeJS.ProcessEnv;
  homeDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSED_ENV) {
    const value = input.parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  env.HOME = input.homeDir;
  env.XDG_CONFIG_HOME = path.join(input.homeDir, ".config");
  env.XDG_CACHE_HOME = path.join(input.homeDir, ".cache");
  env.XDG_DATA_HOME = path.join(input.homeDir, ".local", "share");
  return env;
}
