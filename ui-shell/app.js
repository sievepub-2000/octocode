/* 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
   Octocode Workbench 鈥?app.js v6 (DOM-based rendering)
   Replaces all canvas rendering with native DOM elements
   for scrollbars, text selection, copy/paste, and accessibility
   鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?*/
'use strict';

// 鈹€鈹€鈹€ DOM references 鈹€鈹€鈹€
const sidebarList      = document.getElementById('sidebar-list');
const messageList      = document.getElementById('message-list');
const terminalOutput   = document.getElementById('terminal-output');
const composerHints    = document.getElementById('composer-hints');
const streamIndicator  = document.getElementById('stream-indicator');
const submitBtn        = document.getElementById('chat-submit');
const charCount        = document.getElementById('char-count');
const modelInfoName    = document.getElementById('model-info-name');
const modelInfoProvider = document.getElementById('model-info-provider');

const sessionTitle     = document.getElementById('session-title');
const breadcrumbSession = document.getElementById('breadcrumb-session');
const composerSession  = document.getElementById('composer-session');
const platformPill     = document.getElementById('platform-pill');
const permissionPill   = document.getElementById('permission-pill');
const workspaceRoot    = document.getElementById('workspace-root');
const workspaceShell   = document.getElementById('workspace-shell');
const defaultModel     = document.getElementById('default-model');
const sessionCount     = document.getElementById('session-count');
const activeProviderEl = document.getElementById('active-provider');
const circuitStateEl   = document.getElementById('circuit-state');
const providerId       = document.getElementById('provider-id');
const menuProvider     = document.getElementById('menu-provider');
const menuPlatform     = document.getElementById('menu-platform');
const menuTime         = document.getElementById('menu-time');
const sidebarTitle     = document.getElementById('sidebar-title');
const toastContainer   = document.getElementById('toast-container');

const chatForm         = document.getElementById('chat-form');
const chatInput        = document.getElementById('chat-input');
const settingsForm     = document.getElementById('settings-form');
const toolForm         = document.getElementById('tool-form');
const commandForm      = document.getElementById('command-form');
const commandPalette   = document.getElementById('command-palette');
const settingProvider  = document.getElementById('setting-provider');
const settingBaseUrl   = document.getElementById('setting-base-url');
const settingModel     = document.getElementById('setting-model');
const settingPermission = document.getElementById('setting-permission');
const settingHistory   = document.getElementById('setting-history');
const toolName         = document.getElementById('tool-name');
const toolInput        = document.getElementById('tool-input');
const refreshButton    = document.getElementById('refresh-button');
const viewMenuButton   = document.getElementById('view-menu-button');
const viewLanguageMenu = document.getElementById('view-language-menu');
const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const closeShortcuts   = document.getElementById('close-shortcuts');

const statusConnection = document.getElementById('status-connection');
const statusProvider   = document.getElementById('status-provider');
const statusWorkspace  = document.getElementById('status-workspace');
const statusShell      = document.getElementById('status-shell');
const statusPermission = document.getElementById('status-permission');

const sidebarTabs      = document.querySelectorAll('.sidebar-tab');
const activityButtons  = document.querySelectorAll('.activity-button');
const terminalTabs     = document.querySelectorAll('.terminal-tab');
const viewModeBtns     = document.querySelectorAll('.view-mode-btn');
const localeButtons    = document.querySelectorAll('[data-locale]');
const localeElements   = document.querySelectorAll('[data-i18n]');
const localePlaceholders = document.querySelectorAll('[data-i18n-placeholder]');
const builtInLocales   = ['en-US', 'ja-JP', 'ko-KR', 'zh-CN'];

// Resize handles
const resizeLeft       = document.getElementById('resize-left');
const resizeRight      = document.getElementById('resize-right');
const workspaceGrid    = document.getElementById('workspace-grid');

// 鈹€鈹€鈹€ State 鈹€鈹€鈹€
let currentState       = null;
let currentView        = 'sessions';
let currentSessionId   = null;
let currentMessages    = [];
let currentEventFeed   = [];
let activeTerminalTab  = 'events';
let activeLocale       = 'zh-CN';
let activeViewMode     = 'normal';
let isSubmitting       = false;
let lastSettingsSaveAt = null;
let lastToolRun        = null;
let streamAbortController = null;
const urlState         = new URL(window.location.href);

// 鈹€鈹€鈹€ Connection state 鈹€鈹€鈹€
function setConnectionState(state) {
  statusConnection.className = `status-connection ${state}`;
  const labels = { connected: '鈼?connected', disconnected: '鈼?disconnected', loading: '鈼?loading...' };
  statusConnection.textContent = labels[state] || state;
}

// 鈹€鈹€鈹€ Toast 鈹€鈹€鈹€
function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// 鈹€鈹€鈹€ Button loading 鈹€鈹€鈹€
function setButtonLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('is-loading', loading);
  const sendIcon = btn.querySelector('.send-icon');
  const stopIcon = btn.querySelector('.stop-icon');
  if (sendIcon && stopIcon) {
    sendIcon.style.display = loading ? 'none' : '';
    stopIcon.style.display = loading ? '' : 'none';
  }
}

// 鈹€鈹€鈹€ Data loading 鈹€鈹€鈹€
async function loadState(sessionId) {
  setConnectionState('loading');
  try {
    const params = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
    const [stateRes, eventsRes] = await Promise.all([
      fetch(`/api/state${params}`),
      fetch(`/api/events${params}`),
    ]);
    if (!stateRes.ok) throw new Error(`state: HTTP ${stateRes.status}`);
    const state = await stateRes.json();
    if (eventsRes.ok) {
      const eventsData = await eventsRes.json();
      currentEventFeed = eventsData.events || eventsData.items || [];
      state.eventFeed = currentEventFeed;
    }
    setConnectionState('connected');
    applyState(state, sessionId);
  } catch (err) {
    setConnectionState('disconnected');
    renderError(err);
  }
}

async function refreshEventFeed(sessionId) {
  try {
    const params = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
    const res = await fetch(`/api/events${params}`);
    if (res.ok) {
      const data = await res.json();
      currentEventFeed = data.events || data.items || [];
      if (currentState) currentState.eventFeed = currentEventFeed;
    }
  } catch (_) {}
}

function applyState(state, sessionId) {
  currentState = state;
  const activeSession = state.activeSession || state.sessions?.[0];
  currentSessionId = sessionId || activeSession?.summary?.id || activeSession?.sessionId || 'demo';
  currentMessages = activeSession?.messages || [];

  // Update URL
  urlState.searchParams.set('session', currentSessionId);
  window.history.replaceState({}, '', urlState);

  render(state);
}

// 鈹€鈹€鈹€ Main render 鈹€鈹€鈹€
function render(state) {
  if (!state) return;
  const activeSession = state.activeSession || state.sessions?.[0];

  renderHeader(state, activeSession);
  renderSidebar(state, currentView, currentSessionId);
  renderMessages(currentMessages);
  renderTerminalContent();
  renderInfoCards(state);
  renderSettings(state);
  renderStatusBar(state);
  updateClock();
}

function renderHeader(state, activeSession) {
  const sid = activeSession?.summary?.id || currentSessionId || 'demo';
  sessionTitle.textContent = activeSession?.summary?.label || activeSession?.summary?.id || '交互式会话';
  breadcrumbSession.textContent = sid;
  composerSession.textContent = `session: ${sid}`;
  platformPill.textContent = state.workspace?.platform || state.config?.platform || '-';
  permissionPill.textContent = state.config?.permissionMode || '-';
  providerId.textContent = state.status?.activeProviderId || state.status?.providerId || 'loading';
  menuProvider.textContent = state.status?.activeProviderId || state.status?.providerId || '-';
  menuPlatform.textContent = state.workspace?.platform || '-';
  // Model info bar
  const modelName = state.config?.defaultModel || state.activeSession?.summary?.model || '-';
  const providerName = state.status?.activeProviderId || state.status?.providerId || '-';
  if (modelInfoName) modelInfoName.textContent = modelName;
  if (modelInfoProvider) modelInfoProvider.textContent = providerName;
}

function renderInfoCards(state) {
  workspaceRoot.textContent = state.workspace?.root || '-';
  workspaceShell.textContent = state.workspace?.shell || '-';
  defaultModel.textContent = state.config?.defaultModel || '-';
  sessionCount.textContent = String(state.sessions?.length || 0);
  if (activeProviderEl) activeProviderEl.textContent = state.status?.activeProviderId || '-';
  if (circuitStateEl) circuitStateEl.textContent = state.status?.providerCircuit?.circuitState || '-';
}

function renderSettings(state) {
  // Populate provider dropdown
  const providers = state.providers || [];
  if (providers.length && settingProvider.options.length <= 1) {
    settingProvider.replaceChildren();
    providers.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id || p;
      opt.textContent = p.label || p.id || p;
      settingProvider.appendChild(opt);
    });
  }
  if (state.config) {
    settingProvider.value = state.config.providerId || '';
    settingBaseUrl.value = state.config.providerBaseUrl || '';
    settingModel.value = state.config.defaultModel || '';
    settingPermission.value = normalizePermissionValue(state.config.permissionMode);
    settingHistory.value = state.config.historyLimit || 50;
  }

  // Populate tool dropdown
  const tools = state.tools || [];
  if (tools.length && toolName.options.length <= 1) {
    toolName.replaceChildren();
    tools.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = `${t.name} - ${t.summary || ''}`;
      toolName.appendChild(opt);
    });
  }
}

function renderStatusBar(state) {
  statusProvider.textContent = `provider: ${state.status?.activeProviderId || '-'}`;
  statusWorkspace.textContent = `workspace: ${state.workspace?.root || '-'}`;
  statusShell.textContent = `shell: ${state.workspace?.shell || '-'}`;
  statusPermission.textContent = `permission: ${state.config?.permissionMode || '-'}`;
}

// 鈹€鈹€鈹€ Sidebar rendering (DOM-based) 鈹€鈹€鈹€
function renderSidebar(state, view, activeSessionId) {
  currentView = view;
  syncViewControls(view);

  const items = buildSidebarItems(state, view, activeSessionId);
  sidebarList.replaceChildren();

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-item';
    empty.innerHTML = '<div class="sidebar-item-desc">褰撳墠娌℃湁鍙互鏄剧ず鐨勬暟鎹€?/div>';
    sidebarList.appendChild(empty);
    return;
  }

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = `sidebar-item${item.active ? ' active' : ''}`;
    el.innerHTML = `<div class="sidebar-item-title">${escapeHtml(item.title)}</div><div class="sidebar-item-desc">${escapeHtml(item.description)}</div>`;
    el.addEventListener('click', () => {
      if (item.onSelect) item.onSelect();
    });
    sidebarList.appendChild(el);
  });
}

function buildSidebarItems(state, view, activeSessionId) {
  if (!state) return [];

  const views = {
    sessions: () => (state.sessions || []).map(s => ({
      title: s.label || s.id || s.sessionId || 'session',
      description: `${s.messageCount || 0} messages 路 ${s.id || s.sessionId}`,
      active: (s.id || s.sessionId) === activeSessionId,
      onSelect: () => loadState(s.id || s.sessionId),
    })),
    providers: () => (state.providerRoutes || state.providers || []).map(p => ({
      title: p.providerId || p.id || p.label || String(p),
      description: `${p.healthy ? 'healthy' : 'unhealthy'} - ${p.circuitState || '-'} - ${p.isActive ? 'active' : 'standby'}`,
      active: (p.providerId || p.id) === (state.status?.activeProviderId),
    })),
    tools: () => (state.tools || []).map(t => ({
      title: t.name,
      description: `${t.summary || '-'} [${t.permissionLevel || '-'}]`,
      active: false,
      onSelect: () => { toolName.value = t.name; },
    })),
    commands: () => (state.commands || []).map(c => ({
      title: `/${c.name}`,
      description: c.summary || c.description || '-',
      active: false,
      onSelect: () => { chatInput.value = `/${c.name} `; chatInput.focus(); },
    })),
    settings: () => {
      if (!state.config) return [];
      return Object.entries(state.config).slice(0, 12).map(([k, v]) => ({
        title: k,
        description: String(v),
        active: false,
      }));
    },
  };

  return (views[view] || views.sessions)();
}

// 鈹€鈹€鈹€ Message rendering (DOM-based 鈥?key improvement) 鈹€鈹€鈹€
function renderMessages(messages) {
  const wasAtBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 40;

  messageList.replaceChildren();
  if (!messages || !messages.length) return;

  const fragment = document.createDocumentFragment();
  messages.forEach((msg, i) => {
    const role = msg.role || 'system';
    const el = document.createElement('div');
    el.className = `msg-bubble role-${role}`;
    el.dataset.index = i;

    let contentHtml = renderMarkdown(msg.content || '');

    if (activeViewMode === 'compact' && (msg.content || '').length > 200) {
      contentHtml = escapeHtml((msg.content || '').slice(0, 200)) + '…';
    }

    const modelTag = role === 'assistant' && currentState?.config?.defaultModel
      ? `<span class="msg-model">${escapeHtml(currentState.config.defaultModel)}</span>` : '';
    el.innerHTML = `<div class="msg-role">${escapeHtml(role)}${modelTag}</div><div class="msg-content">${contentHtml}</div><div class="msg-time">${formatTimestamp(msg.timestamp || msg.atMs)}</div>`;
    fragment.appendChild(el);
  });
  messageList.appendChild(fragment);

  // Auto-scroll to bottom if was near bottom
  if (wasAtBottom) {
    requestAnimationFrame(() => {
      messageList.scrollTop = messageList.scrollHeight;
    });
  }
}

function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) { return ''; }
}

// 鈹€鈹€鈹€ Terminal rendering (DOM-based) 鈹€鈹€鈹€
function renderTerminalContent() {
  const state = currentState;
  if (!state) { terminalOutput.textContent = 'No data'; return; }

  if (activeTerminalTab === 'events') renderEventsTab(state);
  else if (activeTerminalTab === 'state') renderStateTab(state);
  else if (activeTerminalTab === 'workflow') renderWorkflowTab(state);
}

function renderEventsTab(state) {
  const events = state.eventFeed || currentEventFeed || [];
  if (!events.length) {
    terminalOutput.textContent = '[events]\n  (no events yet - run a command or tool)';
    return;
  }
  const groups = {};
  events.forEach(e => {
    const scope = e.scope || 'system';
    (groups[scope] = groups[scope] || []).push(e);
  });
  const lines = [];
  Object.keys(groups).sort().forEach(scope => {
    lines.push(`[${scope}]`);
    groups[scope].forEach(e => {
      lines.push(`  ${e.message || JSON.stringify(e)}`);
    });
    lines.push('');
  });
  terminalOutput.textContent = lines.join('\n');
}

function renderStateTab(state) {
  const lines = [
    '[runtime snapshot]',
    `  provider     ${state.status?.activeProviderId || state.status?.providerId || '-'}`,
    `  circuit      ${state.status?.providerCircuit?.circuitState || '-'}`,
    `  model        ${state.config?.defaultModel || '-'}`,
    `  permission   ${state.config?.permissionMode || '-'}`,
    `  sessions     ${state.sessions?.length || 0}`,
    `  tools        ${state.tools?.length || 0}`,
    `  commands     ${state.commands?.length || 0}`,
    `  events       ${(state.eventFeed || currentEventFeed || []).length}`,
    '',
    '[provider routes]',
    ...(state.providerRoutes || []).map(
      r => `  ${r.providerId} ${r.circuitState} ${r.healthy ? 'healthy' : 'unhealthy'} ${r.isActive ? 'active' : 'standby'}`
    ),
  ];
  terminalOutput.textContent = lines.join('\n');
}

function renderWorkflowTab(state) {
  const events = state.eventFeed || currentEventFeed || [];
  const steps = state.steps || [];
  const lines = ['[timeline]'];
  if (events.length) {
    const firstMs = events.find(event => event.atMs != null)?.atMs || 0;
    events.forEach(event => {
      const rel = event.atMs != null ? `+${event.atMs - firstMs}ms` : '+?ms';
      lines.push(`${String(rel).padStart(10)} [${event.scope}] ${event.message}`);
    });
  } else {
    lines.push('  (no events yet - run a command or tool)');
  }
  if (steps.length) {
    lines.push('', '[pipeline steps]');
    steps.forEach((step, i) => {
      lines.push(`  ${i + 1}. ${step.cmd} -> ${step.tool} (${step.durationMs}ms)`);
    });
  }

  // Tasks
  const tasks = state.tasks || window._octocodeTasksCache || [];
  if (tasks.length) {
    lines.push('', '[tasks]');
    tasks.forEach(t => {
      const finished = t.finishedAtMs ? ` (${t.state})` : ` [${t.state}]`;
      lines.push(`  ${t.id}  ${t.label}${finished}  session:${t.sessionId}`);
    });
  } else {
    lines.push('', '[tasks]', '  (no tasks)');
  }

  terminalOutput.textContent = lines.join('\n');

  // Async refresh tasks
  const sid = currentSessionId || 'demo';
  fetch(`/api/tasks?session=${encodeURIComponent(sid)}`)
    .then(r => r.json())
    .then(data => {
      const items = data.items || [];
      window._octocodeTasksCache = items;
      if (items.length !== tasks.length) renderWorkflowTab({ ...state, tasks: items });
    })
    .catch(() => {});
}

// 鈹€鈹€鈹€ Error state 鈹€鈹€鈹€
function renderError(error) {
  providerId.textContent = 'offline';
  sessionTitle.textContent = '交互状态加载失败';
  breadcrumbSession.textContent = 'offline';
  composerSession.textContent = 'session: offline';
  platformPill.textContent = '-';
  permissionPill.textContent = '-';
  workspaceRoot.textContent = '-';
  workspaceShell.textContent = '-';
  defaultModel.textContent = '-';
  sessionCount.textContent = '0';
  menuProvider.textContent = 'offline';
  menuPlatform.textContent = '-';
  updateClock();
  sidebarTitle.textContent = 'Offline';
  sidebarList.innerHTML = '<div class="sidebar-item"><div class="sidebar-item-desc">鏃犳硶杩炴帴鍒版湇鍔″櫒</div></div>';
  messageList.innerHTML = '<div class="msg-bubble role-system"><div class="msg-role">SYSTEM</div><div class="msg-content">璇疯繍琛?octocode-cli serve 999 demo 鎴?start-webui 鑴氭湰鍚庡啀鍒锋柊椤甸潰銆俓n\n' + escapeHtml(error.message) + '</div></div>';
  terminalOutput.textContent = `load-error\n${error.message}`;
}

// 鈹€鈹€鈹€ i18n 鈹€鈹€鈹€
async function loadLocalePlugin() {
  const pluginUrl = urlState.searchParams.get('localePlugin');
  const requestedLocale = urlState.searchParams.get('locale') || navigator.language || 'zh-CN';
  activeLocale = resolveSupportedLocale(requestedLocale);
  const candidates = pluginUrl ? [pluginUrl] : [`/ui-shell/locales/${activeLocale}.json`, '/ui-shell/locales/en-US.json'];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: 'no-store' });
      if (!response.ok) continue;
      const messages = await response.json();
      applyLocaleMessages(messages);
      return;
    } catch (_) {}
  }
}

function applyLocaleMessages(messages) {
  localeElements.forEach(el => {
    const key = el.dataset.i18n;
    if (messages[key]) el.textContent = messages[key];
  });
  localePlaceholders.forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (messages[key]) el.placeholder = messages[key];
  });
  syncLocaleControls();
}

function resolveSupportedLocale(locale) {
  if (!locale) return 'zh-CN';
  if (builtInLocales.includes(locale)) return locale;
  if (locale.startsWith('zh')) return 'zh-CN';
  if (locale.startsWith('ja')) return 'ja-JP';
  if (locale.startsWith('ko')) return 'ko-KR';
  return 'en-US';
}

function syncLocaleControls() {
  localeButtons.forEach(btn => {
    const isActive = btn.dataset.locale === activeLocale;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function toggleViewLanguageMenu(forceOpen) {
  const nextState = typeof forceOpen === 'boolean' ? forceOpen : viewLanguageMenu.hidden;
  viewLanguageMenu.hidden = !nextState;
  viewMenuButton.setAttribute('aria-expanded', nextState ? 'true' : 'false');
}

async function setActiveLocale(locale) {
  activeLocale = resolveSupportedLocale(locale);
  urlState.searchParams.set('locale', activeLocale);
  window.history.replaceState({}, '', urlState);
  await loadLocalePlugin();
  toggleViewLanguageMenu(false);
}

// ─── Utilities ───
function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
}

// ─── Markdown rendering with marked.js + highlight.js ───
function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined' && marked.parse) {
    try {
      marked.setOptions({
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          if (typeof hljs !== 'undefined') {
            return hljs.highlightAuto(code).value;
          }
          return escapeHtml(code);
        },
        breaks: true,
        gfm: true,
      });
      // Sanitize: strip script tags and event handlers
      let html = marked.parse(text);
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      html = html.replace(/\son\w+\s*=/gi, ' data-blocked=');
      return html;
    } catch (_) {}
  }
  // Fallback: basic rendering if marked.js not loaded
  let contentHtml = escapeHtml(text);
  contentHtml = contentHtml.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  contentHtml = contentHtml.replace(/`([^`]+)`/g, '<code>$1</code>');
  return contentHtml;
}

// ─── Highlight.js theme sync ───
function syncHighlightTheme(theme) {
  const lightSheet = document.getElementById('hljs-light');
  if (lightSheet) {
    lightSheet.href = theme === 'dark'
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
  }
}

function normalizePermissionValue(value) {
  switch (value) {
    case 'ReadOnly': return 'read-only';
    case 'DangerFullAccess': return 'danger-full-access';
    default: return 'workspace-write';
  }
}

function updateClock() {
  menuTime.textContent = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function syncViewControls(view) {
  sidebarTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  activityButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
}

async function postForm(url, fields) {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) body.set(key, String(value));
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}

// 鈹€鈹€鈹€ Slash commands 鈹€鈹€鈹€
const SLASH_COMMANDS = [
  'plan', 'workflow', 'agent', 'repl', 'search', 'pipe',
  'snapshot', 'sessions', 'status', 'events', 'health', 'circuit-log', 'doctor', 'tokens',
  'history', 'read', 'list', 'write', 'append', 'tree', 'tool',
  'git', 'context', 'fetch',
  'session-add', 'session',
  'provider', 'model', 'permission', 'approve',
  'reload', 'refresh',
];

function isSlashCommand(text) {
  if (!text.startsWith('/')) return false;
  const verb = text.slice(1).split(/\s+/)[0].toLowerCase();
  return SLASH_COMMANDS.includes(verb);
}

function slashCommandVerb(text) {
  return text.startsWith('/') ? text.slice(1).split(/\s+/)[0].toLowerCase() : '';
}

// 鈹€鈹€鈹€ Slash command hints 鈹€鈹€鈹€
function updateComposerHints() {
  const text = chatInput.value;
  charCount.textContent = text.length;

  if (!text.startsWith('/') || text.includes('\n')) {
    composerHints.classList.remove('visible');
    return;
  }

  const partial = text.slice(1).split(/\s+/)[0].toLowerCase();
  const commands = currentState?.commands || [];
  const matches = commands.filter(c => c.name.startsWith(partial)).slice(0, 8);

  if (!matches.length) {
    composerHints.classList.remove('visible');
    return;
  }

  composerHints.replaceChildren();
  matches.forEach(cmd => {
    const el = document.createElement('div');
    el.className = 'hint-item';
    el.innerHTML = `<span class="hint-item-name">/${escapeHtml(cmd.name)}</span><span class="hint-item-desc">${escapeHtml(cmd.summary || '')}</span>`;
    el.addEventListener('click', () => {
      chatInput.value = `/${cmd.name} `;
      chatInput.focus();
      composerHints.classList.remove('visible');
    });
    composerHints.appendChild(el);
  });
  composerHints.classList.add('visible');
}

// 鈹€鈹€鈹€ SSE Streaming 鈹€鈹€鈹€
async function streamChat(text) {
  streamIndicator.hidden = false;
  streamAbortController = new AbortController();

  // Add user message immediately
  currentMessages.push({ role: 'user', content: text, timestamp: Date.now() });
  renderMessages(currentMessages);

  // Create streaming assistant bubble
  const assistantMsg = { role: 'assistant', content: '', timestamp: Date.now() };
  currentMessages.push(assistantMsg);
  renderMessages(currentMessages);

  try {
    const params = new URLSearchParams({
      session: currentSessionId || 'demo',
      text,
    });
    const res = await fetch(`/api/stream?${params}`, {
      signal: streamAbortController.signal,
    });

    if (!res.ok) {
      // Fallback to regular chat
      currentMessages.pop(); // remove empty assistant message
      currentMessages.pop(); // remove user message
      return false; // signal caller to use regular chat
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE format
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.token) {
              assistantMsg.content += parsed.token;
              // Update last message bubble directly for performance
              const lastBubble = messageList.lastElementChild;
              if (lastBubble) {
                const contentEl = lastBubble.querySelector('.msg-content');
                if (contentEl) contentEl.textContent = assistantMsg.content;
              }
              // Keep scrolled to bottom
              messageList.scrollTop = messageList.scrollHeight;
            }
          } catch (_) {
            // plain text token
            assistantMsg.content += data;
            const lastBubble = messageList.lastElementChild;
            if (lastBubble) {
              const contentEl = lastBubble.querySelector('.msg-content');
              if (contentEl) contentEl.textContent = assistantMsg.content;
            }
            messageList.scrollTop = messageList.scrollHeight;
          }
        }
      }
    }
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      assistantMsg.content += '\n[stopped by user]';
      renderMessages(currentMessages);
    } else {
      currentMessages.pop();
      currentMessages.pop();
      return false;
    }
  } finally {
    streamIndicator.hidden = true;
    streamAbortController = null;
  }
  return true;
}

// 鈹€鈹€鈹€ Form handlers 鈹€鈹€鈹€
chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || isSubmitting) return;

  isSubmitting = true;
  setButtonLoading(submitBtn, true);
  setConnectionState('loading');
  composerHints.classList.remove('visible');

  try {
    let state;
    if (isSlashCommand(text)) {
      const command = text.slice(1).trim();
      const verb = slashCommandVerb(text);
      if (verb === 'events') {
        await refreshEventFeed(currentSessionId);
        renderTerminalContent();
        chatInput.value = '';
        charCount.textContent = '0';
        setConnectionState('connected');
        return;
      }
      if (['snapshot', 'status', 'sessions', 'health', 'doctor', 'reload', 'refresh'].includes(verb)) {
        await loadState(currentSessionId);
        chatInput.value = '';
        charCount.textContent = '0';
        return;
      }
      if (command.includes(' | ')) {
        state = await postForm('/api/command', { sessionId: currentSessionId, command: `pipe ${command}` });
      } else {
        state = await postForm('/api/command', { sessionId: currentSessionId, command });
      }
    } else {
      // Try streaming first, fall back to regular chat
      chatInput.value = '';
      charCount.textContent = '0';
      const streamed = await streamChat(text);
      if (streamed) {
        await loadState(currentSessionId);
        return;
      }
      // Fallback
      state = await postForm('/api/chat', { sessionId: currentSessionId, text });
    }
    chatInput.value = '';
    charCount.textContent = '0';
    setConnectionState('connected');
    applyState(state, currentSessionId);
    await refreshEventFeed(currentSessionId);
  } catch (error) {
    setConnectionState('disconnected');
    showToast(`鎿嶄綔澶辫触: ${error.message}`, 'error');
  } finally {
    isSubmitting = false;
    setButtonLoading(submitBtn, false);
  }
});

// Unified send/stop button: when streaming, click = abort
submitBtn.addEventListener('click', (e) => {
  if (isSubmitting && streamAbortController) {
    e.preventDefault();
    streamAbortController.abort();
  }
});

chatInput.addEventListener('input', updateComposerHints);

// Enter sends message, Shift+Enter inserts newline
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const state = await postForm('/api/settings', {
      sessionId: currentSessionId,
      providerId: settingProvider.value,
      providerBaseUrl: settingBaseUrl.value,
      defaultModel: settingModel.value,
      permissionMode: settingPermission.value,
      historyLimit: settingHistory.value,
    });
    lastSettingsSaveAt = new Date();
    applyState(state, currentSessionId);
    await refreshEventFeed(currentSessionId);
    showToast('设置已保存', 'success');
  } catch (error) {
    showToast(`淇濆瓨璁剧疆澶辫触: ${error.message}`, 'error');
  }
});

toolForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const toolStart = Date.now();
    const state = await postForm('/api/tool', {
      sessionId: currentSessionId,
      name: toolName.value,
      input: toolInput.value,
    });
    const toolDurationMs = Date.now() - toolStart;
    const latestToolEvent = (state.eventFeed || []).slice().reverse().find(e => e.scope === 'transcript');
    lastToolRun = {
      name: toolName.value,
      input: toolInput.value,
      output: latestToolEvent?.message || '(no output)',
      durationMs: toolDurationMs,
    };
    applyState(state, currentSessionId);
    await refreshEventFeed(currentSessionId);
    showToast(`${lastToolRun.name} completed (${toolDurationMs}ms)`, 'success');
  } catch (error) {
    showToast(`宸ュ叿鎵ц澶辫触: ${error.message}`, 'error');
  }
});

commandForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const command = commandPalette.value.trim();
  if (!command) return;
  try {
    const state = await postForm('/api/command', { sessionId: currentSessionId, command });
    applyState(state, currentSessionId);
    await refreshEventFeed(currentSessionId);
    commandPalette.value = '';
  } catch (error) {
    showToast(`鍛戒护鎵ц澶辫触: ${error.message}`, 'error');
  }
});

// 鈹€鈹€鈹€ Terminal tabs 鈹€鈹€鈹€
terminalTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    activeTerminalTab = tab.dataset.tab || 'events';
    terminalTabs.forEach(t => t.classList.toggle('active', t === tab));
    renderTerminalContent();
  });
});

// 鈹€鈹€鈹€ Sidebar tabs 鈹€鈹€鈹€
[...sidebarTabs, ...activityButtons].forEach(control => {
  control.addEventListener('click', () => {
    currentView = control.dataset.view;
    if (currentState) renderSidebar(currentState, currentView, currentSessionId);
    else syncViewControls(currentView);
  });
});

// 鈹€鈹€鈹€ View mode 鈹€鈹€鈹€
viewModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    activeViewMode = btn.dataset.mode;
    viewModeBtns.forEach(b => b.classList.toggle('active', b === btn));
    renderMessages(currentMessages);
  });
});

// (stop stream handled by unified send/stop button)

// 鈹€鈹€鈹€ Resize handles 鈹€鈹€鈹€
function initResize(handle, side) {
  let startX, startWidth;
  const panelId = side === 'left' ? 'panel-left' : 'panel-right';

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const panel = document.getElementById(panelId);
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      const newWidth = Math.max(180, Math.min(500, startWidth + delta));
      workspaceGrid.style.setProperty(side === 'left' ? '--left-width' : '--right-width', `${newWidth}px`);
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
initResize(resizeLeft, 'left');
initResize(resizeRight, 'right');

// 鈹€鈹€鈹€ Keyboard shortcuts 鈹€鈹€鈹€
document.addEventListener('keydown', (e) => {
  // Ctrl+K: Focus command palette
  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    commandPalette.focus();
    commandPalette.select();
  }
  // Ctrl+Enter: Send message
  if (e.ctrlKey && e.key === 'Enter' && document.activeElement === chatInput) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
  // Ctrl+L: Clear chat display
  if (e.ctrlKey && e.key === 'l') {
    e.preventDefault();
    currentMessages = [];
    renderMessages(currentMessages);
  }
  // Ctrl+N: New session
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    postForm('/api/command', { sessionId: currentSessionId, command: 'session-add new' })
      .then(state => { applyState(state, state.activeSession?.summary?.id); })
      .catch(err => showToast(err.message, 'error'));
  }
  // Ctrl+B: Toggle sidebar
  if (e.ctrlKey && e.key === 'b') {
    e.preventDefault();
    const panel = document.getElementById('panel-left');
    const handle = document.getElementById('resize-left');
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
    handle.style.display = hidden ? '' : 'none';
  }
  // Ctrl+`: Toggle right panel
  if (e.ctrlKey && e.key === '`') {
    e.preventDefault();
    const panel = document.getElementById('panel-right');
    const handle = document.getElementById('resize-right');
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
    handle.style.display = hidden ? '' : 'none';
  }
  // Ctrl+/: Show shortcuts
  if (e.ctrlKey && e.key === '/') {
    e.preventDefault();
    shortcutsOverlay.hidden = !shortcutsOverlay.hidden;
  }
  // Escape: Close overlays
  if (e.key === 'Escape') {
    shortcutsOverlay.hidden = true;
    composerHints.classList.remove('visible');
    toggleViewLanguageMenu(false);
  }
});

closeShortcuts.addEventListener('click', () => { shortcutsOverlay.hidden = true; });
refreshButton.addEventListener('click', () => loadState(currentSessionId));

viewMenuButton.addEventListener('click', () => toggleViewLanguageMenu());
localeButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    await setActiveLocale(btn.dataset.locale || 'zh-CN');
  });
});
document.addEventListener('click', (event) => {
  if (!viewLanguageMenu.contains(event.target) && !viewMenuButton.contains(event.target)) {
    toggleViewLanguageMenu(false);
  }
  // Close hints when clicking outside
  if (!composerHints.contains(event.target) && event.target !== chatInput) {
    composerHints.classList.remove('visible');
  }
});

// ─── Theme toggle ───
const themeToggle = document.getElementById('theme-toggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '☾' : '☀';
  themeToggle.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  syncHighlightTheme(theme);
  try { localStorage.setItem('octocode-theme', theme); } catch (_) {}
}
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});
// Apply saved theme — respect system preference if no saved preference
applyTheme((() => {
  try {
    const saved = localStorage.getItem('octocode-theme');
    if (saved) return saved;
  } catch (_) {}
  // Auto-detect system preference
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
})());
// Listen for system theme changes
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    try { if (localStorage.getItem('octocode-theme')) return; } catch (_) {}
    applyTheme(e.matches ? 'dark' : 'light');
  });
}

// ─── Init ───
setInterval(updateClock, 60_000);
loadLocalePlugin();
loadState();
