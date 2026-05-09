import { clientEnv } from "@/lib/client-env";
import { type FirebaseApp, getApps, initializeApp } from "firebase/app";
import {
  type Auth,
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from "firebase/auth";

// Browser-side Firebase singleton. Only NEXT_PUBLIC_* values reach the client
// (they are public by design — Firebase docs are explicit that these are not
// secrets; security lives in Firestore rules + Auth, not in hiding the API key).
//
// Lazy because Next.js renders Server Components on the server too, and this
// module can be imported there even when the actual init only matters
// browser-side. Touching firebase/app at module top would error in SSR if
// client-env values are not inlined.
let _app: FirebaseApp | undefined;
let _auth: Auth | undefined;

function getConfig() {
  return {
    apiKey: clientEnv.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: clientEnv.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: clientEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: clientEnv.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: clientEnv.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: clientEnv.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

export function getFirebaseClientApp(): FirebaseApp {
  if (_app) return _app;
  const existing = getApps()[0];
  if (existing) {
    _app = existing;
    return _app;
  }
  _app = initializeApp(getConfig());
  return _app;
}

export function getFirebaseClientAuth(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(getFirebaseClientApp());
  // Persist sessions across reloads. Without this, sign-in evaporates on tab close.
  void setPersistence(_auth, browserLocalPersistence);
  return _auth;
}

export const googleProvider = new GoogleAuthProvider();
