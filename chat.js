/**
 * chat.js — Lunex Chat (Simplified & Error-Proof Version)
 */

(function () {
  "use strict";

  // =========================================================================
  // 1. SESSION CHECK
  // =========================================================================
  const myId = sessionStorage.getItem("lunex_user") || localStorage.getItem("lunex_user");

  if (!myId) {
    window.location.replace("index.html");
    return;
  }

  const USERS = {
    prashant: { id: "prashant", name: "Prashant", permanent: true },
    vaishnavi: { id: "vaishnavi", name: "Vaishnavi", permanent: false }
  };

  const ME = USERS[myId];
  const PEER_ID = myId === "prashant" ? "vaishnavi" : "prashant";
  const PEER = USERS[PEER_ID];

  if (!ME) {
    window.location.replace("index.html");
    return;
  }

  const { db, rtdb, auth, storage, serverTimestamp, rtdbServerTimestamp } = window.LunexFirebase;

  // =========================================================================
  // 2. DOM ELEMENTS
  // =========================================================================
  const bootSplash     = document.getElementById("boot-splash");
  const appRoot        = document.getElementById("chat-app");
  const peerAvatar     = document.getElementById("peer-avatar");
  const peerNameEl     = document.getElementById("peer-name");
  const statusDot      = document.getElementById("status-dot");
  const statusText     = document.getElementById("status-text");
  const logoutButton   = document.getElementById("logout-button");
  const messageList    = document.getElementById("message-list");
  const messagesLoad   = document.getElementById("messages-loading");
  const endAnchor      = document.getElementById("messages-end-anchor");
  const typingBar      = document.getElementById("typing-indicator");
  const typingText     = document.getElementById("typing-text");
  const messageInput   = document.getElementById("message-input");
  const sendButton     = document.getElementById("send-button");
  const emojiButton    = document.getElementById("emoji-button");
  const emojiPicker    = document.getElementById("emoji-picker");
  const attachButton   = document.getElementById("attach-button");
  const imageInput     = document.getElementById("image-input");
  const imageViewer    = document.getElementById("image-viewer");
  const imageViewerImg = document.getElementById("image-viewer-img");
  const viewerClose    = document.getElementById("image-viewer-close");
  const viewerDownload = document.getElementById("image-viewer-download");

  // =========================================================================
  // 3. SHOW APP (remove splash)
  // =========================================================================
  function showApp() {
    bootSplash.style.display = "none";
    appRoot.hidden = false;
  }

  // Header setup
  peerAvatar.textContent = PEER.name.charAt(0);
  peerNameEl.textContent = PEER.name;

  // =========================================================================
  // 4. PRESENCE
  // =========================================================================
  function initPresence() {
    try {
      const myRef   = rtdb.ref("status/" + myId);
      const peerRef = rtdb.ref("status/" + PEER_ID);
      const connRef = rtdb.ref(".info/connected");

      connRef.on("value", function(snap) {
        if (!snap.val()) return;
        myRef.onDisconnect().set({ state: "offline", lastChanged: rtdbServerTimestamp });
        myRef.set({ state: "online", lastChanged: rtdbServerTimestamp });
      });

      peerRef.on("value", function(snap) {
        var data = snap.val();
        var online = data && data.state === "online";
        statusDot.className = "status-dot " + (online ? "status-dot--online" : "status-dot--offline");
        statusText.textContent = online ? "Online" : "Offline";
      });
    } catch(e) {
      console.warn("Presence error:", e);
    }
  }

  // =========================================================================
  // 5. TYPING INDICATOR
  // =========================================================================
  var typingTimer = null;

  function setTyping(val) {
    try { rtdb.ref("typing/" + myId).set(val); } catch(e) {}
  }

  function listenTyping() {
    try {
      rtdb.ref("typing/" + PEER_ID).on("value", function(snap) {
        var t = snap.val() === true;
        typingBar.hidden = !t;
        typingText.textContent = PEER.name + " is typing\u2026";
      });
    } catch(e) {}
  }

  // =========================================================================
  // 6. MESSAGES
  // =========================================================================
  var renderedIds = {};
  var lastDay = null;

  function dayKey(d) { return d.toDateString(); }

  function fmtDay(d) {
    var today = new Date();
    var yest  = new Date(); yest.setDate(today.getDate() - 1);
    if (dayKey(d) === dayKey(today)) return "Today";
    if (dayKey(d) === dayKey(yest))  return "Yesterday";
    return d.toLocaleDateString(undefined, { day:"numeric", month:"long", year:"numeric" });
  }

  function fmtTime(d) {
    return d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
  }

  function tickHtml(status) {
    if (status === "sent") {
      return '<span class="tick" title="Sent"><svg width="14" height="10" viewBox="0 0 16 11" fill="none"><path d="M1 5.5L5 9.5L15 1" stroke="rgba(255,255,255,0.5)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    }
    if (status === "delivered") {
      return '<span class="tick" title="Delivered"><svg width="18" height="10" viewBox="0 0 20 11" fill="none"><path d="M1 5.5L5 9.5L15 1" stroke="rgba(255,255,255,0.5)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 5.5L9 9.5L19 1" stroke="rgba(255,255,255,0.5)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    }
    return '<span class="tick tick--read" title="Read"><svg width="18" height="10" viewBox="0 0 20 11" fill="none"><path d="M1 5.5L5 9.5L15 1" stroke="#53bdeb" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 5.5L9 9.5L19 1" stroke="#53bdeb" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  }

  function renderMessage(msg) {
    if (renderedIds[msg.id]) return;
    renderedIds[msg.id] = true;

    var isOut = msg.senderId === myId;
    var date  = msg.createdAt && msg.createdAt.toDate ? msg.createdAt.toDate() : new Date();

    // Day divider
    var dk = dayKey(date);
    if (dk !== lastDay) {
      lastDay = dk;
      var div = document.createElement("div");
      div.className = "day-divider";
      div.textContent = fmtDay(date);
      messageList.insertBefore(div, endAnchor);
    }

    // Row
    var row = document.createElement("div");
    row.className = "message-row " + (isOut ? "message-row--out" : "message-row--in");
    row.dataset.messageId = msg.id;

    // Bubble
    var bubble = document.createElement("div");
    bubble.className = "bubble " + (isOut ? "bubble--out" : "bubble--in");

    if (msg.type === "image" && msg.imageUrl) {
      bubble.classList.add("bubble--image");
      var img = document.createElement("img");
      img.className = "bubble-image";
      img.src = msg.imageUrl;
      img.alt = "Image";
      img.loading = "lazy";
      img.addEventListener("click", function() { openViewer(msg.imageUrl); });
      bubble.appendChild(img);
    } else {
      var p = document.createElement("p");
      p.className = "bubble-text";
      p.textContent = msg.text || "";
      bubble.appendChild(p);
    }

    // Meta (time + tick)
    var meta = document.createElement("div");
    meta.className = "bubble-meta";
    meta.innerHTML = '<span class="bubble-time">' + fmtTime(date) + '</span>' +
                     (isOut ? tickHtml(msg.status || "sent") : "");
    bubble.appendChild(meta);

    row.appendChild(bubble);
    messageList.insertBefore(row, endAnchor);
    scrollBottom();

    // Mark as read if incoming
    if (!isOut && msg.status !== "read") {
      db.collection("messages").doc(msg.id).update({ status: "read" }).catch(function() {});
    }
  }

  function updateTick(msg) {
    var row = messageList.querySelector('[data-message-id="' + msg.id + '"]');
    if (!row || msg.senderId !== myId) return;
    var meta = row.querySelector(".bubble-meta");
    if (!meta) return;
    var date = msg.createdAt && msg.createdAt.toDate ? msg.createdAt.toDate() : new Date();
    meta.innerHTML = '<span class="bubble-time">' + fmtTime(date) + '</span>' + tickHtml(msg.status || "sent");
  }

  function scrollBottom() {
    requestAnimationFrame(function() {
      messageList.scrollTop = messageList.scrollHeight;
    });
  }

  function startMessages() {
    db.collection("messages")
      .orderBy("createdAt", "asc")
      .onSnapshot(function(snap) {
        if (messagesLoad) messagesLoad.remove();
        snap.docChanges().forEach(function(change) {
          var msg = Object.assign({ id: change.doc.id }, change.doc.data());
          if (change.type === "added")    renderMessage(msg);
          if (change.type === "modified") updateTick(msg);
        });
      }, function(err) {
        console.error("Messages error:", err);
        if (messagesLoad) messagesLoad.textContent = "Error loading messages: " + err.message;
      });
  }

  // =========================================================================
  // 7. SEND MESSAGE
  // =========================================================================
  function sendText() {
    var text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = "";
    sendButton.disabled = true;
    autoGrow();
    setTyping(false);
    clearTimeout(typingTimer);

    db.collection("messages").add({
      senderId:   myId,
      receiverId: PEER_ID,
      type:       "text",
      text:       text,
      status:     "sent",
      createdAt:  serverTimestamp()
    }).catch(function(err) {
      console.error("Send failed:", err);
      alert("Message nahi gaya: " + err.message);
    });
  }

  function sendImage(file) {
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function(e) {
      var imageUrl = e.target.result;

      if (storage) {
        var ref = storage.ref("chat-images/" + myId + "_" + Date.now() + "_" + file.name);
        ref.put(file).then(function() {
          return ref.getDownloadURL();
        }).then(function(url) {
          return db.collection("messages").add({
            senderId: myId, receiverId: PEER_ID,
            type: "image", imageUrl: url,
            status: "sent", createdAt: serverTimestamp()
          });
        }).catch(function() {
          // Storage fail — fallback to base64
          db.collection("messages").add({
            senderId: myId, receiverId: PEER_ID,
            type: "image", imageUrl: imageUrl,
            status: "sent", createdAt: serverTimestamp()
          });
        });
      } else {
        db.collection("messages").add({
          senderId: myId, receiverId: PEER_ID,
          type: "image", imageUrl: imageUrl,
          status: "sent", createdAt: serverTimestamp()
        });
      }
    };
    reader.readAsDataURL(file);
  }

  // =========================================================================
  // 8. IMAGE VIEWER
  // =========================================================================
  function openViewer(url) {
    imageViewerImg.src = url;
    viewerDownload.href = url;
    imageViewer.hidden = false;
  }

  function closeViewer() {
    imageViewer.hidden = true;
    imageViewerImg.src = "";
  }

  // =========================================================================
  // 9. EMOJI PICKER
  // =========================================================================
  var EMOJIS = [
    "😀","😁","😂","🤣","😊","😍","😘","😉","😎","🤔",
    "😢","😭","😡","😱","😴","🥳","🤗","🙄","😅","😇",
    "👍","👎","👏","🙏","🙌","💪","🤝","👋","✌️","🤞",
    "❤️","💕","💔","🔥","✨","🎉","🎂","🌹","⭐","☀️",
    "🌙","☕","🍕","🍫","🍓","🥰","😋","🤤","😏","😬",
    "🤩","😜","🫶","💯","✅","❌","⏰","📷","🎵","💬"
  ];

  function buildEmoji() {
    EMOJIS.forEach(function(e) {
      var btn = document.createElement("button");
      btn.className = "emoji-option";
      btn.type = "button";
      btn.textContent = e;
      btn.addEventListener("click", function() {
        messageInput.value += e;
        messageInput.focus();
        sendButton.disabled = messageInput.value.trim().length === 0;
      });
      emojiPicker.appendChild(btn);
    });
  }

  // =========================================================================
  // 10. AUTO GROW TEXTAREA
  // =========================================================================
  function autoGrow() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  }

  // =========================================================================
  // 11. LOGOUT
  // =========================================================================
  function logout() {
    setTyping(false);
    try { rtdb.ref("status/" + myId).set({ state: "offline", lastChanged: rtdbServerTimestamp }); } catch(e) {}

    if (!ME.permanent) {
      sessionStorage.clear();
      localStorage.removeItem("lunex_user");
      if (window.caches) {
        caches.keys().then(function(keys) {
          keys.forEach(function(k) { caches.delete(k); });
        });
      }
    } else {
      localStorage.removeItem("lunex_user");
      sessionStorage.removeItem("lunex_user");
    }

    auth.signOut().finally(function() {
      window.location.replace("index.html");
    });
  }

  // =========================================================================
  // 12. BIND EVENTS
  // =========================================================================
  function bindEvents() {
    messageInput.addEventListener("input", function() {
      sendButton.disabled = messageInput.value.trim().length === 0;
      autoGrow();
      setTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function() { setTyping(false); }, 1500);
    });

    messageInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendText();
      }
    });

    sendButton.addEventListener("click", sendText);

    emojiButton.addEventListener("click", function() {
      emojiPicker.hidden = !emojiPicker.hidden;
    });

    attachButton.addEventListener("click", function() { imageInput.click(); });
    imageInput.addEventListener("change", function(e) {
      sendImage(e.target.files[0]);
      imageInput.value = "";
    });

    viewerClose.addEventListener("click", closeViewer);
    imageViewer.addEventListener("click", function(e) {
      if (e.target === imageViewer) closeViewer();
    });

    logoutButton.addEventListener("click", function() {
      if (confirm("Log out karein?")) logout();
    });
  }

  // =========================================================================
  // 13. BOOT
  // =========================================================================
  function boot() {
    bindEvents();
    buildEmoji();
    initPresence();
    listenTyping();
    startMessages();
    showApp();
  }

  // Auth check — show app as soon as Firebase confirms user is logged in
  auth.onAuthStateChanged(function(user) {
    if (user) {
      boot();
    } else {
      // Firebase auth lost — wapis login
      window.location.replace("index.html");
    }
  });

})();
