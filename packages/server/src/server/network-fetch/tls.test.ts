import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedTunnelAddress } from "../network-tunnel/target-policy.js";
import { parseTrustedTarget } from "./allowlist.js";
import type { NetworkFetchFailure, NetworkFetchSink } from "./session.js";
import { openNetworkFetchSession } from "./session.js";

interface TestPki {
  caCert: string;
  leafKey: string;
  leafCert: string;
  selfSignedKey: string;
  selfSignedCert: string;
}

/** A private CA per run; keys live in a 0700 temp dir only while openssl writes them. */
function createTestPki(): TestPki {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-network-fetch-tls-"));
  const file = (name: string) => path.join(dir, name);
  const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  try {
    writeFileSync(
      file("leaf.ext"),
      "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n" +
        "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:fixture.test\n",
    );
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Paseo network fetch test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      file("ca.key"),
      "-out",
      file("ca.pem"),
    ]);
    openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=fixture.test",
      "-keyout",
      file("leaf.key"),
      "-out",
      file("leaf.csr"),
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      file("leaf.csr"),
      "-CA",
      file("ca.pem"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      file("leaf.ext"),
      "-out",
      file("leaf.pem"),
    ]);
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=fixture.test",
      "-addext",
      "subjectAltName=DNS:fixture.test",
      "-keyout",
      file("self.key"),
      "-out",
      file("self.pem"),
    ]);
    return {
      caCert: readFileSync(file("ca.pem"), "utf8"),
      leafKey: readFileSync(file("leaf.key"), "utf8"),
      leafCert: readFileSync(file("leaf.pem"), "utf8"),
      selfSignedKey: readFileSync(file("self.key"), "utf8"),
      selfSignedCert: readFileSync(file("self.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function serveTls(key: string, cert: string) {
  const server = https.createServer({ key, cert }, (_request, response) => response.end("secure"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Fixture has no port");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function fetchOnce(input: {
  url: string;
  tlsCa: readonly string[] | null;
}): Promise<{ body: string } | NetworkFetchFailure> {
  const target = new URL(input.url);
  const allowlist = {
    id: "tls",
    revision: 1,
    targets: [parseTrustedTarget({ origin: target.origin, pathPrefix: "/" })],
  };
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const sink: NetworkFetchSink = {
      head: () => {},
      body: (_requestId, chunk) => chunks.push(Buffer.from(chunk)),
      end: () => {
        session.close();
        resolve({ body: Buffer.concat(chunks).toString("utf8") });
      },
      fail: (_requestId, failure) => {
        session.close();
        resolve(failure);
      },
      uploadCredit: () => {},
      closed: () => {},
    };
    const session = openNetworkFetchSession({
      allowlists: { get: () => allowlist },
      allowlistRef: { id: "tls", revision: 1 },
      scope: { origin: target.origin, pathPrefix: "/" },
      ttlMs: 10_000,
      isAuthorized: () => true,
      protectedLocalPorts: () => new Set(),
      localAddresses: () => [],
      lookup: async (hostname): Promise<ResolvedTunnelAddress[]> =>
        hostname.endsWith(".test") ? [{ address: "127.0.0.1", family: 4 }] : [],
      tlsCa: input.tlsCa,
      sink,
    });
    session.request({
      requestId: 1,
      method: "GET",
      url: input.url,
      headers: [],
      redirect: "error",
      body: { kind: "none" },
    });
  });
}

describe("network fetch TLS", () => {
  let pki: TestPki;
  let trusted: Awaited<ReturnType<typeof serveTls>>;
  let selfSigned: Awaited<ReturnType<typeof serveTls>>;

  beforeAll(async () => {
    pki = createTestPki();
    trusted = await serveTls(pki.leafKey, pki.leafCert);
    selfSigned = await serveTls(pki.selfSignedKey, pki.selfSignedCert);
  });

  afterAll(async () => {
    await trusted.close();
    await selfSigned.close();
  });

  it("verifies the name's certificate while dialing the address the host approved", async () => {
    const result = await fetchOnce({
      url: `https://fixture.test:${trusted.port}/`,
      tlsCa: [pki.caCert],
    });

    expect(result).toEqual({ body: "secure" });
  });

  it("rejects a private CA that is not in the trusted roots", async () => {
    const result = await fetchOnce({ url: `https://fixture.test:${trusted.port}/`, tlsCa: null });

    expect(result).toMatchObject({ code: "tls_certificate_invalid" });
  });

  it("rejects a self-signed certificate even when the name matches", async () => {
    const result = await fetchOnce({
      url: `https://fixture.test:${selfSigned.port}/`,
      tlsCa: [pki.caCert],
    });

    expect(result).toMatchObject({ code: "tls_certificate_invalid" });
  });

  it.each([
    ["another name", "other.test"],
    ["the IP literal it was dialed on", "127.0.0.1"],
  ])("rejects the certificate for %s", async (_case, host) => {
    const result = await fetchOnce({
      url: `https://${host}:${trusted.port}/`,
      tlsCa: [pki.caCert],
    });

    expect(result).toMatchObject({ code: "tls_hostname_mismatch" });
  });
});
