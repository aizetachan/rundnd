"use client";

import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { signOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Two-step destructive confirm: first click arms; second click
 * within 8 s fires. Resets if the user navigates away or waits.
 *
 * On success: hits /api/users/delete (soft delete server-side),
 * then signs out client-side and POSTs /api/auth/signout to wipe
 * the cookie. Router pushes to landing.
 */
export function DeleteAccountButton() {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function arm() {
    setArmed(true);
    setError(null);
    setTimeout(() => setArmed(false), 8_000);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/users/delete", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `delete failed (${res.status})`);
      }
      // Mirror the UserMenu sign-out flow: client SDK + server cookie clear.
      try {
        await signOut(getFirebaseClientAuth());
      } catch {
        // ignore — server-side delete already happened, this is just cleanup
      }
      await fetch("/api/auth/signout", { method: "POST" });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div>
      {armed ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded-md border border-destructive bg-destructive/10 px-3 py-1.5 text-destructive text-sm hover:bg-destructive/20 disabled:opacity-60"
          >
            {busy ? "Deleting…" : "Confirm: delete my account permanently"}
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            disabled={busy}
            className="text-muted-foreground text-sm hover:text-foreground"
          >
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={arm}
          className="rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-destructive text-sm hover:bg-destructive/10"
        >
          Delete my account…
        </button>
      )}
      {error ? <p className="mt-2 text-red-600 text-sm">{error}</p> : null}
    </div>
  );
}
