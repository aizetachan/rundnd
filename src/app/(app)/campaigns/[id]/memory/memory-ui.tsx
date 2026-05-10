"use client";

import { useState } from "react";

interface EpisodicEntry {
  turn_number: number;
  player_message: string;
  summary: string | null;
  narrative_excerpt: string;
  created_at: string | null;
}

interface SemanticEntry {
  id: string;
  category: string;
  content: string;
  heat: number;
  flags: Record<string, unknown>;
  turn_number: number;
}

interface ContextBlockEntry {
  id: string;
  block_type: string;
  entity_name: string;
  status: string;
  version: number;
  last_updated_turn: number;
  content: string;
}

interface Props {
  episodic: EpisodicEntry[];
  semantic: SemanticEntry[];
  contextBlocks: ContextBlockEntry[];
}

type Tab = "episodic" | "semantic" | "context";

export default function MemoryUI({ episodic, semantic, contextBlocks }: Props) {
  const [tab, setTab] = useState<Tab>("episodic");

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b">
        {(["episodic", "semantic", "context"] as const).map((t) => {
          const count = t === "episodic" ? episodic.length : t === "semantic" ? semantic.length : contextBlocks.length;
          const label = t === "context" ? "Context blocks" : t.charAt(0).toUpperCase() + t.slice(1);
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === t
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              <span className="ml-1.5 text-muted-foreground text-xs">({count})</span>
            </button>
          );
        })}
      </nav>

      {tab === "episodic" ? <EpisodicTab entries={episodic} /> : null}
      {tab === "semantic" ? <SemanticTab entries={semantic} /> : null}
      {tab === "context" ? <ContextTab entries={contextBlocks} /> : null}
    </div>
  );
}

function EpisodicTab({ entries }: { entries: EpisodicEntry[] }) {
  if (entries.length === 0) {
    return <EmptyState>No turns yet.</EmptyState>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((e) => (
        <li
          key={e.turn_number}
          className="rounded-lg border bg-background/40 p-4"
        >
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-muted-foreground text-xs">turn {e.turn_number}</span>
            {e.created_at ? (
              <span className="text-muted-foreground text-xs">
                {new Date(e.created_at).toLocaleString()}
              </span>
            ) : null}
          </div>
          {e.player_message ? (
            <p className="mb-2 text-muted-foreground text-sm italic">"{e.player_message}"</p>
          ) : null}
          {e.summary ? (
            <p className="mb-2 rounded bg-muted/40 p-2 text-sm">
              <span className="mr-2 font-medium text-xs uppercase tracking-wide">summary</span>
              {e.summary}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{e.narrative_excerpt}</p>
        </li>
      ))}
    </ul>
  );
}

function SemanticTab({ entries }: { entries: SemanticEntry[] }) {
  if (entries.length === 0) {
    return <EmptyState>No semantic memories written yet — Chronicler builds these post-turn.</EmptyState>;
  }
  // Group by category for the eye to scan; categories already top-N'd by heat upstream.
  const byCategory = new Map<string, SemanticEntry[]>();
  for (const m of entries) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  const categories = [...byCategory.keys()].sort();
  return (
    <div className="flex flex-col gap-4">
      {categories.map((cat) => (
        <section key={cat}>
          <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {cat}
          </h3>
          <ul className="flex flex-col gap-2">
            {(byCategory.get(cat) ?? []).map((m) => (
              <li key={m.id} className="rounded-md border bg-background/40 p-3">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="font-mono text-muted-foreground text-xs">turn {m.turn_number}</span>
                  <span className="tabular-nums text-muted-foreground text-xs">heat {m.heat}</span>
                </div>
                <p className="text-sm leading-relaxed">{m.content}</p>
                {Object.keys(m.flags).length > 0 ? (
                  <p className="mt-1 text-muted-foreground text-xs">
                    flags: {Object.keys(m.flags).join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ContextTab({ entries }: { entries: ContextBlockEntry[] }) {
  if (entries.length === 0) {
    return (
      <EmptyState>
        No context blocks yet — Chronicler writes these when an entity (NPC, arc, faction) becomes
        load-bearing enough to warrant a re-distillation.
      </EmptyState>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((b) => (
        <li key={b.id} className="rounded-lg border bg-background/40 p-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="font-semibold text-sm">
              <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {b.block_type}
              </span>
              {b.entity_name}
            </h3>
            <span className="text-muted-foreground text-xs">
              v{b.version} · {b.status} · turn {b.last_updated_turn}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{b.content}</p>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed bg-background/40 p-8 text-center text-muted-foreground text-sm italic">
      {children}
    </div>
  );
}
