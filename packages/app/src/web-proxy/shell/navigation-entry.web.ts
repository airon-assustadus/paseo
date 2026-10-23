import { parseWorkerToBootstrapMessage } from "./relay-messages";

export async function enterProductNavigation(options: {
  frame: HTMLIFrameElement;
  port: MessagePort;
  target: string;
  ticket: string;
  enterPath: string;
  timeoutMs: number;
  signal: AbortSignal;
  isCurrent(): boolean;
}): Promise<boolean> {
  const live = () => !options.signal.aborted && options.isCurrent();
  if (!live()) return false;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (ready: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.port.removeEventListener("message", onMessage);
    options.port.removeEventListener("close", onClose);
    options.signal.removeEventListener("abort", onClose);
    resolve(ready);
  };
  const onClose = () => finish(false);
  const onMessage = (event: MessageEvent) => {
    const message = parseWorkerToBootstrapMessage(event.data);
    if (event.ports.length !== 0 || message?.type !== "paseo.shell.ticket.ready") return;
    if (message.ticket === options.ticket) finish(live());
  };
  const timer = setTimeout(onClose, options.timeoutMs);
  options.port.addEventListener("message", onMessage);
  options.port.addEventListener("close", onClose);
  options.signal.addEventListener("abort", onClose, { once: true });
  options.port.start();
  if (!live()) {
    finish(false);
    return false;
  }
  try {
    options.port.postMessage(
      {
        type: "paseo.shell.navigation.ticket.prepare",
        v: 1,
        ticket: options.ticket,
        target: options.target,
      },
      [],
    );
  } catch {
    finish(false);
  }
  const prepared = await promise;
  if (!prepared || !live()) return false;
  options.frame.referrerPolicy = "no-referrer";
  options.frame.src = `${options.enterPath}?t=${options.ticket}`;
  return true;
}
