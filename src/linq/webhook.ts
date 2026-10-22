import crypto from "node:crypto";

import { currentNetwork, parseNetwork, type Network } from "../network";

/**
 * Verification for Linq's offramp webhooks.
 *
 * Linq signs the RAW request body with HMAC-SHA256 under a webhook secret that
 * is separate from the API key, and sends it as `X-Linq-Signature:
 * sha256=<hex>`. The signature is over the exact bytes they sent, so anything
 * that parses and re-serialises the body first — `express.json()`, which wraith
 * applies globally — destroys the ability to check it. The route must be
 * mounted with `express.raw()` ahead of that middleware.
 *
 * This matters more than the usual "verify your webhooks" advice: the endpoint
 * is public, and the events it carries say money moved. Anyone who can POST to
 * it could otherwise mark an order settled.
 */

/** Header Linq signs with. */
export const SIGNATURE_HEADER = "x-linq-signature";

export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
  );
}

/**
 * Whether `signature` authenticates `rawBody` under `secret`.
 *
 * Compared with `timingSafeEqual`, which requires equal lengths — a mismatched
 * length would otherwise throw rather than return false, turning a malformed
 * signature into a 500 and telling the sender their guess was the wrong shape.
 */
export function verifySignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = computeSignature(rawBody, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The shape Linq posts. Amounts are numbers on the wire. */
export interface LinqWebhookEvent {
  event: "order.processing" | "order.completed" | "order.failed";
  orderId: string;
  /**
   * Optional network discriminator. Linq does not currently send one, so it is
   * absent on real deliveries; when it is absent the deployment's configured
   * network is used instead.
   */
  network?: string;
  amountStableCoin?: number;
  amountNGN?: number;
  amountFormatted?: string;
  currency?: string;
  chain?: string;
  txHash?: string;
  status?: string;
  timestamp?: string;
}

/**
 * Resolve the network an event applies to.
 *
 * An explicit, valid `network` wins. When the event omits it, the deployment's
 * configured network is used. An event that names something else is rejected
 * rather than silently falling back: looking up the wrong network would either
 * miss the order or, worse, apply the event to a same-id order on another chain.
 */
export function resolveEventNetwork(
  event: Pick<LinqWebhookEvent, "network">,
): Network | null {
  if (event.network === undefined) return currentNetwork();
  return parseNetwork(event.network);
}

/**
 * Parse a verified body into an event, or null when it is not one.
 *
 * Signature verification proves the sender, not the shape — a valid signature
 * over malformed JSON is still malformed.
 */
export function parseEvent(rawBody: Buffer | string): LinqWebhookEvent | null {
  try {
    const parsed = JSON.parse(rawBody.toString("utf8" as BufferEncoding));
    if (!parsed || typeof parsed !== "object") return null;
    const { event, orderId } = parsed as Record<string, unknown>;
    if (typeof event !== "string" || typeof orderId !== "string") return null;
    if (
      event !== "order.processing" &&
      event !== "order.completed" &&
      event !== "order.failed"
    ) {
      return null;
    }
    return parsed as LinqWebhookEvent;
  } catch {
    return null;
  }
}
