/**
 * service-worker.js
 * -----------------------------------------------------------------------
 * Two jobs:
 *  1. Basic PWA offline support — cache the app shell so Lunex opens
 *     instantly and still loads (to the login or last-seen chat shell)
 *     without a network connection.
 *  2. Firebase Cloud Messaging background handler — shows a system
 *     notification when a push arrives while the app/tab is closed or
 *     backgrounded.
 *
 * This file MUST live at the root of the deployed site (same folder as
 * index.html) so its default scope covers the whole app.
 * -----------------------------------------------------------------------
 */

const CACHE_NAME = "lunex-cache-v1";
const APP_SHELL = [
  "./",
  "index.html",
  "chat.html",
  "style.css",
  "app.js",
  "chat.js",
  "firebase.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

// ---- 1. INSTALL: pre-cache the app shell --------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ---- 2. ACTIVATE: clean up old cache versions ---------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ---- 3. FETCH: cache-first for app shell, network-first for everything
//        else (so Firestore/RTDB realtime calls are never served stale) --
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for the app shell; let all
  // Firebase/Firestore/RTDB/Storage network calls pass straight through.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() =>
        caches.match("index.html")
      );
    })
  );
});

// ---- 4. FIREBASE CLOUD MESSAGING: background push handler --------------
// Loaded via importScripts because service workers can't use the regular
// <script> tags from the HTML pages — they run in their own worker scope.
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

// IMPORTANT: keep this config in sync with firebase.js. Service workers
// cannot import your other JS files via regular <script> tags, so the
// config is duplicated here intentionally.
firebase.initializeApp({
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
});

const messaging = firebase.messaging();

// Fired when a push arrives and no Lunex tab is in the foreground.
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "Lunex";
  const body = (payload.notification && payload.notification.body) || "New message";

  self.registration.showNotification(title, {
    body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: "lunex-message",
    renotify: true,
    data: { url: "./chat.html" }
  });
});

// Tapping the notification should open (or focus) the chat.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./chat.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if (client.url.includes("chat.html") && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});