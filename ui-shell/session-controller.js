(function attachSessionController(global) {
  'use strict';

  function createSessionController(options) {
    const storageKey = options.sessionStorageKey || 'octocode-browser-session-id';
    const ownerKey = storageKey + '::owner';
    // Each browser tab gets a unique, in-memory tab id. If sessionStorage was
    // cloned from a parent tab (e.g. Ctrl+click on a link, or "duplicate tab"),
    // the stored owner id will not match this in-memory id — that's how we
    // detect a duplicate tab and force it to get its own fresh session.
    const tabId = (global.crypto && typeof global.crypto.randomUUID === 'function')
      ? global.crypto.randomUUID()
      : 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    let ownedSessionId = null;

    // Cross-tab coordination: if another tab owns the same session id,
    // the claimant that heard OWNER_EXISTS must release its claim.
    let broadcastChannel = null;
    try {
      if (typeof global.BroadcastChannel === 'function') {
        broadcastChannel = new global.BroadcastChannel('octocode-session-ownership');
      }
    } catch (_) {
      broadcastChannel = null;
    }
    const pendingClaimReplies = new Map(); // sessionId -> { resolve, timer }

    function broadcast(type, payload) {
      if (!broadcastChannel) return;
      try {
        broadcastChannel.postMessage(Object.assign({ type, tabId }, payload));
      } catch (_) {}
    }

    if (broadcastChannel) {
      broadcastChannel.onmessage = (event) => {
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;
        if (data.tabId === tabId) return; // ignore our own echo
        if (data.type === 'CLAIM' && data.sessionId && data.sessionId === ownedSessionId) {
          broadcast('OWNER_EXISTS', { sessionId: data.sessionId, targetTabId: data.tabId });
        } else if (data.type === 'OWNER_EXISTS' && data.targetTabId === tabId) {
          const pending = pendingClaimReplies.get(data.sessionId);
          if (pending) {
            pendingClaimReplies.delete(data.sessionId);
            clearTimeout(pending.timer);
            pending.resolve(true);
          }
        } else if (data.type === 'RELEASE' && data.sessionId && data.sessionId === ownedSessionId) {
          // Another tab released the session we thought we owned — no-op here,
          // but keeps the protocol symmetric for future debugging hooks.
        }
      };
    }

    /** Ask other tabs whether they already own `sessionId`. Resolves true if another tab responded within 250ms. */
    function askOwnership(sessionId) {
      if (!sessionId) return Promise.resolve(false);
      // BugFix (live P13, layer 1): localStorage is shared across tabs in the
      // same origin even when BroadcastChannel handshakes race (e.g. the
      // second tab's init runs before the first tab's onmessage handler is
      // attached). A heartbeat with TTL lets us detect a live owner even in
      // that race window.
      try {
        const raw = global.localStorage.getItem(claimKey(sessionId));
        if (raw) {
          const parsed = JSON.parse(raw);
          const fresh = parsed && typeof parsed.ts === 'number' && (Date.now() - parsed.ts) < CLAIM_TTL_MS;
          if (fresh && parsed.tabId && parsed.tabId !== tabId) {
            return Promise.resolve(true);
          }
        }
      } catch (_) {}
      if (!broadcastChannel) return Promise.resolve(false);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingClaimReplies.delete(sessionId);
          resolve(false);
        }, 250);
        pendingClaimReplies.set(sessionId, { resolve, timer });
        broadcast('CLAIM', { sessionId });
      });
    }

    const CLAIM_TTL_MS = 30_000;
    const CLAIM_HEARTBEAT_MS = 10_000;
    function claimKey(sessionId) { return 'octocode-session-claim:' + sessionId; }
    function writeClaim(sessionId) {
      if (!sessionId) return;
      try {
        global.localStorage.setItem(claimKey(sessionId), JSON.stringify({ tabId, ts: Date.now() }));
      } catch (_) {}
    }
    function clearClaim(sessionId) {
      if (!sessionId) return;
      try {
        const raw = global.localStorage.getItem(claimKey(sessionId));
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.tabId === tabId) global.localStorage.removeItem(claimKey(sessionId));
      } catch (_) {}
    }
    if (typeof global.setInterval === 'function') {
      global.setInterval(() => {
        if (ownedSessionId) writeClaim(ownedSessionId);
      }, CLAIM_HEARTBEAT_MS);
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('beforeunload', () => { if (ownedSessionId) clearClaim(ownedSessionId); });
    }

    function readStoredOwner() {
      try {
        const raw = global.sessionStorage.getItem(ownerKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.sessionId === 'string' && typeof parsed.tabId === 'string') {
          return parsed;
        }
      } catch (_) {}
      return null;
    }

    function readStoredSessionId() {
      try {
        const legacy = String(global.sessionStorage.getItem(storageKey) || '').trim();
        const owner = readStoredOwner();
        // Only honor a stored session id when the owner record matches THIS tab.
        // A cloned sessionStorage (duplicated tab) will carry the parent's tabId
        // and we intentionally return '' so the caller creates a fresh session.
        if (owner && owner.tabId === tabId && owner.sessionId) return owner.sessionId;
        // Legacy storage (no owner record yet): treat as unowned on first visit
        // of a new tab — will be re-claimed via ownership handshake if alive.
        if (legacy && !owner) return legacy;
        return '';
      } catch (_) {
        return '';
      }
    }

    function writeStoredSessionId(sessionId) {
      try {
        if (sessionId) {
          global.sessionStorage.setItem(storageKey, sessionId);
          global.sessionStorage.setItem(ownerKey, JSON.stringify({ sessionId, tabId }));
        } else {
          global.sessionStorage.removeItem(storageKey);
          global.sessionStorage.removeItem(ownerKey);
        }
      } catch (_) {}
    }

    function setOwnedSessionId(sessionId) {
      const previous = ownedSessionId;
      ownedSessionId = String(sessionId || '').trim() || null;
      writeStoredSessionId(ownedSessionId || '');
      if (previous && previous !== ownedSessionId) {
        broadcast('RELEASE', { sessionId: previous });
        clearClaim(previous);
      }
      if (ownedSessionId) {
        broadcast('CLAIM', { sessionId: ownedSessionId });
        writeClaim(ownedSessionId);
      }
      return ownedSessionId;
    }

    function currentSessionId() {
      return String(options.getCurrentSessionId?.() || '').trim();
    }

    function currentViewOwnsSession() {
      const viewedSessionId = currentSessionId();
      return Boolean(ownedSessionId) && viewedSessionId === ownedSessionId;
    }

    async function syncSessionSnapshot(config = {}) {
      const { silent = true } = config;
      const sessionId = currentSessionId();
      if (!sessionId) return;
      try {
        const state = await options.fetchSessionSnapshot(sessionId);
        options.setConnectionState('connected');
        options.applyState(state, sessionId);
      } catch (error) {
        if (!silent) options.renderError(error);
      }
    }

    async function createBrowserSession(config = {}) {
      const state = await options.postForm('/api/sessions/create', {
        title: config.title || '',
      }, {
        keepalive: Boolean(config.keepalive),
      });
      const sessionId = options.extractSessionId(state);
      if (!sessionId) throw new Error('missing created session id');
      setOwnedSessionId(sessionId);
      if (config.applyState !== false) {
        options.applyState(state, sessionId);
        await options.refreshEventFeed(sessionId);
      }
      return { sessionId, state };
    }

    async function closeSessionContext(sessionId, config = {}) {
      const {
        detachOwnedSession = false,
        closeTerminals = true,
      } = config;
      options.resetStreamingUiState({ abortActive: true });
      if (sessionId) {
        await options.requestStreamStop(sessionId);
      }
      if (closeTerminals && options.getTerminalCount() > 0) {
        await options.closeAllTerminalSessions({ skipRender: true, fetchKeepalive: true });
      }
      if (detachOwnedSession && ownedSessionId === sessionId) {
        setOwnedSessionId('');
      }
    }

    async function ensureWritableSession() {
      const viewedSessionId = currentSessionId();
      if (currentViewOwnsSession()) {
        return viewedSessionId;
      }
      // BugFix (live P13): sessions arriving via URL (?session=xxx) or via
      // snapshot adoption are treated as *views* — this tab never silently
      // claims write-ownership over them. That way, two tabs opened on the
      // same URL always fork into two independent sessions the moment the
      // user submits a message. The only auto-claim path is "this tab is
      // the single viewer AND localStorage shows no live heartbeat from
      // another tab" — which lets a solo user continue editing a history
      // session normally.
      if (viewedSessionId) {
        const ownedElsewhere = await askOwnership(viewedSessionId);
        const requested = String(options.getRequestedSessionId?.() || '').trim();
        const cameFromUrl = requested && requested === viewedSessionId;
        if (!ownedElsewhere && !cameFromUrl) {
          setOwnedSessionId(viewedSessionId);
          return viewedSessionId;
        }
      }
      const { sessionId, state } = await createBrowserSession({ applyState: false });
      options.applyState(state, sessionId);
      await options.refreshEventFeed(sessionId);
      return sessionId;
    }

    async function switchSession(targetSessionId) {
      const sessionId = String(targetSessionId || '').trim();
      const viewedSessionId = currentSessionId();
      if (!sessionId) return;
      if (sessionId !== viewedSessionId) {
        await closeSessionContext(viewedSessionId, {
          detachOwnedSession: ownedSessionId === viewedSessionId,
          closeTerminals: true,
        });
      }
      await options.loadState(sessionId);
      // Claim the switched-to session as owned for this browser tab.
      // Without this, `ensureWritableSession` would create a NEW session
      // on the user's next submit — polluting the intent to continue a
      // historical conversation.
      setOwnedSessionId(sessionId);
    }

    async function initializeSessionContext() {
      const requestedSessionId = String(options.getRequestedSessionId?.() || '').trim();
      const storedSessionId = readStoredSessionId();
      ownedSessionId = storedSessionId || null;

      // If sessionStorage was duplicated from another tab, `storedSessionId`
      // will be '' (owner record mismatch) — handled by the fresh-session
      // fallback below. If it matches, we still ask siblings via
      // BroadcastChannel in case the original owner tab is still alive.
      if (storedSessionId) {
        const ownedElsewhere = await askOwnership(storedSessionId);
        if (ownedElsewhere) {
          ownedSessionId = null;
          writeStoredSessionId('');
        }
      }

      const candidates = [];
      if (requestedSessionId) candidates.push(requestedSessionId);
      if (ownedSessionId && ownedSessionId !== requestedSessionId) candidates.push(ownedSessionId);

      for (const candidate of candidates) {
        try {
          await options.loadState(candidate);
          // URL-requested sessions are not auto-claimed; only sessions this
          // tab already owned get re-claimed on reload.
          if (candidate === ownedSessionId) {
            setOwnedSessionId(candidate);
          }
          return;
        } catch (_) {
          if (candidate === ownedSessionId) {
            setOwnedSessionId('');
          }
        }
      }

      const { state, sessionId } = await createBrowserSession({ applyState: false });
      options.applyState(state, sessionId);
      await options.refreshEventFeed(sessionId);
    }

    function handleDeletedSession(deletedSessionId, nextSessionId) {
      if (deletedSessionId && ownedSessionId === deletedSessionId) {
        setOwnedSessionId(nextSessionId || '');
      }
    }

    return {
      claimOwnedSession: setOwnedSessionId,
      closeSessionContext,
      createBrowserSession,
      currentViewOwnsSession,
      ensureWritableSession,
      getOwnedSessionId: () => ownedSessionId,
      handleDeletedSession,
      initializeSessionContext,
      switchSession,
      syncSessionSnapshot,
    };
  }

  global.createOctocodeSessionController = createSessionController;
})(window);