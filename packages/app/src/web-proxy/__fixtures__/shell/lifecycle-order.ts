// Test-only scheduling. Product listener registration and removal keep the same identity.
type Listener =
  | EventListenerOrEventListenerObject
  | ((this: MessagePort, event: MessageEvent) => unknown);

export function delayLifecycleDelivery(origin: string, mode: string): void {
  const queued: Array<() => void> = [];
  const wrappers = new WeakMap<MessagePort, WeakMap<Listener, EventListener>>();
  let released = false;
  const add = MessagePort.prototype.addEventListener;
  const remove = MessagePort.prototype.removeEventListener;
  const report = (kind: string, message: string) =>
    parent.postMessage({ type: "fixture.lifecycle.order", kind, message }, origin);

  MessagePort.prototype.addEventListener = function (
    name: string,
    handler: Listener | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (handler === null) return;
    if (name !== "message") {
      // The DOM overload for non-message events uses EventListener.
      return add.call(this, name, handler as EventListenerOrEventListenerObject, options);
    }
    let byHandler = wrappers.get(this);
    if (byHandler === undefined) {
      byHandler = new WeakMap();
      wrappers.set(this, byHandler);
    }
    let wrapped = byHandler.get(handler);
    if (wrapped === undefined) {
      wrapped = (event) => {
        if (!(event instanceof MessageEvent)) return;
        const type = event.data?.type;
        const isHead = type === "paseo.web.response.head" && event.data.status === 204;
        const isSuspend = type === "paseo.web.suspend";
        // Root is request 1; request 2 is the tested navigation. Preserve response FIFO.
        const holdNavigation =
          mode === "navigation-head" &&
          event.data?.requestId === 2 &&
          typeof type === "string" &&
          type.startsWith("paseo.web.response.");
        const deliver = () => {
          if (typeof handler === "function") handler.call(this, event);
          else handler.handleEvent(event);
          if (isHead || isSuspend || type === "paseo.web.response.error") report("delivered", type);
        };
        if (
          !released &&
          (holdNavigation || (mode === "head" && isHead) || (mode === "suspend" && isSuspend))
        ) {
          queued.push(deliver);
          report("held", type);
        } else deliver();
      };
      byHandler.set(handler, wrapped);
    }
    add.call(this, name, wrapped, options);
  };
  MessagePort.prototype.removeEventListener = function (
    name: string,
    handler: Listener | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (handler === null) return;
    const wrapped = wrappers.get(this)?.get(handler);
    remove.call(
      this,
      name,
      (name === "message" ? (wrapped ?? handler) : handler) as EventListenerOrEventListenerObject,
      options,
    );
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== origin || event.data !== "fixture.release")
      return;
    released = true;
    for (const deliver of queued.splice(0)) deliver();
  });
}
