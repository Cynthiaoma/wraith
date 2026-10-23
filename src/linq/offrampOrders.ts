/**
 * Reconciliation for offramp orders.
 *
 * The webhook used to write this update inline. The periodic sweep needs the
 * same write, and two implementations of "apply Linq's status to our row" is
 * how a webhook and a poll start disagreeing. Both now go through here.
 */

import { prisma } from "../db";
import { resolveEventNetwork } from "./webhook";

export interface OfframpReconciliationEvent {
  orderId: string;
  network?: string;
  status?: string;
  event: string;
  amountStableCoin?: number;
  amountNGN?: number;
  txHash?: string;
}

/**
 * Apply an event or status-poll result to an offramp order.
 *
 * Returns false when the network is invalid or the order is not ours. Nothing
 * here creates a row: an event for an order we never placed is not ours to act
 * on.
 */
export async function reconcileOfframpOrder(
  event: OfframpReconciliationEvent,
): Promise<boolean> {
  const network = resolveEventNetwork(event);
  if (!network) return false;

  const existing = await prisma.offrampOrder.findUnique({
    where: { network_orderId: { network, orderId: event.orderId } },
  });
  if (!existing) return false;

  await prisma.offrampOrder.update({
    where: { network_orderId: { network, orderId: event.orderId } },
    data: {
      status: event.status ?? event.event,
      ...(event.amountStableCoin != null
        ? { settledStableCoin: String(event.amountStableCoin) }
        : {}),
      ...(event.amountNGN != null ? { settledNGN: String(event.amountNGN) } : {}),
      ...(event.txHash ? { depositTxHash: event.txHash } : {}),
    },
  });
  return true;
}
