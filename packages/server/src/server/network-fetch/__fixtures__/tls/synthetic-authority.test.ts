import { X509Certificate } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticAuthority, SyntheticAuthorityError } from "./synthetic-authority.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function closeServer(server: https.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestStatus(options: https.RequestOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createSyntheticAuthority", () => {
  it("emits a self-signed CA certificate that Node parses and verifies", () => {
    const authority = createSyntheticAuthority({ commonName: "Fixture Test CA" });
    const ca = new X509Certificate(authority.certificatePem);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe("CN=Fixture Test CA");
    expect(ca.issuer).toBe(ca.subject);
    expect(ca.verify(ca.publicKey)).toBe(true);
  });

  it("issues leaves chained to the CA with the requested DNS and IP names", () => {
    const authority = createSyntheticAuthority();
    const ca = new X509Certificate(authority.certificatePem);
    const leaf = new X509Certificate(
      authority.issue({
        commonName: "leaf",
        dnsNames: ["localhost", "fixture-a.test"],
        ipAddresses: ["127.0.0.1", "::1"],
      }).certificatePem,
    );
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkHost("localhost")).toBe("localhost");
    expect(leaf.checkHost("fixture-a.test")).toBe("fixture-a.test");
    expect(leaf.checkHost("other.test")).toBeUndefined();
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leaf.checkIP("::1")).toBe("::1");
    expect(leaf.checkIP("10.0.0.1")).toBeUndefined();
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
  });

  it("honours explicit validity windows and self-signing", () => {
    const authority = createSyntheticAuthority();
    const ca = new X509Certificate(authority.certificatePem);
    const expired = new X509Certificate(
      authority.issue({
        commonName: "expired",
        notBefore: new Date(Date.UTC(2024, 0, 1)),
        notAfter: new Date(Date.UTC(2024, 0, 2)),
      }).certificatePem,
    );
    expect(expired.validFrom).toBe("Jan  1 00:00:00 2024 GMT");
    expect(expired.validTo).toBe("Jan  2 00:00:00 2024 GMT");
    expect(expired.checkIssued(ca)).toBe(true);

    const selfSigned = new X509Certificate(
      authority.issue({ commonName: "alone", selfSigned: true }).certificatePem,
    );
    expect(selfSigned.issuer).toBe("CN=alone");
    expect(selfSigned.checkIssued(ca)).toBe(false);
    expect(selfSigned.verify(selfSigned.publicKey)).toBe(true);
  });

  it("rejects names that are not IP literals in ipAddresses", () => {
    const authority = createSyntheticAuthority();
    expect(() => authority.issue({ commonName: "bad", ipAddresses: ["localhost"] })).toThrow(
      SyntheticAuthorityError,
    );
  });

  it("completes a real TLS handshake when the client trusts the synthetic CA", async () => {
    const authority = createSyntheticAuthority();
    const leaf = authority.issue({ commonName: "leaf", ipAddresses: ["127.0.0.1"] });
    const server = https.createServer(
      { key: leaf.privateKeyPem, cert: leaf.certificatePem },
      (_req, res) => res.writeHead(204).end(),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => closeServer(server));
    const { port } = server.address() as AddressInfo;
    await expect(
      requestStatus({ host: "127.0.0.1", port, path: "/", ca: authority.certificatePem }),
    ).resolves.toBe(204);
    await expect(requestStatus({ host: "127.0.0.1", port, path: "/" })).rejects.toMatchObject({
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
  });
});
