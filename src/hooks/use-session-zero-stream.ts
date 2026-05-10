"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Client-side hook for posting to /api/session-zero and rendering the
 * SSE stream. Mirrors `use-turn-stream` but for the SZ conductor — no
 * router pre-pass, no Chronicler post-pass, no flags surface.
 *
 *   - `send(message)` — POST a new player message
 *   - `cancel()`      — abort the in-flight stream
 *   - `streaming`     — true while a turn is in flight
 *   - `liveText`      — the conductor's text as it accumulates
 *   - `lastTurn`      — the most recent `done` event payload
 *   - `error`         — terminal error, if any
 */

type HandoffStatus = "compiling" | "compiled" | "compiled_with_warnings" | "failed";

type SzEvent =
  | { type: "text"; delta: string }
  | { type: "handoff"; status: HandoffStatus; message?: string; packageId?: string }
  | {
      type: "done";
      text: string;
      ttftMs: number | null;
      totalMs: number;
      costUsd: number | null;
      toolCallCount: number;
      /** SZ doc phase after this turn — `complete` (handoff ran) or `ready_for_handoff` (handoff failed). */
      phase: string;
      /** Set when handoff succeeded; UI navigates here. Null otherwise. */
      redirectTo: string | null;
    }
  | { type: "error"; message: string };

export interface UseSessionZeroStreamReturn {
  send: (message: string) => Promise<void>;
  cancel: () => void;
  streaming: boolean;
  liveText: string;
  /** Latest handoff status emitted on this stream. Null until/unless one fires. */
  handoff: { status: HandoffStatus; message?: string; packageId?: string } | null;
  lastTurn: Extract<SzEvent, { type: "done" }> | null;
  error: string | null;
}

export function useSessionZeroStream(campaignId: string): UseSessionZeroStreamReturn {
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [lastTurn, setLastTurn] = useState<Extract<SzEvent, { type: "done" }> | null>(null);
  const [handoff, setHandoff] = useState<UseSessionZeroStreamReturn["handoff"]>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (message: string) => {
      if (streaming) return;
      setError(null);
      setLiveText("");
      setHandoff(null);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/session-zero", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId, message }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          setError(`HTTP ${res.status}: ${text || "request failed"}`);
          setStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE parse pattern
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const lines = frame.split("\n");
            let eventName: string | null = null;
            let dataLine: string | null = null;
            for (const line of lines) {
              if (line.startsWith("event: ")) eventName = line.slice(7).trim();
              else if (line.startsWith("data: ")) dataLine = line.slice(6);
            }
            if (!eventName || dataLine === null) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(dataLine);
            } catch {
              continue;
            }
            const ev = { type: eventName, ...(parsed as object) } as SzEvent;
            if (ev.type === "text") {
              setLiveText((t) => t + ev.delta);
            } else if (ev.type === "handoff") {
              setHandoff({
                status: ev.status,
                message: ev.message,
                packageId: ev.packageId,
              });
            } else if (ev.type === "done") {
              setLastTurn(ev);
            } else if (ev.type === "error") {
              setError(ev.message);
            }
          }
        }
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [campaignId, streaming],
  );

  return { send, cancel, streaming, liveText, handoff, lastTurn, error };
}
