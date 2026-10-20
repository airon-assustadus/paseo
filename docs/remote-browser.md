# Remote browser

The Android app and Paseo in a mobile browser cannot route a local browser through the host: Chromium's proxy setting belongs to the browser, not to a web page. They use a remote browser instead. A sandboxed Chromium runs on the host, the app shows its JPEG frames and sends a closed set of input and navigation operations over the existing authenticated connection. Electron keeps its routed `<webview>` ([browser-host-network.md](browser-host-network.md)).

The wire contract is `packages/protocol/src/remote-browser/rpc-schemas.ts` and `packages/protocol/src/binary-frames/remote-browser.ts`; the SDK is `packages/client/src/remote-browser.ts`; the daemon side is `packages/server/src/server/remote-browser/`.

## Design

```text
app pane  <- JPEG frames (0x30), state events      -> input, navigate, resize, visibility, acks (0x31)
  `-- DaemonClient.openRemoteBrowser()  (owned subscription per attachment)
        `-- RemoteBrowserSession  (one per daemon Session: ownership, queue, frames, state)
              `-- RemoteBrowserManager  (daemon-wide: count, memory watchdog, shutdown)
                    `-- Chromium, headless, CDP over --remote-debugging-pipe, temp profile and HOME
                          |-- page context  -> policy proxy  -> dial-target.ts (tunnel policy)
                          `-- process       -> deny-all proxy (browser-internal traffic)
```

## Decisions

**CDP over a pipe, no Playwright at runtime.** `--remote-debugging-pipe` gives the control channel to the daemon only; no DevTools port exists. Playwright's launcher adds `--no-sandbox` and its proxy authentication intercepts every request.

**Sandbox or nothing.** `FORBIDDEN_CHROMIUM_FLAGS` in `chromium-launch.ts` is enforced on every launch. Without a usable sandbox (root, containers without user namespaces) the launch fails and `open` answers `browser_unavailable`. Windows advertises the feature as unavailable: process-group containment and cleanup are POSIX designs.

**Memory limit on summed RSS.** The watchdog sums the RSS of every verified process: 1536 MiB per browser, 3072 MiB for all of them. Shared pages count once per process, so a simple page already measures about 1.5 GiB (its PSS is about 330 MiB). Heavier pages end with `browser.remote.closed` reason `memory_limit`. Back-forward cache and the spare renderer are disabled and the renderer limit is 2 to keep idle processes out of that sum. Close returns only after every verified process has exited; processes that outlive close keep their slot and memory counted.

**One Chromium per browser.** Crash and memory isolation, and cleanup is "end this process tree". Process identity is `(pid, start time)` as read from `/proc` or `ps`; nothing is signalled by number alone, and adoption into the tree re-reads the parent around each child because `/proc` is not read atomically.

**Two proxies per browser.** The page lives in a `Target.createBrowserContext` whose proxy applies the network-tunnel policy through `network-tunnel/dial-target.ts`: DNS on the host, every answer approved, the approved IP dialed, metadata and link-local denied. The process-wide `--proxy-server` points at a proxy that refuses everything, so component updates, push, sync and account checks never leave the host. `--proxy-bypass-list=<-loopback>` sends loopback through the proxy too, and `--host-resolver-rules=MAP * ~NOTFOUND` makes any non-proxied resolution fail. Neither proxy asks for a credential: it runs on the host it routes from, so a local process that finds the port gains nothing it could not reach directly.

**Ownership by attachment.** Every attachment operation names `browserId`, `subscriptionId` and `generation`. Each browser has one serial queue; every CDP write re-checks the attachment immediately before it is written, so a takeover never lets queued input from the previous attachment reach the page.

**Exact frame acks.** At most `maxFramesInFlight` frames are unacknowledged. While the window is full the daemon withholds Chromium's screencast ack, so a slow or hidden client costs no encoding. The ack deadline pauses while the pane is hidden.

**Bounded state.** Page-controlled strings are truncated on arrival and every state message, reply or event, is shrunk to `REMOTE_BROWSER_MAX_STATE_BYTES` serialized. Emission is coalesced to one per 100 ms.

## Gotchas measured with Chromium 155

- **Titles arrive late.** `Target.targetInfoChanged` reports title changes lazily, sometimes only when the target closes. The focus probe also reads `document.title`; it runs every 300 ms while visible and after each input batch.
- **`ws://` uses `CONNECT`.** Chromium tunnels plain WebSockets through an HTTP proxy with `CONNECT`, like `wss://`. The proxy still accepts an absolute-form `GET` with `Upgrade` for other clients.
- **The AI-mode eligibility service calls Google from the page's context.** A fresh context fetches `https://www.google.com/async/folae` at creation, through the page proxy. Network prediction, search suggestions and the default search provider prefs do not stop it; the `AimEnabled` feature gate does (`components/omnibox/browser/aim_eligibility_service_features.cc`). Find the next one with `--log-net-log` and the request's `traffic_annotation`.
- **Permission names.** `Browser.setPermission` takes Blink `PermissionDescriptor` names (`camera`, `clipboard-read`), not `Browser.PermissionType` names (`videoCapture`). A wrong name fails silently if errors are swallowed; the essential denials abort the launch instead.
- **Failed redirects.** `Page.navigate` reports the error against the URL asked for, not the redirect target that failed. The load error takes the proxy's most recent failure since the navigation started.
- **Denied downloads** surface only as `Browser.downloadWillBegin` when `Browser.setDownloadBehavior` has `eventsEnabled: true`.
- **Startup tab.** The process opens an `about:blank` tab in its default context; it is closed once the isolated page exists.

## Not supported

| Feature                                                                 | Behaviour                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Upload                                                                  | File chooser intercepted, nothing opens; `notice: file_chooser_blocked`  |
| Download                                                                | Denied, nothing written on the host; `notice: download_blocked`          |
| JS dialogs                                                              | alert accepted, confirm and prompt cancelled; `notice: dialog_dismissed` |
| Popups                                                                  | Opened in place; `notice: popup_opened_in_place`                         |
| Camera, microphone, geolocation, notifications, clipboard, MIDI         | Denied for every origin                                                  |
| Clipboard bridging, audio, pinch zoom, selection handles, drag and drop | Not available                                                            |
| Accessibility                                                           | Not available: the app shows an image                                    |
| Passkeys, client certificates, user-added CAs, HTTP basic auth          | Not available: fresh profile and HOME                                    |
