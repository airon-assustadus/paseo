const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 for a JPEG frame on native, where neither `btoa` nor `Buffer` is guaranteed. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const triple = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    parts.push(
      ALPHABET[(triple >> 18) & 63] +
        ALPHABET[(triple >> 12) & 63] +
        ALPHABET[(triple >> 6) & 63] +
        ALPHABET[triple & 63],
    );
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const value = bytes[index] << 16;
    parts.push(`${ALPHABET[(value >> 18) & 63]}${ALPHABET[(value >> 12) & 63]}==`);
  } else if (remaining === 2) {
    const value = (bytes[index] << 16) | (bytes[index + 1] << 8);
    parts.push(
      `${ALPHABET[(value >> 18) & 63]}${ALPHABET[(value >> 12) & 63]}${ALPHABET[(value >> 6) & 63]}=`,
    );
  }
  return parts.join("");
}
