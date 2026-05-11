/**
 * Profile-generation eval harness. Runs the configured research
 * path(s) over ground-truth YAMLs and writes per-IP results +
 * aggregated scores to `evals/profile-generation/runs/<timestamp>/`.
 *
 * The §10.6 decision rule consumes the aggregated scores: if Path B
 * passes mechanical thresholds across the ground-truth set within
 * tolerance of Path A, Path A retires.
 *
 * Usage:
 *   pnpm evals:profile-generation                 # both paths, all IPs
 *   pnpm evals:profile-generation --path b        # Path B only
 *   pnpm evals:profile-generation --ip cowboy_bebop  # one IP
 *
 * Network: Path A hits AniList GraphQL + Fandom HTTP; Path B hits
 * the Anthropic API. Both require `.env.local` with the right keys.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProfileResearcherA } from "@/lib/agents/profile-researcher-a";
import { runProfileResearcherB } from "@/lib/agents/profile-researcher-b";
import type { AnimeResearchOutput, ResearchTelemetry } from "@/lib/research";
import { Profile } from "@/lib/types/profile";
import yaml from "js-yaml";
import { judgeVisualStyle, judgeVoiceCards } from "./judge";
import { type IpScore, scoreIp, summarizeScores } from "./score";

interface Args {
  path: "a" | "b" | "both";
  ipFilter: string | null;
  judge: boolean;
}

interface IpResult {
  ip_slug: string;
  path: "a" | "b";
  output: AnimeResearchOutput;
  telemetry: ResearchTelemetry;
  score: IpScore;
  judge_voice_cards?: number | null;
  judge_visual_style?: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { path: "both", ipFilter: null, judge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") {
      const next = argv[i + 1];
      if (next === "a" || next === "b" || next === "both") {
        args.path = next;
        i += 1;
      }
    } else if (a === "--ip") {
      const next = argv[i + 1];
      if (next) {
        args.ipFilter = next;
        i += 1;
      }
    } else if (a === "--judge") {
      args.judge = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: pnpm evals:profile-generation [--path a|b|both] [--ip <slug>] [--judge]\n" +
          "  --path   research path(s) to evaluate (default: both)\n" +
          "  --ip     scope to one ground-truth fixture by slug\n" +
          "  --judge  also run Gemini-as-judge soft axes (voice + visual)\n",
      );
      process.exit(0);
    }
  }
  return args;
}

function loadGroundTruth(rootDir: string): Map<string, Profile> {
  const goldenDir = join(rootDir, "evals", "golden", "profiles");
  const files = readdirSync(goldenDir).filter((f) => f.endsWith(".yaml"));
  const map = new Map<string, Profile>();
  for (const file of files) {
    const slug = file.replace(/\.yaml$/, "");
    const text = readFileSync(join(goldenDir, file), "utf-8");
    const raw = yaml.load(text);
    // Zod-validate so schema drift in a YAML surfaces here, not as a
    // garbage score downstream. The scorer's `?? 0` / `?? false`
    // defaults would silently mask missing fields otherwise.
    const parsed = Profile.safeParse(raw);
    if (!parsed.success) {
      console.error(
        `Ground-truth YAML failed validation: ${file}\n  ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")} — ${i.message}`)
          .join("\n  ")}`,
      );
      process.exit(1);
    }
    map.set(slug, parsed.data);
  }
  return map;
}

async function runPath(
  path: "a" | "b",
  query: string,
  selectedAnilistId: number | undefined,
): Promise<{ output: AnimeResearchOutput; telemetry: ResearchTelemetry }> {
  if (path === "a") {
    return runProfileResearcherA({ query, selectedAnilistId });
  }
  return runProfileResearcherB({ query, selectedAnilistId });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..");
  const groundTruths = loadGroundTruth(repoRoot);

  const targets = args.ipFilter
    ? new Map(
        [[args.ipFilter, groundTruths.get(args.ipFilter)]].filter((e) => e[1]) as [
          string,
          Profile,
        ][],
      )
    : groundTruths;

  if (targets.size === 0) {
    console.error(`No ground-truth fixture matched (filter=${args.ipFilter ?? "(none)"}).`);
    process.exit(1);
  }

  const pathsToRun: Array<"a" | "b"> =
    args.path === "both" ? ["a", "b"] : args.path === "a" ? ["a"] : ["b"];

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(here, "runs", timestamp);
  for (const p of pathsToRun) {
    mkdirSync(join(runDir, p), { recursive: true });
  }

  console.log(`→ Evaluating ${targets.size} IP(s) on path(s): ${pathsToRun.join(", ")}`);
  console.log(`→ Output dir: ${runDir}`);

  const results: IpResult[] = [];

  for (const [slug, groundTruth] of targets) {
    for (const path of pathsToRun) {
      const query = groundTruth.title;
      const selectedAnilistId = groundTruth.anilist_id;
      console.log(`  ${slug} [path ${path}] running…`);
      let outcome: { output: AnimeResearchOutput; telemetry: ResearchTelemetry };
      try {
        outcome = await runPath(path, query, selectedAnilistId);
      } catch (err) {
        console.error(
          `    ✗ ${slug} [path ${path}] failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const score = scoreIp(slug, outcome.output, groundTruth);
      let judgeVoice: number | null | undefined;
      let judgeVisual: number | null | undefined;
      if (args.judge) {
        const [v, vs] = await Promise.all([
          judgeVoiceCards(
            outcome.output.ip_mechanics.voice_cards,
            groundTruth.ip_mechanics.voice_cards,
          ),
          judgeVisualStyle(
            outcome.output.ip_mechanics.visual_style,
            groundTruth.ip_mechanics.visual_style,
          ),
        ]);
        judgeVoice = v.score;
        judgeVisual = vs.score;
      }
      const result: IpResult = {
        ip_slug: slug,
        path,
        output: outcome.output,
        telemetry: outcome.telemetry,
        score,
        judge_voice_cards: judgeVoice,
        judge_visual_style: judgeVisual,
      };
      writeFileSync(join(runDir, path, `${slug}.json`), JSON.stringify(result, null, 2), "utf-8");
      results.push(result);
      const judgeStr = args.judge
        ? ` judge_voice=${judgeVoice ?? "·"} judge_visual=${judgeVisual ?? "·"}`
        : "";
      console.log(
        `    ✓ ${slug} [path ${path}] dna_delta=${score.dna_delta_sum} tropes_off=${score.trope_disagreements} stat_ok=${score.stat_mapping_correct}${judgeStr} ${score.passes_mechanical ? "PASS" : "FAIL"}`,
      );
    }
  }

  // Aggregated scores per path.
  const byPath: Record<string, IpScore[]> = {};
  for (const r of results) {
    const bucket = byPath[r.path] ?? [];
    bucket.push(r.score);
    byPath[r.path] = bucket;
  }
  const aggregate: Record<string, ReturnType<typeof summarizeScores>> = {};
  for (const [p, scores] of Object.entries(byPath)) {
    aggregate[p] = summarizeScores(scores);
  }

  writeFileSync(
    join(runDir, "score.json"),
    JSON.stringify({ aggregate, results }, null, 2),
    "utf-8",
  );

  // Human-readable decision summary.
  const lines: string[] = [];
  lines.push("# Profile-generation eval — decision summary");
  lines.push("");
  lines.push(`Run: ${timestamp}`);
  lines.push(`IPs: ${Array.from(targets.keys()).join(", ")}`);
  lines.push("");
  lines.push(
    "| Path | IPs | Avg DNA delta | Avg trope disagreements | Stat mapping rate | Mechanical pass rate |",
  );
  lines.push("|---|---|---|---|---|---|");
  for (const [p, agg] of Object.entries(aggregate)) {
    lines.push(
      `| ${p} | ${agg.ip_count} | ${agg.dna_delta_avg.toFixed(1)} | ${agg.trope_disagreements_avg.toFixed(1)} | ${(agg.stat_mapping_correct_rate * 100).toFixed(0)}% | ${(agg.pass_rate * 100).toFixed(0)}% |`,
    );
  }
  lines.push("");
  lines.push(
    "§10.6 decision thresholds: DNA delta < 30 / IP, trope disagreements < 3 / IP, stat mapping correct on every IP.",
  );
  lines.push("");
  lines.push(
    "Mechanical pass rate ≥ 1.0 across the ground-truth set is the bar for retiring the alternative path.",
  );
  writeFileSync(join(runDir, "decision.md"), lines.join("\n"), "utf-8");

  console.log("");
  console.log(`✓ Eval run complete. See ${runDir}/decision.md for the summary.`);
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
