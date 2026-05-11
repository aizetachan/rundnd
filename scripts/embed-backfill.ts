/**
 * Embed backfill — populates `embedding` on `semanticMemories` rows
 * that currently have `null`. Companion to M4 sub 1/2: sub 1 wired
 * write-time embeddings, sub 2 wired the read path, but every doc
 * created before M4 sub 1 still has `embedding: null`. This script
 * walks those rows and embeds their `content` field.
 *
 * Idempotent — re-running on the same data is a no-op (a row that
 * already has a non-null embedding is skipped). Sequential by design;
 * Gemini's free-tier RPM limit doesn't tolerate concurrent floods.
 *
 * Usage:
 *   pnpm embed:backfill --dry-run
 *   pnpm embed:backfill --confirm
 *   pnpm embed:backfill --confirm --limit 50
 *   pnpm embed:backfill --confirm --campaign <campaignId>
 */
import { embedText, isEmbedderConfigured } from "@/lib/embeddings";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";

interface Args {
  dryRun: boolean;
  confirm: boolean;
  limit: number | null;
  campaign: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { dryRun: false, confirm: false, limit: null, campaign: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--limit") {
      const next = argv[i + 1];
      if (next) {
        args.limit = Number.parseInt(next, 10);
        i += 1;
      }
    } else if (a === "--campaign") {
      const next = argv[i + 1];
      if (next) {
        args.campaign = next;
        i += 1;
      }
    }
  }
  return args;
}

interface Target {
  campaignId: string;
  docId: string;
  content: string;
}

async function findTargets(
  firestore: ReturnType<typeof getFirebaseFirestore>,
  campaignFilter: string | null,
): Promise<Target[]> {
  const targets: Target[] = [];
  if (campaignFilter) {
    const snap = await firestore
      .collection(COL.campaigns)
      .doc(campaignFilter)
      .collection(CAMPAIGN_SUB.semanticMemories)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.embedding == null && typeof d.content === "string" && d.content.length > 0) {
        targets.push({ campaignId: campaignFilter, docId: doc.id, content: d.content });
      }
    }
    return targets;
  }
  // No campaign filter — collection group walk across every campaign.
  // The collectionGroup query is unfiltered (no `where(embedding, ==, null)`)
  // to avoid the single-field index requirement; we filter in code. This
  // works fine at AIDM scale; if memory grows past ~100k docs, a
  // targeted index would be the optimization.
  const snap = await firestore.collectionGroup(CAMPAIGN_SUB.semanticMemories).get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.embedding != null) continue;
    if (typeof d.content !== "string" || d.content.length === 0) continue;
    // doc.ref.parent.parent is the campaign doc.
    const campaignId = doc.ref.parent.parent?.id;
    if (!campaignId) continue;
    targets.push({ campaignId, docId: doc.id, content: d.content });
  }
  return targets;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.dryRun && !args.confirm) {
    console.error(
      "Refusing to run without --confirm. Pass --dry-run to preview, or --confirm to actually embed.",
    );
    process.exit(1);
  }
  if (!isEmbedderConfigured()) {
    console.error(
      "AIDM_EMBEDDING_PROVIDER is 'none'. Set it (default 'gemini') and ensure GOOGLE_API_KEY is exported before running.",
    );
    process.exit(1);
  }

  const firestore = getFirebaseFirestore();
  console.log("→ Scanning for embedding-null semantic memories…");
  const targets = await findTargets(firestore, args.campaign);
  const limited = args.limit ? targets.slice(0, args.limit) : targets;
  console.log(
    `→ Found ${targets.length} candidate row(s); processing ${limited.length}${
      args.limit ? ` (--limit ${args.limit})` : ""
    }.`,
  );
  if (limited.length === 0) {
    console.log("✓ Nothing to do.");
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < limited.length; i++) {
    const t = limited[i];
    if (!t) continue;
    const tag = `[${i + 1}/${limited.length}] ${t.campaignId}/${t.docId}`;
    if (args.dryRun) {
      console.log(`  ${tag} would embed ${t.content.length} chars`);
      continue;
    }
    try {
      const result = await embedText(t.content);
      await firestore
        .collection(COL.campaigns)
        .doc(t.campaignId)
        .collection(CAMPAIGN_SUB.semanticMemories)
        .doc(t.docId)
        .set({ embedding: result.vector }, { merge: true });
      succeeded += 1;
      console.log(`  ${tag} ✓ embedded (${result.dimension}-dim)`);
    } catch (err) {
      failed += 1;
      console.warn(`  ${tag} ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  console.log(
    `✓ Backfill complete. succeeded=${succeeded} failed=${failed}${
      args.dryRun ? " (dry-run; no writes)" : ""
    }`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill script failed:", err);
  process.exit(1);
});
