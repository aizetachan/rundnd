/**
 * Rule library indexer — walks `rule_library/**\/*.yaml`, validates each
 * file against the YAML schema, then upserts docs into the
 * `ruleLibraryChunks` Firestore collection by (category, axis, valueKey).
 * Content changes bump the version counter; identical content is a no-op.
 *
 * Usage (with .env.local loaded so FIREBASE_PROJECT_ID +
 * GOOGLE_APPLICATION_CREDENTIALS resolve):
 *   pnpm tsx scripts/rules-index.ts
 *   pnpm tsx scripts/rules-index.ts --dry-run
 *
 * Output: per-file summary + final "N indexed, M updated, K skipped".
 * Malformed YAML / Zod-violating entries fail the whole run — partial
 * index states hide content-quality regressions.
 *
 * Doc id strategy: stable composite of `<category>__<axis>__<valueKey>`
 * sanitized through the same `safeNameId` rules used elsewhere. This
 * makes upserts idempotent without requiring a query-then-insert
 * pattern (which would race under parallel runs anyway).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL, safeNameId } from "@/lib/firestore";
import { RuleLibraryYamlFile } from "@/lib/types/rule-library";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import jsYaml from "js-yaml";

const ROOT = join(process.cwd(), "rule_library");

function walk(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      out.push(p);
    }
  }
  return out;
}

interface IndexResult {
  inserted: number;
  updated: number;
  skipped: number; // identical content — no DB write
}

/** Composite doc id from the rule-library lookup tuple. Null axis or
 * valueKey collapse to the literal string "null" so downstream `where`
 * queries with `axis == null` match what was written. */
function chunkDocId(
  category: string,
  axis: string | null,
  valueKey: string | null,
): string {
  const parts = [category, axis ?? "null", valueKey ?? "null"];
  return safeNameId(parts.join("__"));
}

async function indexFile(firestore: Firestore, path: string): Promise<IndexResult> {
  const raw = readFileSync(path, "utf8");
  const parsed = jsYaml.load(raw);
  const file = RuleLibraryYamlFile.parse(parsed);

  const result: IndexResult = { inserted: 0, updated: 0, skipped: 0 };

  for (const entry of file.entries) {
    const id = chunkDocId(file.category, file.axis, entry.value_key);
    const ref = firestore.collection(COL.ruleLibraryChunks).doc(id);

    // Read first to detect identical-content (skip), bump version on
    // change, or seed at version 1 on first insert. The transaction
    // protects against parallel writers landing simultaneously on the
    // same key (rare in practice — the indexer is run manually).
    const status = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, {
          librarySlug: file.library_slug,
          category: file.category,
          axis: file.axis,
          valueKey: entry.value_key,
          tags: entry.tags,
          retrieveConditions: entry.retrieve_conditions,
          content: entry.content,
          version: 1,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return "inserted" as const;
      }
      const existing = snap.data() ?? {};
      if (existing.content === entry.content) return "skipped" as const;
      const currentVersion = typeof existing.version === "number" ? existing.version : 1;
      tx.set(
        ref,
        {
          librarySlug: file.library_slug,
          tags: entry.tags,
          retrieveConditions: entry.retrieve_conditions,
          content: entry.content,
          version: currentVersion + 1,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return "updated" as const;
    });

    if (status === "inserted") result.inserted += 1;
    else if (status === "updated") result.updated += 1;
    else result.skipped += 1;
  }

  return result;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const files = walk(ROOT);
  if (files.length === 0) {
    console.warn(`No YAML files found under ${ROOT}. Nothing to index.`);
    return;
  }

  if (dryRun) {
    // Validate everything without writing.
    for (const path of files) {
      const raw = readFileSync(path, "utf8");
      const parsed = jsYaml.load(raw);
      RuleLibraryYamlFile.parse(parsed);
      console.log(`✓ parse: ${relative(process.cwd(), path)}`);
    }
    console.log(`\nDry run: ${files.length} files validated. No DB writes.`);
    return;
  }

  const firestore = getFirebaseFirestore();
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const path of files) {
    const rel = relative(process.cwd(), path);
    try {
      const res = await indexFile(firestore, path);
      totalInserted += res.inserted;
      totalUpdated += res.updated;
      totalSkipped += res.skipped;
      console.log(
        `  ${rel}: +${res.inserted} inserted, ~${res.updated} updated, =${res.skipped} unchanged`,
      );
    } catch (err) {
      console.error(`  ${rel}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  console.log(
    `\n${totalInserted} inserted · ${totalUpdated} updated · ${totalSkipped} unchanged · ${files.length} files`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
