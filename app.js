/**
 * app.js
 * -----------------------------------------------------------------------
 * Logic for the login screen (index.html).
 *
 * Flow:
 *  1. User types the shared access key and submits the form.
 *  2. If it matches LUNEX_ACCESS_KEY, we ask "which person are you?" only
 *     the first time on a given device (after that we remember a sticky
 *     choice for Prashant's permanent device, but always ask Vaishnavi's
 *     device fresh since her sessions must never persist).
 *  3. We sign in anonymously to Firebase (so security rules can require
 *     request.auth != null) and store the chosen identity:
 *       - Prashant  -> localStorage  (persists across browser restarts)
 *       - Vaishnavi -> sessionStorage (wiped when the tab/browser closes,
 *                                       and explicitly wiped on logout)
 *  4. Redirect to chat.html.
 * -----------------------------------------------------------------------
 */

(function () {
  "use strict";

  const form = document.getElementById("login-form");
  const input = document.getElementById("access-key");
  const errorEl = document.getElementById("auth-error");
  const button = document.getElementById("login-button");
  const buttonText = document.getElementById("login-button-text");

  // If a valid session already exists, skip straight to chat.
  const existingUser = sessionStorage.getItem("lunex_user") || localStorage.getItem("lunex_user");
  if (existingUser) {
    window.location.replace("chat.html");
    return;
  }

  function setLoading(isLoading) {
    button.disabled = isLoading;
    buttonText.textContent = isLoading ? "Unlocking…" : "Unlock";
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    input.classList.add("field-input--error");
    input.focus();
    input.select();
  }

  function clearError() {
    errorEl.hidden = true;
    input.classList.remove("field-input--error");
  }

  /**
   * Presents a tiny, dependency-free identity picker once the access key
   * has been verified. Returns a Promise resolving to "prashant" or
   * "vaishnavi".
   */
  function pickIdentity() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "identity-overlay";
      overlay.innerHTML = `
        <div class="identity-card">
          <p class="identity-title">Who's signing in?</p>
          <button class="identity-option" data-id="prashant">Prashant</button>
          <button class="identity-option" data-id="vaishnavi">Vaishnavi</button>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.querySelectorAll(".identity-option").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-id");
          overlay.remove();
          resolve(id);
        });
      });
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    clearError();

    const enteredKey = input.value.trim();
    if (!enteredKey) return;

    if (enteredKey !== window.LunexFirebase.ACCESS_KEY) {
      showError("Incorrect access key. Try again.");
      return;
    }

    setLoading(true);

    try {
      const userId = await pickIdentity();
      const userInfo = window.LunexFirebase.USERS[userId];
      if (!userInfo) {
        showError("Unknown user. Contact the admin.");
        setLoading(false);
        return;
      }

      // Sign in anonymously so Firestore/RTDB security rules see a real
      // authenticated request. Each device gets its own anonymous uid;
      // the *app-level* identity (prashant/vaishnavi) is what the chat
      // UI and Firestore documents key off of.
      await window.LunexFirebase.auth.signInAnonymously();

      // Persist the chosen identity according to the role's rules.
      if (userInfo.permanent) {
        localStorage.setItem("lunex_user", userInfo.id);
      } else {
        // Vaishnavi: never touch localStorage, and make sure no stale
        // permanent-storage copy exists from a previous mistake.
        localStorage.removeItem("lunex_user");
        sessionStorage.setItem("lunex_user", userInfo.id);
      }

      window.location.replace("chat.html");
    } catch (err) {
      console.error("Login failed:", err);
      showError("Couldn't connect. Check your internet and try again.");
      setLoading(false);
    }
  }

  form.addEventListener("submit", handleLogin);
  input.addEventListener("input", clearError);
})();