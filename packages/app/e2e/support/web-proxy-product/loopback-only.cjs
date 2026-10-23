const net = require("node:net");
const { appendFileSync } = require("node:fs");

// Expo does not pass a bind host to Metro. Constrain only this proof's Node
// subprocess tree before globalSetup starts it; no shared harness is patched.
if (process.env.PASEO_PRODUCT_E2E_ISOLATED !== "1" || !process.env.PASEO_PRODUCT_BIND_LOG) {
  throw new Error("Loopback preload requires the private product-proof launcher");
}
const originalListen = net.Server.prototype.listen;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...input) {
  const args = Array.isArray(input[0]) ? input[0] : input;
  if (typeof args[0] === "object" && args[0] !== null) {
    if (args[0].path || args[0].fd !== undefined) {
      throw new Error("Product proof does not admit shared local socket connections");
    }
    assertLoopback(args[0].host ?? args[0].hostname ?? "localhost");
  } else if (typeof args[0] === "number") {
    assertLoopback(typeof args[1] === "string" ? args[1] : "localhost");
  } else {
    throw new Error("Unsupported outbound connection in isolated product proof");
  }
  return Reflect.apply(originalConnect, this, input);
};
net.Server.prototype.listen = function listen(...input) {
  const args = [...input];
  if (typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
    if (args[0].path || args[0].fd !== undefined || args[0].handle) {
      throw new Error("Product proof does not admit inherited/socket-path listeners");
    }
    args[0] = { ...args[0], host: args[0].host ?? "127.0.0.1" };
    assertLoopback(args[0].host);
  } else if (typeof args[0] === "number") {
    if (typeof args[1] === "string") assertLoopback(args[1]);
    else if (args[1] === undefined || args[1] === null) args[1] = "127.0.0.1";
    else args.splice(1, 0, "127.0.0.1");
  } else {
    throw new Error("Unsupported listener shape in isolated product proof");
  }
  this.once("listening", () => {
    const address = this.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP proof listener");
    assertLoopback(address.address);
    appendFileSync(
      process.env.PASEO_PRODUCT_BIND_LOG,
      `${JSON.stringify({ pid: process.pid, argv: process.argv, address })}\n`,
      { mode: 0o600 },
    );
  });
  return Reflect.apply(originalListen, this, args);
};

function assertLoopback(host) {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("Non-loopback socket refused by product-proof harness");
  }
}
