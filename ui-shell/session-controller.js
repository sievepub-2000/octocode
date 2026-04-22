(function attachSessionController(global) {
  'use strict';

  function createSessionController(options) {
    const storageKey = options.sessionStorageKey || 'octocode-browser-session-id';
    let ownedSessionId = null;

    function readStoredSessionId() {
      try {
        return String(global.sessionStorage.getItem(storageKey) || '').trim();
      } catch (_) {
        return '';
      }
    }

    function writeStoredSessionId(sessionId) {
      try {
        if (sessionId) {
          global.sessionStorage.setItem(storageKey, sessionId);
        } else {
          global.sessionStorage.removeItem(storageKey);
        }
      } catch (_) {}
    }

    function setOwnedSessionId(sessionId) {
      ownedSessionId = String(sessionId || '').trim() || null;
      writeStoredSessionId(ownedSessionId || '');
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
      // If the user is viewing an existing (historical or external) session,
      // adopt it as the writable session for this tab. Do NOT destroy it and
      // create a new blank session — that was the "session pollution" bug
      // where a user clicking on a history session and typing a message
      // would silently start a different conversation.
      if (viewedSessionId) {
        setOwnedSessionId(viewedSessionId);
        return viewedSessionId;
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
      const candidates = [];
      if (requestedSessionId) candidates.push(requestedSessionId);
      if (storedSessionId && storedSessionId !== requestedSessionId) candidates.push(storedSessionId);

      for (const candidate of candidates) {
        try {
          await options.loadState(candidate);
          return;
        } catch (_) {
          if (candidate === storedSessionId) {
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