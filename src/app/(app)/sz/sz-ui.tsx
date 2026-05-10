"use client";

import { BudgetIndicator } from "@/components/budget-indicator";
import { useSessionZeroStream } from "@/hooks/use-session-zero-stream";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface PriorMessage {
  role: "user" | "conductor" | "system";
  text: string;
  tool_calls: Array<{ name: string }>;
}

interface Props {
  campaignId: string;
  priorHistory: PriorMessage[];
  hardRequirementsMet: Record<string, boolean>;
}

/**
 * Session Zero chat surface. Mirrors `/campaigns/[id]/play` shape but
 * scoped to the conductor: prior conversation feed on top, input on
 * bottom, hard-requirements snapshot in the header. The "send" button
 * disables once the SZ phase flips to `ready_for_handoff` — sub 4
 * will redirect on that event.
 */
export default function SzUI({ campaignId, priorHistory, hardRequirementsMet }: Props) {
  const router = useRouter();
  const { send, cancel, streaming, liveText, handoff, lastTurn, error } =
    useSessionZeroStream(campaignId);
  const [input, setInput] = useState("");
  const [committed, setCommitted] = useState<PriorMessage[]>(priorHistory);
  const [budgetRefreshKey, setBudgetRefreshKey] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const pendingMessageRef = useRef<string>("");

  // Each `done` event commits one user→conductor pair into the local
  // feed. The hook resets `lastTurn` only on a new `send`, so this
  // useEffect fires once per turn — no extra dedupe needed. If the
  // turn carried a handoff redirect, navigate to gameplay.
  useEffect(() => {
    if (!lastTurn) return;
    setCommitted((prev) => [
      ...prev,
      { role: "user", text: pendingMessageRef.current, tool_calls: [] },
      { role: "conductor", text: lastTurn.text, tool_calls: [] },
    ]);
    pendingMessageRef.current = "";
    setBudgetRefreshKey((k) => k + 1);

    if (lastTurn.redirectTo) {
      router.replace(lastTurn.redirectTo);
    }
  }, [lastTurn, router]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are content-change triggers
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [committed, liveText, streaming]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: input is the content-change trigger
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxPx = 200;
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }, [input]);

  const submit = async () => {
    const message = input.trim();
    if (!message || streaming) return;
    pendingMessageRef.current = message;
    setInput("");
    await send(message);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      void submit();
    }
  };

  // "Compiling" while the handoff is in flight; "Done" once the route
  // emits redirectTo. The `finalized` check disables input as soon as
  // we know the turn is heading to handoff (player shouldn't keep
  // typing while we're stitching the opening scene).
  const compiling = handoff?.status === "compiling";
  const handoffFailed = handoff?.status === "failed";
  const finalized =
    compiling ||
    handoffFailed ||
    lastTurn?.phase === "ready_for_handoff" ||
    lastTurn?.phase === "complete";

  // Render-friendly message list: filter out tool-call sidecars whose
  // text is empty (those are bookkeeping, not conversation). The
  // server-loader already includes them so resume sees the structure;
  // we hide them in the chat feed.
  const visibleHistory = committed.filter((m) => m.text.length > 0);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Session Zero</h1>
        <div className="flex items-center gap-4">
          <BudgetIndicator refreshKey={budgetRefreshKey} />
          <Link href="/campaigns" className="text-muted-foreground text-sm hover:text-foreground">
            campaigns
          </Link>
        </div>
      </header>

      <RequirementsBar met={hardRequirementsMet} />

      <div ref={feedRef} className="flex-1 overflow-y-auto rounded-lg border bg-background/40 p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {visibleHistory.length === 0 && !streaming && !liveText ? (
            <p className="text-muted-foreground italic">
              {
                "What anime, manga, or vibe should this campaign honor? Drop the premise and we'll shape the rest together."
              }
            </p>
          ) : null}

          {visibleHistory.map((m, i) => (
            <div key={`${m.role}-${i}`} className="flex flex-col gap-2">
              <p className="whitespace-pre-wrap leading-relaxed">
                <span className="mr-2 font-mono text-xs opacity-60">
                  {m.role === "user" ? "you" : "conductor"}
                </span>
                {m.text}
              </p>
            </div>
          ))}

          {streaming && (
            <div className="flex flex-col gap-2">
              {pendingMessageRef.current ? (
                <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                  <span className="mr-2 font-mono text-xs opacity-60">you</span>
                  {pendingMessageRef.current}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap leading-relaxed">
                <span className="mr-2 font-mono text-xs opacity-60">conductor</span>
                {liveText}
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-current opacity-60" />
              </p>
            </div>
          )}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          {compiling ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Compiling your opening scene…
            </div>
          ) : null}

          {handoffFailed ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm">
              Handoff failed: {handoff?.message ?? "(no detail)"} — please try sending another
              message. (sub 5 will surface a retry control.)
            </div>
          ) : null}

          {handoff?.status === "compiled_with_warnings" ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Compiled with warnings. Loading your opening scene…
            </div>
          ) : null}

          {handoff?.status === "compiled" ? (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
              Session Zero complete. Loading your opening scene…
            </div>
          ) : null}

          {finalized && !compiling && !handoff ? (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
              Session Zero finalized.
            </div>
          ) : null}
        </div>
      </div>

      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          placeholder={
            finalized
              ? "Session Zero finalized — waiting on handoff."
              : streaming
                ? "…"
                : "Tell me about the world you want to play in."
          }
          disabled={streaming || finalized}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        />
        {streaming ? (
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border bg-muted px-4 py-2 text-sm hover:bg-muted/70"
          >
            stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || finalized}
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            send
          </button>
        )}
      </form>
    </div>
  );
}

const REQUIREMENT_LABELS: Array<[string, string]> = [
  ["has_profile_ref", "profile"],
  ["has_canonicality_mode", "canonicality"],
  ["has_character_name", "name"],
  ["has_character_concept", "concept"],
  ["has_starting_situation", "opening"],
];

function RequirementsBar({ met }: { met: Record<string, boolean> }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">requirements:</span>
      {REQUIREMENT_LABELS.map(([key, label]) => {
        const ok = met[key] === true;
        return (
          <span
            key={key}
            className={
              ok
                ? "rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-200"
                : "rounded border border-muted-foreground/30 bg-muted/30 px-2 py-0.5 text-muted-foreground"
            }
          >
            {ok ? "✓" : "·"} {label}
          </span>
        );
      })}
    </div>
  );
}
