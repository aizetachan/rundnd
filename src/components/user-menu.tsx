"use client";

import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { onAuthStateChanged, signOut } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Drop-in replacement for Clerk's <UserButton />. Shows the user's email
 * and a sign-out / spending-cap menu. Minimal — no avatar UI yet.
 */
export function UserMenu() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(getFirebaseClientAuth(), (u) => {
      setEmail(u?.email ?? null);
    });
    return unsub;
  }, []);

  async function onSignOut() {
    await signOut(getFirebaseClientAuth());
    await fetch("/api/auth/signout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  if (!email) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
      >
        {email}
      </button>
      {open ? (
        <div className="absolute right-0 mt-1 w-48 rounded-md border bg-background py-1 shadow-md">
          <Link
            href="/account/spending"
            className="block px-3 py-2 text-sm hover:bg-accent"
            onClick={() => setOpen(false)}
          >
            Spending cap
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
