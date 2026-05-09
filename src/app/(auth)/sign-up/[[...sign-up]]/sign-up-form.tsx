"use client";

import { getFirebaseClientAuth, googleProvider } from "@/lib/firebase/client";
import { createUserWithEmailAndPassword, signInWithPopup } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export function SignUpForm() {
  const router = useRouter();
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
    router.push("/campaigns");
    router.refresh();
  }

  async function onGoogle() {
    setError(null);
    setBusy(true);
    try {
      // signInWithPopup with a fresh Google account creates the user
      // implicitly — Firebase Auth doesn't distinguish OAuth sign-up from
      // sign-in, both go through the same call.
      const cred = await signInWithPopup(getFirebaseClientAuth(), googleProvider);
      const idToken = await cred.user.getIdToken();
      await postIdTokenAndRedirect(idToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(
        getFirebaseClientAuth(),
        email,
        password,
      );
      const idToken = await cred.user.getIdToken();
      await postIdTokenAndRedirect(idToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6 rounded-lg border bg-background p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Create account</h1>

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

      <form onSubmit={onSubmit} className="space-y-3">
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
            autoComplete="new-password"
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">Minimum 6 characters.</p>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating account..." : "Create account"}
        </button>
      </form>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-foreground underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
