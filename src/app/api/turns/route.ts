import { getCurrentUser } from "@/lib/auth";
import { checkBudget, incrementCostLedger } from "@/lib/budget";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { getLangfuse } from "@/lib/observability/langfuse";
import type { AidmSpanHandle } from "@/lib/tools";
import { CampaignSettings } from "@/lib/types/campaign-settings";
import { chronicleTurn, computeArcTrigger } from "@/lib/workflow/chronicle";
import { directTurn, shouldFireHybrid } from "@/lib/workflow/direct";
import { foreshadowTick } from "@/lib/workflow/foreshadow";
import { runMeta, shouldDispatchMeta } from "@/lib/workflow/meta";
import { shouldSnapshot, writeStateSnapshot } from "@/lib/workflow/snapshot";
import { runTurn } from "@/lib/workflow/turn";
import { NextResponse, after } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn endpoint — SSE stream of KA's narrative for one player input.
 *
 * Protocol: standard text/event-stream. Each SSE event carries JSON:
 *   event: routed   → data: { verdictKind, response, turnNumber }
 *   event: text     → data: { delta }
 *   event: done     → data: { turnId, turnNumber, narrative, ttftMs, totalMs,
 *                             costUsd, portraitNames, verdictKind, intent, outcome }
 *   event: error    → data: { message }
 *
 * The `done` payload's verdictKind + intent + outcome fields were added in
 * Commit 7.4 so the route handler can fire Chronicler via `after()` with
 * full context. The browser client currently ignores them (typed in
 * src/hooks/use-turn-stream.ts without the new fields) — extending the
 * client type is a low-value follow-up if the UI ever needs type-safe
 * access.
 *
 * Client closes when it sees `done` or `error`. If the fetch is aborted
 * mid-stream (user navigates away, clicks stop), the AbortController
 * fires and KA's Agent SDK subprocess is torn down.
 */

const PostBody = z.object({
  campaignId: z.string().min(1),
  message: z.string().min(1).max(4000),
});

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

/**
 * Construct an `AidmSpanHandle` from the Langfuse trace. `AidmSpanHandle`
 * was already shaped to match Langfuse's `trace.span({name,input,metadata})`
 * → `{end({output,metadata})}` API — the trace client satisfies the
 * interface directly; we just narrow to the methods we use. When Langfuse
 * isn't configured (no keys), returns undefined so every `deps.trace?.span`
 * call stays no-op and existing null-safety holds.
 */
function buildTraceHandle(
  name: string,
  metadata: Record<string, unknown>,
): AidmSpanHandle | undefined {
  const client = getLangfuse();
  if (!client) return undefined;
  const trace = client.trace({ name, metadata });
  return {
    span: (opts) => {
      const s = trace.span({ name: opts.name, input: opts.input, metadata: opts.metadata });
      return {
        end: (data) => {
          s.end({ output: data?.output, metadata: data?.metadata });
        },
      };
    },
  };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    console.warn("[turns] 401 unauthenticated");
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn("[turns] 400 invalid_body", { userId: user.id, detail });
    return NextResponse.json({ error: "invalid_body", detail }, { status: 400 });
  }

  // Pre-turn budget gate (Commit 9). Runs BEFORE opening the SSE stream
  // so we can return an honest 429 + JSON body; encoding a gate-rejection
  // as an SSE error event on a 200 stream would be misleading to the
  // client. `checkBudget` does the cost-cap check first (non-mutating),
  // then atomically increments the rate counter and compares — that
  // ordering is what closes the TOCTOU gap a read-then-increment pattern
  // would leave under concurrent POSTs.
  const gate = await checkBudget(user.id);
  if (!gate.ok) {
    if (gate.reason === "rate") {
      console.warn("[turns] 429 rate_limited", {
        userId: user.id,
        campaignId: body.campaignId,
        rateCount: gate.rateCount,
        rateCap: gate.rateCap,
        retryAfterSec: gate.retryAfterSec,
      });
      return NextResponse.json(
        {
          error: "rate_limited",
          reason: "rate",
          retryAfterSec: gate.retryAfterSec,
          rateCount: gate.rateCount,
          rateCap: gate.rateCap,
        },
        {
          status: 429,
          headers: { "Retry-After": String(gate.retryAfterSec) },
        },
      );
    }
    // cost_cap
    console.warn("[turns] 429 cost_cap_reached", {
      userId: user.id,
      campaignId: body.campaignId,
      usedUsd: gate.usedUsd,
      capUsd: gate.capUsd,
    });
    return NextResponse.json(
      {
        error: "cost_cap_reached",
        reason: "cost_cap",
        usedUsd: gate.usedUsd,
        capUsd: gate.capUsd,
        nextResetAt: gate.nextResetAt,
      },
      { status: 429 },
    );
  }

  const abort = new AbortController();
  // Forward client disconnect to KA's subprocess.
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  // Build the Langfuse trace handle once per request. Every span call
  // in runTurn / runMeta / chronicleTurn / sub-agents / tool registry
  // hangs off this root. Until this landed, every `deps.trace?.span(...)`
  // was a null-safe no-op in prod (scaffolded-but-never-instantiated).
  const trace = buildTraceHandle("POST /api/turns", {
    userId: user.id,
    campaignId: body.campaignId,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Prime the connection through the proxy. Small SSE streams
      // (router short-circuit path: ~2 tiny events, no token-deltas in
      // between) can sit buffered upstream until the stream closes,
      // so the client sees nothing live and events only surface via
      // page refresh. Sending a leading comment line with padding
      // immediately flushes through any buffer threshold. Comment
      // lines (`:<text>\n`) are ignored by SSE parsers per the spec.
      controller.enqueue(new TextEncoder().encode(`: stream open${" ".repeat(2048)}\n\n`));

      try {
        const firestore = getFirebaseFirestore();

        // Phase 5 meta-conversation dispatch. Pre-parse for slash
        // commands + check in-flight meta state; route to runMeta when
        // appropriate, runTurn otherwise. The Firestore lookup is
        // cheap and bounded; avoids a full runTurn round-trip for
        // meta exchanges.
        const campaignSnap = await firestore.collection(COL.campaigns).doc(body.campaignId).get();
        const campaignData = campaignSnap.exists ? campaignSnap.data() : undefined;
        const settingsRaw =
          campaignData && campaignData.ownerUid === user.id && campaignData.deletedAt === null
            ? campaignData.settings
            : undefined;
        const parsed = CampaignSettings.safeParse(settingsRaw ?? {});
        const metaState = parsed.success ? parsed.data.meta_conversation : undefined;

        // If the player resumed with a suffix, consume it as the turn
        // message. Drop the meta state first so runTurn sees a clean
        // game state.
        if (shouldDispatchMeta(body.message, metaState)) {
          const metaIter = runMeta(
            {
              campaignId: body.campaignId,
              userId: user.id,
              playerMessage: body.message,
            },
            { firestore, trace },
          );
          let pendingResumeSuffix: string | undefined;
          for await (const ev of metaIter) {
            const { type, ...rest } = ev;
            controller.enqueue(encodeSseEvent(type, rest));
            if (type === "exited") pendingResumeSuffix = ev.pendingResumeSuffix;
          }
          // If /resume had a suffix, fall through to runTurn with the
          // suffix as the gameplay message. Otherwise emit a distinct
          // `meta_done` terminal event so the client knows the meta
          // exchange concluded WITHOUT committing a phantom turn_number=0
          // doc to the gameplay feed. The gameplay `done` event is
          // reserved for real turns that advance the turn counter.
          if (pendingResumeSuffix) {
            // Intentional fallthrough — continue to runTurn below.
            body.message = pendingResumeSuffix;
          } else {
            controller.enqueue(encodeSseEvent("meta_done", {}));
            controller.close();
            return;
          }
        }

        // Pre-turn gate ran before this stream opened. The HTTP route
        // cannot skip the gate — checkBudget is unconditional above,
        // and the request body schema doesn't accept any override field.
        const iter = runTurn(
          {
            campaignId: body.campaignId,
            userId: user.id,
            playerMessage: body.message,
            abort,
          },
          { firestore, trace },
        );
        for await (const ev of iter) {
          const { type, ...rest } = ev;
          controller.enqueue(encodeSseEvent(type, rest));
          if (type === "done") {
            // Post-turn cost ledger increment (Commit 9). Adds the
            // PRE-CHRONICLER turn cost into user_cost_ledger[user, today].
            // Chronicler's cost is added separately inside chronicleTurn
            // when it finishes (it can trail the done event by seconds).
            // Wrapped in try/catch — a ledger failure must not fail a
            // turn the user already saw; log + continue.
            if (typeof ev.costUsd === "number" && ev.costUsd > 0) {
              try {
                await incrementCostLedger(user.id, ev.costUsd);
              } catch (err) {
                console.warn("[turns] post-turn incrementCostLedger failed", {
                  userId: user.id,
                  campaignId: body.campaignId,
                  turnId: ev.turnId,
                  turnNumber: ev.turnNumber,
                  costUsd: ev.costUsd,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            // Fire Chronicler post-response via Next's after(). It runs
            // after the SSE response has flushed to the client — user-
            // perceived latency is unchanged. FIFO-per-campaign lock +
            // idempotency guard are both inside chronicleTurn.
            //
            // Chronicle on `continue` (player-driven narrative) AND
            // `worldbuilder` (player-asserted canon). WB short-circuits
            // already persisted entity updates synchronously inside the
            // turn workflow; Chronicler adds the episodic summary,
            // spotlight-debt maintenance, and voice-patterns observation
            // that apply equally to WB turns. META / OVERRIDE skip
            // chronicling — their structured effects are the whole point
            // of the turn; no narrative to catalog.
            if (ev.verdictKind === "continue" || ev.verdictKind === "worldbuilder") {
              const chronicleInput = {
                turnId: ev.turnId,
                campaignId: body.campaignId,
                userId: user.id,
                turnNumber: ev.turnNumber,
                playerMessage: body.message,
                narrative: ev.narrative,
                intent: ev.intent,
                outcome: ev.outcome,
                arcTrigger: computeArcTrigger(ev.intent.epicness, ev.turnNumber),
              };
              after(async () => {
                await chronicleTurn(chronicleInput, { firestore, trace });
              });
              // Foreshadowing lifecycle tick — ages seeds, marks
              // overdue, surfaces convergence. Cheap (no LLM); runs
              // every turn after Chronicler so seed retirements made
              // this turn don't get auto-overdue-stamped.
              after(async () => {
                await foreshadowTick({
                  campaignId: body.campaignId,
                  userId: user.id,
                  turnNumber: ev.turnNumber,
                });
              });
              // State snapshot every 10 turns (M7). Idempotent; safe
              // to fire optimistically.
              if (shouldSnapshot(ev.turnNumber)) {
                after(async () => {
                  await writeStateSnapshot({
                    campaignId: body.campaignId,
                    userId: user.id,
                    turnNumber: ev.turnNumber,
                  });
                });
              }
              // Director hybrid trigger — every 3+ turns at epicness
              // ≥ 0.6 per ROADMAP §5.2. Fires post-Chronicler so the
              // director sees the latest summary.
              if (shouldFireHybrid(ev.turnNumber, ev.intent.epicness ?? 0)) {
                after(async () => {
                  await directTurn(
                    {
                      campaignId: body.campaignId,
                      userId: user.id,
                      trigger: "hybrid",
                      turnNumber: ev.turnNumber,
                      epicness: ev.intent.epicness ?? 0,
                    },
                    { trace },
                  );
                });
              }
              // Director startup trigger — first gameplay turn ever
              // (turn 1). Authors the initial arc plan + voice journal
              // from the OpeningStatePackage. Session boundary detection
              // for multi-session resumption lands at M7 once state
              // snapshots exist.
              if (ev.turnNumber === 1) {
                after(async () => {
                  await directTurn(
                    {
                      campaignId: body.campaignId,
                      userId: user.id,
                      trigger: "startup",
                      turnNumber: ev.turnNumber,
                    },
                    { trace },
                  );
                });
              }
            }
            break;
          }
          if (type === "error") break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[turns] 500 stream threw", {
          userId: user.id,
          campaignId: body.campaignId,
          error: msg,
        });
        controller.enqueue(encodeSseEvent("error", { message: msg }));
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Explicit identity encoding — blocks any upstream gzip/deflate
      // that would batch tiny SSE payloads before sending. Pairs with
      // the padding priming comment above for a belt-and-suspenders
      // anti-buffering posture.
      "Content-Encoding": "identity",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
