(function () {
  const DEFAULT_SESSION = new URLSearchParams(window.location.search).get("session") || "demo";
  const STREAM_URL = `/api/stream?session=${encodeURIComponent(DEFAULT_SESSION)}`;
  const EVENTS_URL = `/api/events?session=${encodeURIComponent(DEFAULT_SESSION)}`;
  const STATE_URL = `/api/state?session=${encodeURIComponent(DEFAULT_SESSION)}`;
  const POLL_MS = 1200;

  let lastRenderedSignature = "";
  let pollTimer = null;
  let stream = null;

  function emitStatus(mode, detail) {
    window.dispatchEvent(new CustomEvent("octocode:stream-status", {
      detail: { mode, detail, at: Date.now() },
    }));
    const existing = document.getElementById("octocode-stream-badge");
    const badge = existing || document.createElement("div");
    badge.id = "octocode-stream-badge";
    badge.textContent = mode === "sse" ? "● live" : mode === "poll" ? "◐ poll" : "○ offline";
    Object.assign(badge.style, {
      position: "fixed",
      left: "14px",
      bottom: "14px",
      zIndex: "9998",
      padding: "6px 9px",
      borderRadius: "999px",
      background: "rgba(17, 19, 28, 0.88)",
      color: mode === "sse" ? "#35c46a" : mode === "poll" ? "#f59e0b" : "#98a2b3",
      border: "1px solid rgba(255,255,255,0.14)",
      font: "12px JetBrains Mono, ui-monospace, monospace",
      boxShadow: "0 10px 30px rgba(0,0,0,0.24)",
    });
    if (!existing) document.body.appendChild(badge);
  }

  function renderEvents(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const signature = JSON.stringify(items.slice(-12));
    if (signature === lastRenderedSignature) return;
    lastRenderedSignature = signature;
    window.dispatchEvent(new CustomEvent("octocode:events", { detail: payload }));
  }

  function renderState(payload) {
    window.dispatchEvent(new CustomEvent("octocode:state", { detail: payload }));
  }

  async function pollOnce() {
    try {
      const [eventsRes, stateRes] = await Promise.all([
        fetch(EVENTS_URL, { cache: "no-store" }),
        fetch(STATE_URL, { cache: "no-store" }),
      ]);
      if (eventsRes.ok) renderEvents(await eventsRes.json());
      if (stateRes.ok) renderState(await stateRes.json());
      emitStatus("poll", "fallback polling active");
    } catch (error) {
      emitStatus("offline", error.message);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function startSse() {
    if (!("EventSource" in window)) {
      startPolling();
      return;
    }
    try {
      stream = new EventSource(STREAM_URL);
      stream.onopen = () => {
        stopPolling();
        emitStatus("sse", "connected");
      };
      stream.onmessage = (event) => {
        try {
          renderEvents(JSON.parse(event.data));
        } catch (_) {
          window.dispatchEvent(new CustomEvent("octocode:stream-raw", { detail: event.data }));
        }
      };
      stream.addEventListener("state", (event) => {
        try { renderState(JSON.parse(event.data)); } catch (_) {}
      });
      stream.onerror = () => {
        emitStatus("poll", "SSE unavailable; polling fallback active");
        if (stream) {
          stream.close();
          stream = null;
        }
        startPolling();
      };
    } catch (error) {
      emitStatus("poll", error.message);
      startPolling();
    }
  }

  window.OctocodeStream = {
    restart() {
      if (stream) stream.close();
      stream = null;
      stopPolling();
      startSse();
    },
    pollOnce,
  };

  window.addEventListener("load", startSse);
})();
