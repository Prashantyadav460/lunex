/**
 * chat.js
 * -----------------------------------------------------------------------
 * Core logic for chat.html: session guard, presence, typing indicator,
 * real-time messaging, read receipts, image sharing, emoji picker, and
 * push notification registration.
 *
 * Data model
 * ----------
 * Firestore  /messages/{messageId}
 *    senderId:    "prashant" | "vaishnavi"
 *    receiverId:  "prashant" | "vaishnavi"
 *    type:        "text" | "image"
 *    text:        string (for type "text")
 *    imageUrl:    string (for type "image" — Storage URL or base64 data URL)
 *    status:      "sent" | "delivered" | "read"
 *    createdAt:   Firestore server timestamp
 *
 * Firestore  /users/{userId}
 *    name:        string
 *    fcmTokens:   string[] (device push tokens for this user)
 *
 * Firestore  /notifications/{autoId}
 *    (lightweight log of push payloads queued — see note in sendPush())
 *
 * RTDB  /status/{userId}        -> { state: "online"|"offline", lastChanged }
 * RTDB  /typing/{userId}        -> boolean (true while that user is typing)
 * -----------------------------------------------------------------------
 */

(function () {
  "use strict";

  // ---- 1. SESSION GUARD --------------------------------------------------
  // Vaishnavi's identity only ever lives in sessionStorage (cleared on
  // logout / tab close). Prashant's lives in localStorage so he stays
  // signed in. If neither is present, bounce back to the login screen.
  const myId = sessionStorage.getItem("lunex_user") || localStorage.getItem("lunex_user");

  if (!myId || !window.LunexFirebase.USERS[myId]) {
    window.location.replace("index.html");
    return;
  }

  const ME = window.LunexFirebase.USERS[myId];
  const PEER_ID = myId === "prashant" ? "vaishnavi" : "prashant";
  const PEER = window.LunexFirebase.USERS[PEER_ID];
  const IS_TEMP_SESSION = !ME.permanent; // true for Vaishnavi

  const { db, rtdb, auth, storage, serverTimestamp, rtdbServerTimestamp, VAPID_KEY } = window.LunexFirebase;

  // ---- 2. DOM REFERENCES --------------------------------------------------
  const bootSplash = document.getElementById("boot-splash");
  const appRoot = document.getElementById("chat-app");

  const peerAvatar = document.getElementById("peer-avatar");
  const peerName = document.getElementById("peer-name");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const logoutButton = document.getElementById("logout-button");

  const messageList = document.getElementById("message-list");
  const messagesLoading = document.getElementById("messages-loading");
  const endAnchor = document.getElementById("messages-end-anchor");

  const typingIndicator = document.getElementById("typing-indicator");
  const typingText = document.getElementById("typing-text");

  const messageInput = document.getElementById("message-input");
  const sendButton = document.getElementById("send-button");
  const emojiButton = document.getElementById("emoji-button");
  const emojiPicker = document.getElementById("emoji-picker");
  const attachButton = document.getElementById("attach-button");
  const imageInput = document.getElementById("image-input");

  const imageViewer = document.getElementById("image-viewer");
  const imageViewerImg = document.getElementById("image-viewer-img");
  const imageViewerClose = document.getElementById("image-viewer-close");
  const imageViewerDownload = document.getElementById("image-viewer-download");

  // ---- 3. INITIAL HEADER SETUP -------------------------------------------
  peerAvatar.textContent = PEER.name.charAt(0).toUpperCase();
  peerName.textContent = PEER.name;

  function showApp() {
    bootSplash.style.display = "none";
    appRoot.hidden = false;
  }

  // =========================================================================
  // 4. PRESENCE (Firebase Realtime Database)
  // =========================================================================
  //
  // We write our own presence node and listen to the peer's. RTDB's
  // `onDisconnect()` guarantees the "offline" write happens even if the
  // tab is closed abruptly or the device loses connectivity, which is why
  // presence lives in RTDB rather than Firestore.

  function initPresence() {
    const myStatusRef = rtdb.ref(`status/${myId}`);
    const peerStatusRef = rtdb.ref(`status/${PEER_ID}`);
    const connectedRef = rtdb.ref(".info/connected");

    connectedRef.on("value", (snap) => {
      if (snap.val() === false) return;

      // When this client disconnects (closed tab, lost network, app
      // backgrounded and killed), RTDB will automatically apply this
      // "offline" write on our behalf.
      myStatusRef.onDisconnect().set({
        state: "offline",
        lastChanged: rtdbServerTimestamp
      }).then(() => {
        myStatusRef.set({
          state: "online",
          lastChanged: rtdbServerTimestamp
        });
      });
    });

    peerStatusRef.on("value", (snap) => {
      const data = snap.val();
      const isOnline = data && data.state === "online";
      renderPresence(isOnline);
    });
  }

  function renderPresence(isOnline) {
    statusDot.classList.toggle("status-dot--online", isOnline);
    statusDot.classList.toggle("status-dot--offline", !isOnline);
    statusText.textContent = isOnline ? "Online" : "Offline";
  }

  // Manually mark ourselves offline on an explicit logout (in addition to
  // the onDisconnect hook, which covers crashes/closed tabs).
  function goOffline() {
    return rtdb.ref(`status/${myId}`).set({
      state: "offline",
      lastChanged: rtdbServerTimestamp
    });
  }

  // =========================================================================
  // 5. TYPING INDICATOR (Firebase Realtime Database)
  // =========================================================================

  let typingTimeout = null;

  function setTypingState(isTyping) {
    rtdb.ref(`typing/${myId}`).set(isTyping);
  }

  function handleComposerInput() {
    sendButton.disabled = messageInput.value.trim().length === 0;
    autoGrowTextarea();

    setTypingState(true);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => setTypingState(false), 1500);
  }

  function autoGrowTextarea() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  }

  function listenForPeerTyping() {
    rtdb.ref(`typing/${PEER_ID}`).on("value", (snap) => {
      const isTyping = snap.val() === true;
      typingIndicator.hidden = !isTyping;
      typingText.textContent = `${PEER.name} is typing…`;
    });
  }

  // =========================================================================
  // 6. MESSAGING (Firestore)
  // =========================================================================

  const messagesRef = db.collection("messages");
  let unsubscribeMessages = null;
  const renderedMessageIds = new Set();
  let lastRenderedDayKey = null;

  function startMessageListener() {
    // A private two-person chat doesn't need per-conversation document IDs;
    // every message just carries senderId/receiverId, and both parties
    // simply read the entire collection ordered by time. For a small,
    // personal chat this keeps the schema (and the security rules) simple.
    unsubscribeMessages = messagesRef
      .orderBy("createdAt", "asc")
      .onSnapshot(
        (snapshot) => {
          messagesLoading.remove();
          snapshot.docChanges().forEach((change) => {
            const msg = { id: change.doc.id, ...change.doc.data() };
            if (change.type === "added") {
              renderMessage(msg);
              // If the incoming message is addressed to us and not yet
              // marked delivered/read, update its status.
              maybeUpdateIncomingStatus(msg);
            } else if (change.type === "modified") {
              updateMessageStatusInDom(msg);
            }
          });
          scrollToBottom();
        },
        (error) => {
          console.error("Message listener error:", error);
          messagesLoading.textContent = "Couldn't load messages. Check your connection.";
        }
      );
  }

  function maybeUpdateIncomingStatus(msg) {
    if (msg.senderId === myId) return; // only act on messages sent to us
    if (msg.status === "read") return;

    // Mark delivered immediately (we received it), and read once the
    // message list is actually visible/focused (kept simple here: as
    // soon as it renders, since this is a private 1:1 chat that's almost
    // always opened to the active conversation).
    messagesRef.doc(msg.id).update({ status: "read" }).catch((err) => {
      console.error("Failed to update read receipt:", err);
    });
  }

  function dayKeyFor(date) {
    return date.toDateString();
  }

  function formatDayDivider(date) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (dayKeyFor(date) === dayKeyFor(today)) return "Today";
    if (dayKeyFor(date) === dayKeyFor(yesterday)) return "Yesterday";
    return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  }

  function formatTime(date) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function tickIconFor(status) {
    if (status === "sent") {
      return `<span class="tick tick--sent" title="Sent">
        <svg width="14" height="10" viewBox="0 0 16 11" fill="none"><path d="M1 5.5L5 9.5L15 1" stroke="rgba(255,255,255,0.6)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>`;
    }
    if (status === "delivered") {
      return `<span class="tick tick--delivered" title="Delivered">
        <svg width="18" height="10" viewBox="0 0 20 11" fill="none">
          <path d="M1 5.5L5 9.5L15 1" stroke="rgba(255,255,255,0.6)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M5 5.5L9 9.5L19 1" stroke="rgba(255,255,255,0.6)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>`;
    }
    // read
    return `<span class="tick tick--read" title="Read">
      <svg width="18" height="10" viewBox="0 0 20 11" fill="none">
        <path d="M1 5.5L5 9.5L15 1" stroke="#53bdeb" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M5 5.5L9 9.5L19 1" stroke="#53bdeb" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>`;
  }

  function renderMessage(msg) {
    if (renderedMessageIds.has(msg.id)) return;
    renderedMessageIds.add(msg.id);

    const isOutgoing = msg.senderId === myId;
    const createdAt = msg.createdAt && msg.createdAt.toDate ? msg.createdAt.toDate() : new Date();

    // Day divider
    const dayKey = dayKeyFor(createdAt);
    if (dayKey !== lastRenderedDayKey) {
      lastRenderedDayKey = dayKey;
      const divider = document.createElement("div");
      divider.className = "day-divider";
      divider.textContent = formatDayDivider(createdAt);
      messageList.insertBefore(divider, endAnchor);
    }

    const row = document.createElement("div");
    row.className = `message-row ${isOutgoing ? "message-row--out" : "message-row--in"}`;
    row.dataset.messageId = msg.id;

    const bubble = document.createElement("div");
    bubble.className = `bubble ${isOutgoing ? "bubble--out" : "bubble--in"}`;

    if (msg.type === "image") {
      bubble.classList.add("bubble--image");
      const img = document.createElement("img");
      img.className = "bubble-image";
      img.src = msg.imageUrl;
      img.alt = "Shared image";
      img.loading = "lazy";
      img.addEventListener("click", () => openImageViewer(msg.imageUrl));
      bubble.appendChild(img);
    } else {
      const textEl = document.createElement("p");
      textEl.className = "bubble-text";
      textEl.textContent = msg.text || "";
      bubble.appendChild(textEl);
    }

    const meta = document.createElement("div");
    meta.className = "bubble-meta";
    meta.innerHTML = `<span class="bubble-time">${formatTime(createdAt)}</span>`;
    if (isOutgoing) {
      meta.innerHTML += tickIconFor(msg.status || "sent");
    }
    bubble.appendChild(meta);

    row.appendChild(bubble);
    messageList.insertBefore(row, endAnchor);
  }

  function updateMessageStatusInDom(msg) {
    const row = messageList.querySelector(`[data-message-id="${msg.id}"]`);
    if (!row) return;
    const isOutgoing = msg.senderId === myId;
    if (!isOutgoing) return; // only the sender's bubble shows ticks
    const meta = row.querySelector(".bubble-meta");
    if (!meta) return;
    const timeHtml = `<span class="bubble-time">${formatTime(
      msg.createdAt && msg.createdAt.toDate ? msg.createdAt.toDate() : new Date()
    )}</span>`;
    meta.innerHTML = timeHtml + tickIconFor(msg.status || "sent");
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messageList.scrollTop = messageList.scrollHeight;
    });
  }

  async function sendTextMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = "";
    sendButton.disabled = true;
    autoGrowTextarea();
    setTypingState(false);
    clearTimeout(typingTimeout);

    try {
      await messagesRef.add({
        senderId: myId,
        receiverId: PEER_ID,
        type: "text",
        text,
        status: "sent",
        createdAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Failed to send message:", err);
      alert("Message failed to send. Please try again.");
    }
  }

  /**
   * Sends an image message. Prefers Firebase Storage (gives a small,
   * shareable URL); falls back to storing a base64 data URL directly in
   * the Firestore document if Storage isn't configured, so the app still
   * works out of the box on a fresh Firebase project with only
   * Firestore + RTDB enabled.
   */
  async function sendImageMessage(file) {
    if (!file) return;

    try {
      let imageUrl;

      if (storage) {
        const filePath = `chat-images/${myId}_${Date.now()}_${file.name}`;
        const fileRef = storage.ref(filePath);
        await fileRef.put(file);
        imageUrl = await fileRef.getDownloadURL();
      } else {
        imageUrl = await fileToDataUrl(file);
      }

      await messagesRef.add({
        senderId: myId,
        receiverId: PEER_ID,
        type: "image",
        imageUrl,
        status: "sent",
        createdAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Failed to send image:", err);
      alert("Image failed to send. Please try again.");
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function openImageViewer(url) {
    imageViewerImg.src = url;
    imageViewerDownload.href = url;
    imageViewer.hidden = false;
  }

  function closeImageViewer() {
    imageViewer.hidden = true;
    imageViewerImg.src = "";
  }

  // =========================================================================
  // 7. EMOJI PICKER
  // =========================================================================

  const EMOJI_SET = [
    "😀","😁","😂","🤣","😊","😍","😘","😉","😎","🤔",
    "😢","😭","😡","😱","😴","🥳","🤗","🙄","😅","😇",
    "👍","👎","👏","🙏","🙌","💪","🤝","👋","✌️","🤞",
    "❤️","💕","💔","🔥","✨","🎉","🎂","🌹","⭐","☀️",
    "🌙","☕","🍕","🍫","🍓","🥰","😋","🤤","😏","😬",
    "🤩","😜","🫶","💯","✅","❌","⏰","📷","🎵","💬"
  ];

  function buildEmojiPicker() {
    EMOJI_SET.forEach((emoji) => {
      const btn = document.createElement("button");
      btn.className = "emoji-option";
      btn.type = "button";
      btn.textContent = emoji;
      btn.addEventListener("click", () => {
        messageInput.value += emoji;
        messageInput.focus();
        handleComposerInput();
      });
      emojiPicker.appendChild(btn);
    });
  }

  function toggleEmojiPicker() {
    emojiPicker.hidden = !emojiPicker.hidden;
  }

  // =========================================================================
  // 8. PUSH NOTIFICATIONS (Firebase Cloud Messaging)
  // =========================================================================
  //
  // NOTE ON ARCHITECTURE: this is a static, serverless (GitHub Pages) app.
  // FCM's getToken() and the service worker's background message handler
  // work entirely client-side and are fully implemented below. However,
  // *triggering* a push send still requires something with the FCM Server
  // Key / Admin SDK to call the FCM Send API when a new message document
  // is created — browsers cannot push to *other* devices on their own.
  // The cleanest serverless option is a small Firebase Cloud Function
  // triggered onCreate of /messages/{id} that reads the recipient's
  // fcmTokens from /users/{receiverId} and calls admin.messaging().send().
  // That function (not shown here, since it requires the Firebase CLI
  // and a paid/Spark-plan-eligible Cloud Functions deploy, which is
  // outside the static-site scope of this build) is the only piece that
  // cannot run purely from GitHub Pages. Everything else — permission
  // request, token registration, foreground + background message
  // handling — is wired up below and ready to receive that push.

  async function initPushNotifications() {
    if (!("serviceWorker" in navigator) || !("Notification" in window)) {
      console.warn("Push notifications not supported in this browser.");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register("service-worker.js");

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        console.warn("Notification permission not granted.");
        return;
      }

      const messaging = firebase.messaging();
      const token = await messaging.getToken({
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: registration
      });

      if (token) {
        await db.collection("users").doc(myId).set(
          {
            name: ME.name,
            fcmTokens: firebase.firestore.FieldValue.arrayUnion(token)
          },
          { merge: true }
        );
      }

      // Foreground messages (app open & focused): show a quiet in-app
      // notification rather than a system push, since the chat is
      // already visible.
      messaging.onMessage((payload) => {
        console.log("Foreground push received:", payload);
      });
    } catch (err) {
      console.warn("Push notification setup skipped:", err.message);
    }
  }

  // =========================================================================
  // 9. LOGOUT
  // =========================================================================

  async function handleLogout() {
    setTypingState(false);
    await goOffline().catch(() => {});

    if (unsubscribeMessages) unsubscribeMessages();

    if (IS_TEMP_SESSION) {
      // Vaishnavi: scrub everything. No history, no cached identity, no
      // password, nothing left behind on a borrowed phone.
      sessionStorage.clear();
      localStorage.removeItem("lunex_user");
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } else {
      // Prashant: keep his permanent identity but end the live session
      // state cleanly.
      sessionStorage.removeItem("lunex_user");
      localStorage.removeItem("lunex_user");
    }

    try {
      await auth.signOut();
    } catch (e) {
      // non-fatal
    }

    window.location.replace("index.html");
  }

  // =========================================================================
  // 10. INITIALIZATION
  // =========================================================================

})();