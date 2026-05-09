"use client";

import { getFirebaseClientAuth } from "@/lib/firebase/client";
import { onAuthStateChanged } from "firebase/auth";
import posthog from "posthog-js";
import { useEffect } from "react";

/**
 * Mirrors Firebase auth state into PostHog. Subscribes to onAuthStateChanged
 * so identify/reset fires whenever sign-in/sign-out happens, not just on
 * mount.
 */
export function PostHogIdentify() {
  useEffect(() => {
    const unsub = onAuthStateChanged(getFirebaseClientAuth(), (user) => {
      if (!posthog.__loaded) return;
      if (user) {
        posthog.identify(user.uid, {
          email: user.email ?? undefined,
        });
      } else {
        posthog.reset();
      }
    });
    return unsub;
  }, []);

  return null;
}
