import { z } from "zod";

/**
 * Billing entities (M9). Credits-based pricing per ROADMAP §23 M9.
 *
 * `Credits` is the user-facing currency; 1 credit = $0.01 USD (the
 * pricing page surfaces credits, not dollars, so the meter feels
 * native to the product). Cost ledger entries record the actual
 * USD spend per turn; reconciliation against credits happens at
 * webhook time when Stripe confirms purchases.
 *
 * Live Stripe integration requires:
 *   - STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET in env.
 *   - Stripe Products + Prices set up in the Stripe Dashboard.
 *   - Webhook endpoint at /api/webhooks/stripe (lands when keys are
 *     configured).
 * Today's scaffold ships the types + the credit-balance accessor so
 * downstream code can render the spending UI without live billing.
 */

export const CreditTransaction = z.object({
  id: z.string(),
  /** Positive: top-up. Negative: spend. */
  delta: z.number(),
  /** USD value of this delta (for audit + reconciliation). */
  usd: z.number(),
  reason: z.enum(["starter_grant", "topup", "subscription", "refund", "turn_spend", "adjustment"]),
  /** Stripe payment intent or charge id; null for internal entries. */
  stripeRef: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
});
export type CreditTransaction = z.infer<typeof CreditTransaction>;

export const UserBilling = z.object({
  userId: z.string(),
  /** Current credit balance — recomputed from the sum of
   *  CreditTransaction.delta entries. */
  balance: z.number().int(),
  /** Optional subscription tier — null when the user is metered-only. */
  subscriptionTier: z.enum(["starter", "creator", "studio"]).nullable().optional(),
  /** Daily spend cap in USD (user-configurable). Null = no cap. */
  dailyCostCapUsd: z.number().nullable().optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});
export type UserBilling = z.infer<typeof UserBilling>;

/** USD → credits conversion. 1 credit = $0.01 USD. */
export function usdToCredits(usd: number): number {
  return Math.round(usd * 100);
}

/** Credits → USD. */
export function creditsToUsd(credits: number): number {
  return credits / 100;
}

/**
 * Pricing tiers surfaced on the pricing page. M9 sub 1 ships placeholders;
 * Stripe Product/Price IDs go here once configured.
 */
export interface PricingTier {
  id: "starter" | "creator" | "studio";
  displayName: string;
  monthlyUsd: number;
  monthlyCredits: number;
  description: string;
  /** Stripe Price ID — populated post-Stripe-config. Empty string today. */
  stripePriceId: string;
}

export const PRICING_TIERS: readonly PricingTier[] = [
  {
    id: "starter",
    displayName: "Starter",
    monthlyUsd: 10,
    monthlyCredits: 1000,
    description: "Light play — ~150 Sonnet turns or ~20 Opus turns per month.",
    stripePriceId: "",
  },
  {
    id: "creator",
    displayName: "Creator",
    monthlyUsd: 30,
    monthlyCredits: 3500,
    description: "Active campaigns — ~500 Sonnet turns or ~60 Opus turns.",
    stripePriceId: "",
  },
  {
    id: "studio",
    displayName: "Studio",
    monthlyUsd: 75,
    monthlyCredits: 10000,
    description: "Heavy use + image generation budget.",
    stripePriceId: "",
  },
];
