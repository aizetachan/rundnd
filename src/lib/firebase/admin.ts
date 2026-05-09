import { type App, cert, getApps, initializeApp } from "firebase-admin/app";
import { type Auth, getAuth } from "firebase-admin/auth";
import { type Firestore, getFirestore } from "firebase-admin/firestore";
import { type Storage, getStorage } from "firebase-admin/storage";

// Lazy singleton — same pattern as the previous getDb(). Module-load-time init
// breaks Next.js production builds (route handlers get imported during
// page-data collection before runtime env exists). First call during request
// handling is when credentials and Firestore client actually get touched.
let _app: App | undefined;
let _auth: Auth | undefined;
let _firestore: Firestore | undefined;
let _storage: Storage | undefined;

function ensureApp(): App {
  if (_app) return _app;

  // Reuse if Next HMR already initialized one (avoids "app already exists").
  const existing = getApps()[0];
  if (existing) {
    _app = existing;
    return _app;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "FIREBASE_PROJECT_ID not configured — check .env.local or Firebase App Hosting env",
    );
  }

  // Two credential modes:
  //   1. Local dev / explicit: GOOGLE_APPLICATION_CREDENTIALS points at the
  //      downloaded service account JSON. Admin SDK picks it up via
  //      applicationDefault().
  //   2. Firebase App Hosting: no service account file needed; the runtime
  //      provides ADC automatically via the attached service identity.
  // Both paths converge on applicationDefault().
  const inlineKey = process.env.FIREBASE_PRIVATE_KEY;
  const inlineEmail = process.env.FIREBASE_CLIENT_EMAIL;
  if (inlineKey && inlineEmail) {
    _app = initializeApp({
      projectId,
      credential: cert({
        projectId,
        clientEmail: inlineEmail,
        privateKey: inlineKey.replace(/\\n/g, "\n"),
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  } else {
    _app = initializeApp({
      projectId,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  }

  return _app;
}

export function getFirebaseAuth(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(ensureApp());
  return _auth;
}

export function getFirebaseFirestore(): Firestore {
  if (_firestore) return _firestore;
  _firestore = getFirestore(ensureApp());
  return _firestore;
}

export function getFirebaseStorage(): Storage {
  if (_storage) return _storage;
  _storage = getStorage(ensureApp());
  return _storage;
}
