import { createHash } from "crypto";

export function sha1OfBuffer(buf: ArrayBuffer | Uint8Array): string {
  const h = createHash("sha1");
  h.update(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  return h.digest("hex");
}

export function sha1OfString(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}
