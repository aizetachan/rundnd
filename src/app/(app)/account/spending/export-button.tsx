"use client";

import { useState } from "react";

/**
 * Client-side download trigger for POST /api/users/export. Calls the
 * endpoint, reads the JSON blob, sticks it on a temporary anchor with
 * a download attribute, and revokes the object URL when done.
 *
 * Two-state UI: idle → "Downloading…" while the request is in flight.
 * No success state — the browser's own download UI is the confirmation.
 */
export function ExportButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users/export", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `download failed (${res.status})`);
      }
      const blob = await res.blob();
      // Filename comes from Content-Disposition; we re-derive on the
      // client for browsers that don't surface it nicely on blob:
      // URLs (Safari).
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] ?? `aidm-export-${Date.now()}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
      >
        {busy ? "Downloading…" : "Export my data (JSON)"}
      </button>
      {error ? <p className="mt-2 text-red-600 text-sm">{error}</p> : null}
    </div>
  );
}
