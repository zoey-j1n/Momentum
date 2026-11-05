// In:  rawBody (string), headers, secret, nowSeconds
// Out: true if the request is really from Slack, false otherwise
// Fails (return false) when:
//   - the signature header is missing
//   - the timestamp header is missing, or is not a number
//   - the timestamp is more than 300 seconds away from now
//   - the recomputed signature does not match

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackRequest(rawBody: string, headers: Headers, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const signature = headers.get("x-slack-signature");
  const timestampHeader = headers.get("x-slack-request-timestamp");
  if (!signature || !timestampHeader) return false;

  // Replay protection: the number is only for the range check. Number() (not parseFloat) so "123abc" is rejected.
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300) {
    return false;
  }

  // Recompute what Slack signed, over the header's exact text (not the parsed number) and the raw body.
  const basestring = `v0:${timestampHeader}:${rawBody}`;
  const computedSignature = "v0=" + createHmac("sha256", secret).update(basestring).digest("hex");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(computedSignature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature))) {
    return false;
  }
  return true;
}
