import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor, within } from "@testing-library/dom";
import { userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RemoteBrowserRpcError,
  type RemoteBrowserAttachment,
  type RemoteBrowserFrame,
  type RemoteBrowserInputEvent,
  type RemoteBrowserState,
} from "@getpaseo/client";
import { i18n as testI18n } from "@/i18n/i18next";
import { RemoteBrowserPane } from "./pane";
import { createFakeAttachment, createFakeClient, state } from "./test-utils/fake-remote-browser";

// Load translations so the overlays and buttons expose their real text.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The pane in a real Chromium with the real gesture handler, hidden input and canvas presenter.
 * The daemon is a fake client; what is asserted is what the pane sends it and what it shows.
 */

const runtime = vi.hoisted(() => ({
  supported: true,
  status: "online",
  client: null as unknown,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => runtime.supported,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeConnectionStatus: () => runtime.status,
  useHosts: () => [{ serverId: "host-1", label: "Terra", appearance: { color: "blue" } }],
  getHostRuntimeStore: () => ({ getSnapshot: () => ({ client: runtime.client }) }),
}));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  runtime.supported = true;
  runtime.status = "online";
});

const PANE_WIDTH = 480;
const PANE_HEIGHT = 400;

function mountPane(props: { isInteractive?: boolean; onFocusPane?: () => void } = {}) {
  const fake = createFakeClient();
  runtime.client = fake.client;
  const container = document.createElement("div");
  container.style.width = `${PANE_WIDTH}px`;
  container.style.height = `${PANE_HEIGHT}px`;
  container.style.display = "flex";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <RemoteBrowserPane browserId={`tab-${mounted.length}`} serverId="host-1" {...props} />,
    ),
  );
  mounted.push({ root, container });
  const view = within(container);
  const hiddenInput = () =>
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '[data-testid="remote-browser-keyboard-input"]',
    );
  const surface = () => {
    const canvas = container.querySelector('[data-testid="remote-browser-frame"]');
    const element = canvas?.parentElement;
    if (!(element instanceof HTMLElement)) throw new Error("gesture surface is not mounted");
    return element;
  };
  return { ...fake, container, view, hiddenInput, surface };
}

async function openAttachment(
  pane: ReturnType<typeof mountPane>,
  overrides: Partial<RemoteBrowserState> = {},
) {
  await waitFor(() => expect(pane.opens).toHaveLength(1));
  const { viewport } = pane.opens[0];
  const attachment = createFakeAttachment({
    browserId: "b1",
    generation: 1,
    state: state({ viewport, ...overrides }),
  });
  act(() => pane.opens[0].result.resolve(attachment));
  await waitFor(() => expect(pane.view.queryByTestId("remote-browser-busy")).toBeNull());
  return { attachment, viewport };
}

async function jpegBytes(width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d context unavailable");
  context.fillStyle = "#3366cc";
  context.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg"));
  if (!blob) throw new Error("canvas produced no jpeg");
  return new Uint8Array(await blob.arrayBuffer());
}

async function paintFrame(
  attachment: RemoteBrowserAttachment & {
    emitFrame(frame: RemoteBrowserFrame): void;
    acked: number[];
  },
  viewport: { width: number; height: number },
  seq: number,
): Promise<void> {
  const frame: RemoteBrowserFrame = {
    subscriptionId: attachment.subscriptionId,
    generation: attachment.generation,
    seq,
    cssWidth: viewport.width,
    cssHeight: viewport.height,
    imageWidth: 48,
    imageHeight: 40,
    mimeType: "image/jpeg",
    bytes: await jpegBytes(48, 40),
  };
  act(() => attachment.emitFrame(frame));
  await waitFor(() => expect(attachment.acked).toContain(seq));
}

function inputsOfKind<K extends RemoteBrowserInputEvent["kind"]>(
  attachment: { inputs: RemoteBrowserInputEvent[][] },
  kind: K,
): Extract<RemoteBrowserInputEvent, { kind: K }>[] {
  return attachment.inputs
    .flat()
    .filter((event): event is Extract<RemoteBrowserInputEvent, { kind: K }> => event.kind === kind);
}

describe("remote browser pane in a real browser", () => {
  it("tells the user to update a host without the remote browser and never opens one", async () => {
    runtime.supported = false;
    const pane = mountPane();
    expect(pane.view.getByTestId("remote-browser-unsupported")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pane.opens).toHaveLength(0);
  });

  it("opens with the measured viewport, paints frames and acks each one only after the paint", async () => {
    const pane = mountPane();
    expect(pane.view.getByTestId("remote-browser-busy")).toBeTruthy();
    const { attachment, viewport } = await openAttachment(pane);
    expect(viewport.width).toBe(PANE_WIDTH);
    expect(viewport.height).toBeGreaterThan(0);
    expect(viewport.height).toBeLessThan(PANE_HEIGHT);

    await paintFrame(attachment, viewport, 1);
    await paintFrame(attachment, viewport, 2);
    expect(attachment.acked).toEqual([1, 2]);
    const canvas = pane.container.querySelector<HTMLCanvasElement>(
      '[data-testid="remote-browser-frame"]',
    );
    expect(canvas?.width).toBe(48);
    expect(canvas?.height).toBe(40);
  });

  it("delivers a real mouse tap and a wheel tick to the page in page coordinates", async () => {
    const onFocusPane = vi.fn();
    const pane = mountPane({ onFocusPane });
    const { attachment, viewport } = await openAttachment(pane);
    await paintFrame(attachment, viewport, 1);

    await userEvent.click(pane.surface(), { position: { x: 100, y: 50 } });
    await waitFor(() => expect(inputsOfKind(attachment, "mouse")).toHaveLength(3));
    const mouse = inputsOfKind(attachment, "mouse");
    expect(mouse.map((event) => event.phase)).toEqual(["move", "down", "up"]);
    expect(mouse[1]).toMatchObject({ button: "left", clickCount: 1 });
    expect(mouse[1].x).toBeCloseTo(100, 0);
    expect(mouse[1].y).toBeCloseTo(50, 0);
    expect(onFocusPane).toHaveBeenCalled();

    pane.surface().dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 120,
        clientX: 10,
        clientY: 10,
        bubbles: true,
        cancelable: true,
      }),
    );
    await waitFor(() => expect(inputsOfKind(attachment, "wheel")).toHaveLength(1));
    expect(inputsOfKind(attachment, "wheel")[0]).toMatchObject({ deltaX: 0, deltaY: 120 });
  });

  it("still focuses the pane but sends nothing while the pane is not interactive", async () => {
    const onFocusPane = vi.fn();
    const pane = mountPane({ isInteractive: false, onFocusPane });
    const { attachment, viewport } = await openAttachment(pane);
    await paintFrame(attachment, viewport, 1);

    await userEvent.click(pane.surface(), { position: { x: 40, y: 40 } });
    await waitFor(() => expect(onFocusPane).toHaveBeenCalled());
    pane.surface().dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attachment.inputs).toEqual([]);
  });

  it("uses secure entry unless the page's field is known not to be a password", async () => {
    const pane = mountPane();
    const { attachment } = await openAttachment(pane);
    const input = pane.hiddenInput();
    if (!input) throw new Error("hidden input is not mounted");

    // No focus hint (no field, or a field inside a cross-origin iframe): treated as a password.
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("autocomplete")).toBe("off");

    act(() =>
      attachment.emitState(
        state({
          viewport: attachment.state.viewport,
          focusedEditable: { inputMode: "", inputType: "password", enterKeyHint: "", focusId: 1 },
        }),
      ),
    );
    await waitFor(() => expect(pane.hiddenInput()?.getAttribute("type")).toBe("password"));
    expect(pane.hiddenInput()?.getAttribute("autocorrect")).toBe("off");

    act(() =>
      attachment.emitState(
        state({
          viewport: attachment.state.viewport,
          focusedEditable: { inputMode: "text", inputType: "text", enterKeyHint: "go", focusId: 2 },
        }),
      ),
    );
    await waitFor(() => expect(pane.hiddenInput()?.getAttribute("type")).not.toBe("password"));
    expect(pane.hiddenInput()?.getAttribute("autocorrect")).toBe("on");
    expect(pane.hiddenInput()?.getAttribute("spellcheck")).toBe("true");
  });

  it("shows the open failure with a Retry that opens again", async () => {
    const pane = mountPane();
    await waitFor(() => expect(pane.opens).toHaveLength(1));
    act(() =>
      pane.opens[0].result.reject(
        new RemoteBrowserRpcError("open", "browser_unavailable", "no browser"),
      ),
    );
    const retry = await waitFor(() => pane.view.getByTestId("remote-browser-retry"));
    expect(pane.view.getByTestId("remote-browser-alert")).toBeTruthy();
    await userEvent.click(retry);
    await waitFor(() => expect(pane.opens).toHaveLength(2));
    expect(pane.view.getByTestId("remote-browser-busy")).toBeTruthy();
  });
});
