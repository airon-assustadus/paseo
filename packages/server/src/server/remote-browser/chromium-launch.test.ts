import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_CHROMIUM_FLAGS,
  UnsafeChromiumArgsError,
  assertSafeChromiumArgs,
  buildChromiumArgs,
  buildChromiumEnv,
} from "./chromium-launch.js";
import {
  findRemoteBrowserExecutable,
  REMOTE_BROWSER_EXECUTABLE_ENV,
} from "./chromium-executable.js";

const args = buildChromiumArgs({
  userDataDir: "/tmp/rb-x/profile",
  proxyPort: 41000,
  maxOldSpaceMb: 512,
  rendererProcessLimit: 4,
});

describe("Chromium launch arguments", () => {
  it("never contains a forbidden flag", () => {
    expect(() => assertSafeChromiumArgs(args)).not.toThrow();
    for (const flag of FORBIDDEN_CHROMIUM_FLAGS) {
      expect(args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
    }
  });

  it.each(FORBIDDEN_CHROMIUM_FLAGS.map((flag) => [flag]))("refuses %s", (flag) => {
    expect(() => assertSafeChromiumArgs([...args, `${flag}=1`])).toThrow(UnsafeChromiumArgsError);
    expect(() => assertSafeChromiumArgs([...args, flag])).toThrow(UnsafeChromiumArgsError);
  });

  it("routes every connection through the daemon proxy and fails closed otherwise", () => {
    expect(args).toContain("--proxy-server=http://127.0.0.1:41000");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(args).toContain("--remote-debugging-pipe");
    expect(args).toContain("--headless=new");
  });

  it("keeps the user's home, keyrings and display out of the browser environment", () => {
    const env = buildChromiumEnv({
      parentEnv: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        SSH_AUTH_SOCK: "/run/user/1000/ssh",
        PASEO_HOME: "/home/user/.paseo",
        LC_ALL: "pt_BR.UTF-8",
        LANG: "pt_BR.UTF-8",
      },
      homeDir: "/tmp/rb-x/home",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "pt_BR.UTF-8",
      LC_ALL: "pt_BR.UTF-8",
      HOME: "/tmp/rb-x/home",
      XDG_CONFIG_HOME: "/tmp/rb-x/home/.config",
      XDG_CACHE_HOME: "/tmp/rb-x/home/.cache",
      XDG_DATA_HOME: "/tmp/rb-x/home/.local/share",
    });
  });
});

describe("remote browser executable discovery", () => {
  const executables = new Set(["/usr/bin/google-chrome", "/opt/chrome/chrome"]);
  const isExecutable = (file: string) => executables.has(file);

  it("is unsupported on Windows even with an explicit path", () => {
    expect(
      findRemoteBrowserExecutable({
        platform: "win32",
        env: { [REMOTE_BROWSER_EXECUTABLE_ENV]: "C:\\chrome.exe" },
        isExecutable: () => true,
      }),
    ).toEqual({ kind: "unsupported_platform" });
  });

  it("prefers an explicit absolute executable", () => {
    expect(
      findRemoteBrowserExecutable({
        platform: "linux",
        env: { [REMOTE_BROWSER_EXECUTABLE_ENV]: "/opt/chrome/chrome", PATH: "/usr/bin" },
        isExecutable,
      }),
    ).toEqual({ kind: "found", path: "/opt/chrome/chrome" });
  });

  it.each([["relative/chrome"], ["/missing/chrome"]])("rejects explicit %s", (value) => {
    expect(
      findRemoteBrowserExecutable({
        platform: "linux",
        env: { [REMOTE_BROWSER_EXECUTABLE_ENV]: value, PATH: "/usr/bin" },
        isExecutable,
      }).kind,
    ).toBe("invalid_configuration");
  });

  it("searches PATH for installed Chrome or Chromium, skipping relative entries", () => {
    expect(
      findRemoteBrowserExecutable({
        platform: "linux",
        env: { PATH: "bin:/usr/bin" },
        isExecutable,
      }),
    ).toEqual({ kind: "found", path: "/usr/bin/google-chrome" });
    expect(
      findRemoteBrowserExecutable({ platform: "linux", env: { PATH: "/nowhere" }, isExecutable }),
    ).toEqual({ kind: "not_found" });
  });
});
