import { runSessionZeroConductor } from "@/lib/agents";
import { getCurrentUser } from "@/lib/auth";
import { checkBudget, incrementCostLedger } from "@/lib/budget";
import { getFirebaseFirestore } from "@/lib/firebase/admin";
import { COL } from "@/lib/firestore";
import { getLangfuse } from "@/lib/observability/langfuse";
import { runHandoff } from "@/lib/session-zero/run-handoff";
import { appendConversationTurn, loadSessionZero } from "@/lib/session-zero/state";
import type { AidmSpanHandle, AidmToolContext } from "@/lib/tools";
import { resolveModelContext } from "@/lib/workflow/turn";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Session Zero turn endpoint — SSE stream of the conductor's response
 * for one player input.
 *
 * Mirrors /api/turns: auth → budget gate → load SZ state → run
 * conductor → stream back. Differences from /api/turns:
 *   - No router pre-pass. SZ has one orchestrator (the conductor); the
 *     router's intent / override / WB classification doesn't apply.
 *   - No Chronicler post-pass. The conductor's tool calls write SZ
 *     state directly; HandoffCompiler (sub 4) is the post-SZ analog.
 *
 * Protocol:
 *   event: text  → data: { delta }
 *   event: done  → data: { text, ttftMs, totalMs, costUsd, toolCallCount, phase }
 *   event: error → data: { message }
 */

const PostBody = z.object({
  campaignId: z.string().min(1),
  message: z.string().min(1).max(4000),
});

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

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
    console.warn("[session-zero] 401 unauthenticated");
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn("[session-zero] 400 invalid_body", { userId: user.id, detail });
    return NextResponse.json({ error: "invalid_body", detail }, { status: 400 });
  }

  // Same gate semantics as /api/turns: budget enforcement happens
  // BEFORE we open the SSE stream so we can return an honest 429 + JSON
  // body. SZ runs share the user's daily cost ceiling — the conductor
  // billing is not a separate budget bucket at M2.
  const gate = await checkBudget(user.id);
  if (!gate.ok) {
    if (gate.reason === "rate") {
      return NextResponse.json(
        {
          error: "rate_limited",
          reason: "rate",
          retryAfterSec: gate.retryAfterSec,
          rateCount: gate.rateCount,
          rateCap: gate.rateCap,
        },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } },
      );
    }
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

  const firestore = getFirebaseFirestore();
  // Authorize ownership of the campaign + that it's actually an SZ
  // campaign. The conductor's MCP tools also call authorizeCampaignAccess
  // through the registry, but we want a pre-stream rejection so the
  // browser sees a 403/404 rather than a `text` SSE event followed by
  // an MCP-side throw.
  const campaignSnap = await firestore.collection(COL.campaigns).doc(body.campaignId).get();
  if (!campaignSnap.exists) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const cd = campaignSnap.data();
  if (!cd || cd.ownerUid !== user.id || cd.deletedAt !== null) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (cd.phase !== "session_zero" && cd.phase !== "sz") {
    return NextResponse.json(
      { error: "wrong_phase", detail: `campaign phase is "${cd.phase}", expected session_zero` },
      { status: 409 },
    );
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const trace = buildTraceHandle("POST /api/session-zero", {
    userId: user.id,
    campaignId: body.campaignId,
  });

  // Anchor the user-message timestamp BEFORE the stream so the post-
  // run append's createdAt predates the conductor's tool-call entries
  // (which write `new Date()` at MCP execution time). loadSessionZero
  // sorts by createdAt on read, so the chronological reconstruction
  // of the next turn's history is: prior … → user msg → tool calls
  // (during run) → conductor prose. Tool calls share `arrayUnion` with
  // the framing entries; without this anchor the user msg lands AFTER
  // the tool calls it triggered.
  const userMsgTime = new Date();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(`: stream open${" ".repeat(2048)}\n\n`));
      let aggregatedText = "";
      let costUsd: number | null = null;
      let toolCallCount = 0;
      let totalMs = 0;
      let ttftMs: number | null = null;
      let runError: Error | null = null;
      let szPhase = "in_progress";

      try {
        const sz = await loadSessionZero(firestore, body.campaignId);
        szPhase = sz.phase;
        const modelContext = resolveModelContext(cd.settings);

        const toolContext: AidmToolContext = {
          campaignId: body.campaignId,
          userId: user.id,
          firestore,
          trace,
          logContext: { campaignId: body.campaignId, userId: user.id },
        };

        const iter = runSessionZeroConductor(
          {
            playerMessage: body.message,
            conversationHistory: sz.conversationHistory,
            modelContext,
            toolContext,
            abortController: abort,
          },
          { trace, logContext: { campaignId: body.campaignId, userId: user.id } },
        );

        for await (const ev of iter) {
          if (ev.kind === "text") {
            aggregatedText += ev.delta;
            controller.enqueue(encodeSseEvent("text", { delta: ev.delta }));
            continue;
          }
          if (ev.kind === "final") {
            costUsd = ev.costUsd;
            toolCallCount = ev.toolCallCount;
            totalMs = ev.totalMs;
            ttftMs = ev.ttftMs;
          }
        }
      } catch (err) {
        runError = err instanceof Error ? err : new Error(String(err));
        console.error("[session-zero] stream threw", {
          userId: user.id,
          campaignId: body.campaignId,
          error: runError.message,
        });
      }

      // Always-attempt persistence. Even on stream error / abort the
      // player typed something and the conductor's tool calls (if any
      // fired before the error) are already in `conversation_history`.
      // Writing the framing user/conductor entries here keeps resume's
      // history reconstructable; an orphan user msg with empty
      // conductor prose is better than tool-call entries with no
      // preceding user message. Wrapped in try/catch so a write
      // failure can't shadow the stream's actual error.
      try {
        await appendConversationTurn(firestore, body.campaignId, [
          { role: "user", text: body.message, tool_calls: [], createdAt: userMsgTime },
          {
            role: "conductor",
            text: aggregatedText,
            tool_calls: [],
            createdAt: new Date(),
          },
        ]);
      } catch (writeErr) {
        console.warn("[session-zero] post-turn appendConversationTurn failed", {
          userId: user.id,
          campaignId: body.campaignId,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }

      if (!runError && typeof costUsd === "number" && costUsd > 0) {
        try {
          await incrementCostLedger(user.id, costUsd);
        } catch (err) {
          console.warn("[session-zero] post-turn incrementCostLedger failed", {
            userId: user.id,
            campaignId: body.campaignId,
            costUsd,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (runError) {
        controller.enqueue(encodeSseEvent("error", { message: runError.message }));
        controller.close();
        return;
      }

      // Re-read phase: `finalize_session_zero` flips it to
      // `ready_for_handoff`. If we're there, run HandoffCompiler now
      // (synchronously inside this request — the player is waiting on
      // the redirect anyway, and a deferred `after()` would race the
      // browser's navigation).
      const post = await loadSessionZero(firestore, body.campaignId).catch(() => null);
      let phase = post?.phase ?? szPhase;
      let redirectTo: string | null = null;

      if (phase === "ready_for_handoff") {
        controller.enqueue(encodeSseEvent("handoff", { status: "compiling" }));
        try {
          const handoffModelContext = resolveModelContext(cd.settings);
          const result = await runHandoff(
            {
              campaignId: body.campaignId,
              userId: user.id,
              modelContext: handoffModelContext,
            },
            { firestore, trace },
          );
          phase = "complete";
          redirectTo = result.redirectTo;
          controller.enqueue(
            encodeSseEvent("handoff", {
              status: result.fellBack ? "compiled_with_warnings" : "compiled",
              packageId: result.packageId,
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[session-zero] handoff failed", {
            userId: user.id,
            campaignId: body.campaignId,
            error: msg,
          });
          // Don't block the player on a handoff failure — emit the
          // done event with phase=ready_for_handoff so the UI shows
          // the warning banner. Sub 5's resume flow will offer redo.
          controller.enqueue(encodeSseEvent("handoff", { status: "failed", message: msg }));
        }
      }

      controller.enqueue(
        encodeSseEvent("done", {
          text: aggregatedText,
          ttftMs,
          totalMs,
          costUsd,
          toolCallCount,
          phase,
          redirectTo,
        }),
      );
      controller.close();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Content-Encoding": "identity",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
