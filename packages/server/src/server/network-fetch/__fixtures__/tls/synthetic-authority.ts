import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import {
  bitString,
  boolean,
  explicit,
  implicitPrimitive,
  objectIdentifier,
  octetString,
  sequence,
  set,
  toPem,
  unsignedInteger,
  utcTime,
  utf8String,
} from "./der.js";

/**
 * Per-run synthetic certificate authority for the fixture's HTTPS listeners. Keys live only in
 * memory and are discarded with the fixture; nothing is written to disk or to the repository.
 *
 * P-256 keys are generated in milliseconds, and `ecdsa-with-SHA256` signatures come out of
 * `crypto.sign` already DER encoded, so the builder only assembles the TBSCertificate.
 */

const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_COMMON_NAME = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const SAN_DNS_NAME = 2;
const SAN_IP_ADDRESS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SyntheticLeafSpec {
  commonName: string;
  dnsNames?: readonly string[];
  ipAddresses?: readonly string[];
  notBefore?: Date;
  notAfter?: Date;
  /** Sign with the leaf's own key instead of the authority's; the chain then ends at the leaf. */
  selfSigned?: boolean;
}

export interface SyntheticLeaf {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

export interface SyntheticAuthority {
  readonly commonName: string;
  readonly certificatePem: string;
  issue(spec: SyntheticLeafSpec): SyntheticLeaf;
}

export class SyntheticAuthorityError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SyntheticAuthorityError";
  }
}

interface CertificateInput {
  subjectCommonName: string;
  issuerCommonName: string;
  signingKey: KeyObject;
  publicKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  isAuthority: boolean;
  dnsNames: readonly string[];
  ipAddresses: readonly string[];
}

export function createSyntheticAuthority(
  options: { commonName?: string } = {},
): SyntheticAuthority {
  const commonName = options.commonName ?? "Paseo Web Proxy Fixture CA";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = Date.now();
  const certificatePem = toPem(
    "CERTIFICATE",
    buildCertificate({
      subjectCommonName: commonName,
      issuerCommonName: commonName,
      signingKey: privateKey,
      publicKey,
      notBefore: new Date(now - DAY_MS),
      notAfter: new Date(now + 30 * DAY_MS),
      isAuthority: true,
      dnsNames: [],
      ipAddresses: [],
    }),
  );
  return {
    commonName,
    certificatePem,
    issue(spec) {
      const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const der = buildCertificate({
        subjectCommonName: spec.commonName,
        issuerCommonName: spec.selfSigned ? spec.commonName : commonName,
        signingKey: spec.selfSigned ? leaf.privateKey : privateKey,
        publicKey: leaf.publicKey,
        notBefore: spec.notBefore ?? new Date(now - DAY_MS),
        notAfter: spec.notAfter ?? new Date(now + 7 * DAY_MS),
        isAuthority: false,
        dnsNames: spec.dnsNames ?? [],
        ipAddresses: spec.ipAddresses ?? [],
      });
      return {
        certificatePem: toPem("CERTIFICATE", der),
        privateKeyPem: leaf.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      };
    },
  };
}

function buildCertificate(input: CertificateInput): Buffer {
  const signatureAlgorithm = sequence(objectIdentifier(OID_ECDSA_WITH_SHA256));
  const tbs = sequence(
    explicit(0, unsignedInteger(2)),
    unsignedInteger(randomSerial()),
    signatureAlgorithm,
    name(input.issuerCommonName),
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    name(input.subjectCommonName),
    input.publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(...extensions(input))),
  );
  const signature = sign("sha256", tbs, { key: input.signingKey, dsaEncoding: "der" });
  return sequence(tbs, signatureAlgorithm, bitString(signature));
}

function randomSerial(): Buffer {
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  return serial;
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(objectIdentifier(OID_COMMON_NAME), utf8String(commonName))));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value));
}

function extensions(input: CertificateInput): Buffer[] {
  if (input.isAuthority) {
    return [
      extension(OID_BASIC_CONSTRAINTS, true, sequence(boolean(true))),
      // keyCertSign (bit 5) and cRLSign (bit 6): one trailing unused bit.
      extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x06]), 1)),
    ];
  }
  const list = [
    extension(OID_BASIC_CONSTRAINTS, true, sequence()),
    // digitalSignature (bit 0): seven trailing unused bits.
    extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
    extension(OID_EXT_KEY_USAGE, false, sequence(objectIdentifier(OID_SERVER_AUTH))),
  ];
  const altNames = [
    ...input.dnsNames.map((dns) => implicitPrimitive(SAN_DNS_NAME, Buffer.from(dns, "ascii"))),
    ...input.ipAddresses.map((ip) => implicitPrimitive(SAN_IP_ADDRESS, ipToBytes(ip))),
  ];
  if (altNames.length > 0) {
    list.push(extension(OID_SUBJECT_ALT_NAME, false, sequence(...altNames)));
  }
  return list;
}

function ipToBytes(address: string): Buffer {
  if (isIPv4(address)) {
    return Buffer.from(address.split(".").map((part) => Number.parseInt(part, 10)));
  }
  if (!isIPv6(address)) {
    throw new SyntheticAuthorityError("ipAddresses", `Not an IP literal: ${address}`);
  }
  const [head, tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => "0"), ...tailGroups];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}
