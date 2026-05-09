/**
 * One-shot backfill: ensure every existing campaign has `provider` +
 * `tier_models` in `settings` (M1.5 addition).
 *
 * Historical campaigns were created before the provider/tier_models
 * fields existed; they'd otherwise fall back to env defaults through
 * `anthropicFallbackConfig()` at every turn, which works but obscures
 * the source of truth. This script writes the Anthropic defaults
 * directly onto the doc so the settings blob is self-describing.
 *
 * Idempotent: campaigns that already carry `provider` + `tier_models`
 * are left alone. Safe to run N times.
 *
 * Usage (with .env.local loaded):
 *   pnpm tsx scripts/migrate-campaign-providers.ts
 *   pnpm tsx scripts/migrate-campaign-providers.ts --dry-run
 */
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { anthropicFallbackConfig } from "@/lib/providers";
import { CampaignSettings, hasProviderConfig } from "@/lib/types/campaign-settings";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const firestore = getFirebaseFirestore();

  const snap = await firestore.collection(COL.campaigns).get();
  console.log(`Scanning ${snap.size} campaign doc(s)…`);

  let migrated = 0;
  let skipped = 0;
  const fallback = anthropicFallbackConfig();

  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    const settings = data.settings ?? {};
    const parsed = CampaignSettings.safeParse(settings);
    const name = typeof data.name === "string" ? data.name : "(unnamed)";
    if (!parsed.success) {
      console.warn(
        `  ! ${doc.id} (${name}): settings parse failed — skipping. Issues:`,
        parsed.error.issues.map((i) => i.message),
      );
      skipped += 1;
      continue;
    }
    if (hasProviderConfig(parsed.data)) {
      skipped += 1;
      continue;
    }
    const next = {
      ...(parsed.data as Record<string, unknown>),
      provider: fallback.provider,
      tier_models: fallback.tier_models,
    };
    console.log(`  → ${doc.id} (${name}): adding provider=${fallback.provider}`);
    if (!dryRun) {
      await doc.ref.set({ settings: next }, { merge: true });
    }
    migrated += 1;
  }

  console.log(
    `\nDone. Migrated: ${migrated}. Skipped (already-populated or parse-fail): ${skipped}.`,
  );
  if (dryRun) console.log("(dry-run mode — no writes performed)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
