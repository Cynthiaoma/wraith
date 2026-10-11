import { Router, type Request, type Response } from "express";

/**
 * What Veil charges, answered by the server so the number is never in an APK.
 *
 * The fee itself is collected on-chain, in the same transaction as the thing
 * the user is doing — Linq confirmed on 2026-09-30 that they have no developer
 * fee structure, and the money never passes through wraith in either
 * direction, so there is nothing here to deduct from. What this endpoint does
 * is tell the client what to charge and where to send it.
 *
 * That split is the point. An amount compiled into the app can only be changed
 * by building, shipping and waiting for every user to update; a waiver, a
 * promotion or a correction then costs days. Here it is an environment
 * variable.
 */

/** A classic `G…` account. Contracts cannot be paid by a classic payment op. */
function isClassicAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value);
}

export interface PlatformFee {
  /** Whole units of the fee asset, as a decimal string. */
  amount: string;
  assetCode: string;
  /** Null for native XLM, which has no issuer. */
  assetIssuer: string | null;
  destination: string;
}

function validAmount(value: string | undefined): string | null {
  const amount = value?.trim();
  if (!amount) return null;
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) return null;
  return amount;
}

/**
 * The fee for each asset we charge on, keyed by asset code.
 *
 * Per asset, and always **in the asset being sent**. Charging 0.1 USDC on an
 * XLM transfer would need a second balance the sender may not have and a
 * trustline they may not hold — and because the fee rides in the same
 * transaction as the payment, a fee they cannot cover would take their actual
 * payment down with it. A fee denominated in what they are already sending is
 * payable by definition: if they can send it, they can pay it.
 *
 * Every malformed entry is dropped rather than guessed at. A fee is a payment
 * the user did not ask for; if we cannot say exactly what it is and where it
 * goes, we do not charge it.
 */
export function configuredFees(): Record<string, PlatformFee> {
  const destination = process.env.VEIL_FEE_DESTINATION?.trim();
  if (!destination || !isClassicAddress(destination)) return {};

  const fees: Record<string, PlatformFee> = {};

  // USDC, or whichever issued asset VEIL_FEE_ASSET_CODE names.
  const issuedCode = process.env.VEIL_FEE_ASSET_CODE?.trim() || "USDC";
  const issuedAmount = validAmount(process.env.VEIL_FEE_AMOUNT);
  const issuer = process.env.VEIL_FEE_ASSET_ISSUER?.trim();
  if (issuedAmount && issuer && isClassicAddress(issuer)) {
    fees[issuedCode] = {
      amount: issuedAmount,
      assetCode: issuedCode,
      assetIssuer: issuer,
      destination,
    };
  }

  // Native XLM, which has no issuer and needs no trustline.
  const xlmAmount = validAmount(process.env.VEIL_FEE_AMOUNT_XLM);
  if (xlmAmount) {
    fees["XLM"] = { amount: xlmAmount, assetCode: "XLM", assetIssuer: null, destination };
  }

  return fees;
}

export function feesRouter(): Router {
  const router = Router();

  /**
   * Unauthenticated and uncached: it carries no personal data, and a stale
   * fee is one a user was shown but did not agree to.
   */
  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const fees = configuredFees();
    const assets = Object.keys(fees);
    // `enabled: false` rather than a 404, so a client can tell "no fee today"
    // from "this backend is too old to know about fees" and does not read a
    // deliberate waiver as a failure.
    res.json(assets.length > 0 ? { enabled: true, fees } : { enabled: false, fees: {} });
  });

  return router;
}
