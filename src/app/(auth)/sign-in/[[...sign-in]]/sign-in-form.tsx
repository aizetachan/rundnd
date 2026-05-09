"use client";

import { getFirebaseClientAuth, googleProvider } from "@/lib/firebase/client";
import { signInWithEmailAndPassword, signInWithPopup } from "firebase/auth";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

/**
 * Sign-in flow:
 *   1. Firebase client SDK authenticates → returns a User with an ID token.
 *   2. We POST the ID token to /api/auth/session to mint an httpOnly
 *      session cookie. The server-side cookie is what middleware and
 *      getCurrentUser() rely on.
 *   3. Redirect to ?redirect= or /campaigns.
 *
 * Both Google OAuth and email/password go through the same
 * postIdTokenAndRedirect step so behavior stays consistent.
 */
export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirect") ?? "/campaigns";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function postIdTokenAndRedirect(idToken: string): Promise<void> {
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "session_failed");
    }
    router.push(redirectTo);
    router.refresh();
  }

  async function onGoogle() {
    setError(null);
    setBusy(true);
    try {
      const cred = await signInWithPopup(getFirebaseClientAuth(), googleProvider);
      const idToken = await cred.user.getIdToken();
      await postIdTokenAndRedirect(idToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function onEmailPassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(getFirebaseClientAuth(), email, password);
      const idToken = await cred.user.getIdToken();
      await postIdTokenAndRedirect(idToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6 rounded-lg border bg-background p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Sign in</h1>

      <button
        type="button"
        onClick={onGoogle}
        disabled={busy}
        className="w-full rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
      >
        Continue with Google
      </button>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">or</span>
        </div>
      </div>

      <form onSubmit={onEmailPassword} className="space-y-3">
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <p className="text-center text-sm text-muted-foreground">
        No account?{" "}
        <Link href="/sign-up" className="text-foreground underline">
          Create one
        </Link>
      </p>
    </div>
  );
}
