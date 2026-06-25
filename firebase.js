/**
 * firebase.js
 * -----------------------------------------------------------------------
 * Central Firebase initialization for Lunex.
 *
 * This file is loaded as a plain <script> (not a module) on every page so
 * that index.html and chat.html can both rely on a single global
 * `window.LunexFirebase` object. It uses the Firebase compat SDK (loaded
 * via <script> tags from the CDN in each HTML file) because compat builds
 * work directly from `file://` and GitHub Pages without a bundler.
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://console.firebase.google.com and create a project.
 * 2. Enable: Firestore Database, Realtime Database, Cloud Messaging,
 *    Storage (for images), and Authentication -> Sign-in method -> Anonymous.
 * 3. Copy your project's config object into FIREBASE_CONFIG below.
 * 4. Generate a Web Push certificate (FCM) under Project Settings ->
 *    Cloud Messaging -> Web configuration, and paste the "Key pair" value
 *    into VAPID_KEY below.
 * 5. Deploy the security rules found in firestore.rules / database.rules.json
 *    (see comments at the bottom of this file) to your Firebase project.
 * -----------------------------------------------------------------------
 */

// -------------------------------------------------------------------------
// 1. YOUR FIREBASE PROJECT CONFIG
//    Replace every value below with the config shown in:
//    Firebase Console -> Project Settings -> General -> Your apps -> SDK setup
// -------------------------------------------------------------------------
const FIREBASE_CONFIG = {
   apiKey: "AIzaSyB2A4-bbgjCBGvKUl3iXPXQS2wA63tu2rU",
  authDomain: "lunix-653e1.firebaseapp.com",
  projectId: "lunix-653e1",
  storageBucket: "lunix-653e1.firebasestorage.app",
  messagingSenderId: "201666663625",
  appId: "1:201666663625:web:0fc626038e4ca912b7a918",
  measurementId: "G-TP1SZBPSZJ"
};


// VAPID key for Web Push (Cloud Messaging). Required for getToken() to work.
const VAPID_KEY = "YOUR_VAPID_KEY";

// -------------------------------------------------------------------------
// 2. ACCESS KEY (single shared password gate)
//    Change this to your own secret before deploying. Because this file is
//    public on GitHub Pages, treat this as a "lock the front door" deterrent
//    rather than a cryptographic guarantee — real protection comes from the
//    Firestore/RTDB security rules, which check request.auth, not this key.
// -------------------------------------------------------------------------
const LUNEX_ACCESS_KEY = "lunex-secret-2026";

// Map of which display name maps to which internal user id.
// "prashant" is the permanent identity; "vaishnavi" is the temporary one.
const LUNEX_USERS = {
  prashant: { id: "prashant", name: "Prashant", permanent: true },
  vaishnavi: { id: "vaishnavi", name: "Vaishnavi", permanent: false }
};

// -------------------------------------------------------------------------
// 3. INITIALIZE FIREBASE (compat SDK — loaded via <script> in HTML head)
// -------------------------------------------------------------------------
firebase.initializeApp(FIREBASE_CONFIG);

const auth = firebase.auth();
const db = firebase.firestore();
const rtdb = firebase.database();

// Storage is optional — only needed if you wire up Firebase Storage for
// image uploads instead of base64-in-Firestore (see chat.js for the
// default approach, which keeps the app fully client-side-deployable).
let storage = null;
try {
  storage = firebase.storage();
} catch (e) {
  // Storage SDK not loaded / not enabled — image upload will fall back
  // to inline base64 storage in Firestore. See chat.js sendImageMessage().
  console.warn("Firebase Storage not available, falling back to base64 image storage.");
}

// Enable offline persistence for Firestore so the chat still renders
// instantly on slow connections / repeat visits.
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  if (err.code === "failed-precondition") {
    // Multiple tabs open without synchronizeTabs support — non-fatal.
    console.warn("Firestore persistence unavailable: multiple tabs open.");
  } else if (err.code === "unimplemented") {
    console.warn("Firestore persistence unavailable in this browser.");
  }
});

// -------------------------------------------------------------------------
// 4. EXPORT a small, explicit surface for the rest of the app to use.
//    Everything is attached to window.LunexFirebase so index.html / chat.html
//    can use it without ES module bundling (keeps GitHub Pages deploy trivial).
// -------------------------------------------------------------------------
window.LunexFirebase = {
  app: firebase.app(),
  auth,
  db,
  rtdb,
  storage,
  VAPID_KEY,
  ACCESS_KEY: LUNEX_ACCESS_KEY,
  USERS: LUNEX_USERS,
  // Firestore server timestamp helper, used everywhere we write a message.
  serverTimestamp: firebase.firestore.FieldValue.serverTimestamp,
  // RTDB server timestamp helper, used for presence "lastSeen".
  rtdbServerTimestamp: firebase.database.ServerValue.TIMESTAMP
};

/**
 * -----------------------------------------------------------------------
 * SECURITY RULES (deploy these in the Firebase Console, not part of the
 * static site bundle). Included here as documentation.
 * -----------------------------------------------------------------------
 *
 * --- Firestore rules (firestore.rules) ---
 *
 * rules_version = '2';
 * service cloud.firestore {
 *   match /databases/{database}/documents {
 *
 *     // Only the two signed-in (anonymous-auth) clients of this app may
 *     // read or write anything. Every authenticated user can read all
 *     // messages because this is a private two-person chat.
 *     match /messages/{messageId} {
 *       allow read: if request.auth != null;
 *       allow create: if request.auth != null
 *                     && request.resource.data.senderId in ['prashant', 'vaishnavi'];
 *       allow update: if request.auth != null; // for read-receipt status updates
 *       allow delete: if false; // messages are never deleted, only the UI hides them
 *     }
 *
 *     match /users/{userId} {
 *       allow read: if request.auth != null;
 *       allow write: if request.auth != null && userId in ['prashant', 'vaishnavi'];
 *     }
 *
 *     match /notifications/{tokenId} {
 *       allow read: if request.auth != null;
 *       allow write: if request.auth != null;
 *     }
 *   }
 * }
 *
 * --- Realtime Database rules (database.rules.json) ---
 *
 * {
 *   "rules": {
 *     "status": {
 *       ".read": "auth != null",
 *       "$uid": {
 *         ".write": "auth != null"
 *       }
 *     },
 *     "typing": {
 *       ".read": "auth != null",
 *       "$uid": {
 *         ".write": "auth != null"
 *       }
 *     }
 *   }
 * }
 *
 * Note: since this app uses one anonymous-auth identity per *device*
 * (not per real Firebase user matching "prashant"/"vaishnavi" exactly),
 * the rules above intentionally allow any authenticated client to write
 * presence/typing/messages — the access-key gate in index.html is what
 * keeps random visitors from ever reaching chat.html in the first place.
 * For stricter protection, replace anonymous auth with Firebase Auth
 * custom tokens minted by a small Cloud Function that checks the access
 * key server-side.
 */