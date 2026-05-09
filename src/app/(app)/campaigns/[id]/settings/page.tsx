import { getCurrentUser } from "@/lib/auth";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import {
  type CampaignProviderConfig,
  type ProviderDefinition,
  anthropicFallbackConfig,
  listProviders,
} from "@/lib/providers";
import { CampaignSettings } from "@/lib/types/campaign-settings";
import { notFound, redirect } from "next/navigation";
import { serializeProviderConfigToken } from "./merge";
import SettingsUI from "./settings-ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Campaign settings — provider + tier_models selection.
 *
 * Loads the campaign server-side (auth-gated, must own it), parses its
 * current settings via `CampaignSettings`, and hands both the provider
 * registry snapshot and the current config to the client form. The
 * client renders dropdowns; the Server Action writes back.
 */
export default async function CampaignSettingsPage({ params }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const firestore = getFirebaseFirestore();

  const snap = await firestore.collection(COL.campaigns).doc(id).get();
  if (!snap.exists) notFound();
  const cd = snap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) notFound();

  const settingsRaw = cd.settings ?? {};
  const parsed = CampaignSettings.safeParse(settingsRaw);
  const current: CampaignProviderConfig =
    parsed.success && parsed.data.provider && parsed.data.tier_models
      ? { provider: parsed.data.provider, tier_models: parsed.data.tier_models }
      : anthropicFallbackConfig();

  // `listProviders` returns the full registry snapshot. The client
  // renders all four provider slots (disabled entries for unavailable
  // ones, with unavailableReason as hover-title) so users see what's
  // coming without us inventing a separate "roadmap" surface.
  const providers: ProviderDefinition[] = listProviders();

  // Concurrency token: serialize the current provider+tier_models so
  // the Server Action can detect "another tab saved while you were
  // editing this one." Scoped to just these fields — unrelated
  // background writes (e.g. memory writer landing at M4) won't
  // spuriously invalidate this form.
  const configToken = serializeProviderConfigToken(settingsRaw);

  const name = typeof cd.name === "string" ? cd.name : "";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        <p className="text-muted-foreground text-sm">
          Provider + model selection for this campaign. Changes take effect on the next turn;
          existing turns keep the voice they were written in.
        </p>
      </header>

      <SettingsUI
        campaignId={snap.id}
        providers={providers}
        current={current}
        configToken={configToken}
      />
    </div>
  );
}
