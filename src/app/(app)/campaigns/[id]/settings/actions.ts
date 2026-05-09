"use server";

import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { CampaignProviderValidationError } from "@/lib/providers";
import { revalidatePath } from "next/cache";
import { mergeSettingsWithProviderConfig, serializeProviderConfigToken } from "./merge";

/**
 * Save a campaign's provider + tier_models choice.
 *
 * Auth: current user must own the campaign. Validation: provider must
 * be `available: true` in the registry, and every tier_model must be
 * in that provider's selectable list (unless the provider has
 * `allowFreeFormModels`). On failure, returns a user-facing message
 * rather than throwing — the form re-renders with the error.
 *
 * Merge semantics: reads the existing settings blob, overwrites just
 * `provider` and `tier_models`, leaves every other field intact
 * (active_dna, world_state, overrides, voice_patterns, etc.). Next
 * turn's `resolveModelContext` picks up the new values immediately;
 * no campaign-state churn.
 */

export type SaveModelContextResult = { ok: true } | { ok: false; code: string; message: string };

export async function saveCampaignModelContext(
  campaignId: string,
  input: unknown,
  /**
   * Opaque token produced at page load via `serializeProviderConfigToken`.
   * Undefined for legacy callers (pre-FU-1) — skip the stale check in
   * that case so we don't break existing consumers during deploy.
   * New form submits always pass it.
   */
  configToken?: string,
): Promise<SaveModelContextResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, code: "unauthenticated", message: "Please sign in again." };
  }

  const firestore = getFirebaseFirestore();
  const ref = firestore.collection(COL.campaigns).doc(campaignId);

  // Fetch existing campaign + settings. Must belong to this user.
  const snap = await ref.get();
  if (!snap.exists) {
    return {
      ok: false,
      code: "campaign_not_found",
      message: "Campaign not found or not yours.",
    };
  }
  const cd = snap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) {
    return {
      ok: false,
      code: "campaign_not_found",
      message: "Campaign not found or not yours.",
    };
  }
  const currentSettings = cd.settings ?? {};

  // Optimistic concurrency check (FU-1). Token was computed at page
  // load; re-compute from the current doc. If they don't match,
  // another tab saved between the user's load and submit — surface a
  // stale-save error with a reload prompt rather than silently
  // overwriting their sibling tab's changes.
  if (configToken !== undefined) {
    const currentToken = serializeProviderConfigToken(currentSettings);
    if (currentToken !== configToken) {
      return {
        ok: false,
        code: "stale_config",
        message:
          "This campaign's settings changed in another tab or session. Reload the page to see the latest and try again.",
      };
    }
  }

  // Merge + validate via the pure helper. Any shape or registry
  // problem throws a CampaignProviderValidationError which we surface
  // to the form.
  let nextSettings: Record<string, unknown>;
  try {
    nextSettings = mergeSettingsWithProviderConfig(currentSettings, input);
  } catch (err) {
    if (err instanceof CampaignProviderValidationError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return {
      ok: false,
      code: "validation_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  await ref.set({ settings: nextSettings }, { merge: true });

  // Invalidate the play and settings pages so SSR picks up the new
  // provider on the next navigation. The write has already committed
  // above — if revalidate throws here, we still return ok: true so
  // the user isn't shown an error for a successful save. Stale
  // caches recover on the next real navigation anyway.
  try {
    revalidatePath(`/campaigns/${campaignId}/play`);
    revalidatePath(`/campaigns/${campaignId}/settings`);
  } catch (err) {
    console.warn("saveCampaignModelContext: revalidatePath failed (write already committed)", {
      campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { ok: true };
}
