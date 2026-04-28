/* ════════════════════════════════════════════════════════════
   Octocode Workbench — app.js v8
   Unified DOM rendering, work-object actions, localized menus,
   and real shell-backed multi-terminal drawer.
   ════════════════════════════════════════════════════════════ */
'use strict';

let authToken = window.__OCTOCODE_AUTH_TOKEN__ || '';
const builtInLocales = ['en-US', 'ja-JP', 'ko-KR', 'zh-CN'];
const urlState = new URL(window.location.href);
const STREAM_STATE_POLL_MS = 1500;
const SNAPSHOT_REFRESH_MS = 15000;

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (authToken) headers['X-Auth-Token'] = authToken;
  return headers;
}

const sidebarList = document.getElementById('sidebar-list');
const sidebarTitle = document.getElementById('sidebar-title');
const messageList = document.getElementById('message-list');
const composerHints = document.getElementById('composer-hints');
const streamIndicator = document.getElementById('stream-indicator');
const streamIndicatorLabel = streamIndicator?.querySelector('.stream-label') || null;
const submitBtn = document.getElementById('chat-submit');
const submitBtnLabel = document.getElementById('chat-submit-label');
const charCount = document.getElementById('char-count');
const modelInfoName = document.getElementById('model-info-name');
const modelInfoProvider = document.getElementById('model-info-provider');

const sessionTitle = document.getElementById('session-title');
const breadcrumbSession = document.getElementById('breadcrumb-session');
const breadcrumbSessionId = document.getElementById('breadcrumb-session-id');
const workObjectPathEl = document.getElementById('work-object-path');
const composerSession = document.getElementById('composer-session');
const platformPill = document.getElementById('platform-pill');
const permissionPill = document.getElementById('permission-pill');
const workspaceRoot = document.getElementById('workspace-root');
const workspaceShell = document.getElementById('workspace-shell');
const defaultModel = document.getElementById('default-model');
const sessionCount = document.getElementById('session-count');
const sessionCountInline = document.getElementById('session-count-inline');
const activeProviderEl = document.getElementById('active-provider');
const circuitStateEl = document.getElementById('circuit-state');
const providerId = document.getElementById('provider-id');
const menuProvider = document.getElementById('menu-provider');
const menuPlatform = document.getElementById('menu-platform');
const menuTime = document.getElementById('menu-time');
const toastContainer = document.getElementById('toast-container');
const sidebarActionsButton = document.getElementById('sidebar-actions-button');
const contextMenu = document.getElementById('context-menu');

const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const settingsForm = document.getElementById('settings-form');
const toolForm = document.getElementById('tool-form');
const settingProvider = document.getElementById('setting-provider');
const settingBaseUrl = document.getElementById('setting-base-url');
const settingModel = document.getElementById('setting-model');
const settingPermission = document.getElementById('setting-permission');
const settingHistory = document.getElementById('setting-history');
const toolName = document.getElementById('tool-name');
const toolInput = document.getElementById('tool-input');
const refreshButton = document.getElementById('refresh-button');

const fileMenuButton = document.getElementById('file-menu-button');
const fileMenuPanel = document.getElementById('file-menu-panel');
const editMenuButton = document.getElementById('edit-menu-button');
const editMenuPanel = document.getElementById('edit-menu-panel');
const viewMenuButton = document.getElementById('view-menu-button');
const viewLanguageMenu = document.getElementById('view-language-menu');
const manageMenuButton = document.getElementById('manage-menu-button');
const manageMenuPanel = document.getElementById('manage-menu-panel');
const toolsMenuButton = document.getElementById('tools-menu-button');
const toolsMenuPanel = document.getElementById('tools-menu-panel');
const terminalMenuPanel = document.getElementById('terminal-menu-panel');
const helpMenuButton = document.getElementById('help-menu-button');
const helpMenuPanel = document.getElementById('help-menu-panel');
const terminalMenuButton = document.getElementById('terminal-menu-button');

const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const closeShortcuts = document.getElementById('close-shortcuts');

const fileNewFileBtn = document.getElementById('file-new-file');
const fileOpenFileBtn = document.getElementById('file-open-file');
const fileNewFolderBtn = document.getElementById('file-new-folder');
const fileOpenFolderBtn = document.getElementById('file-open-folder');
const editFindBtn = document.getElementById('edit-find');
const editReplaceBtn = document.getElementById('edit-replace');
const searchLayer = document.getElementById('search-layer');
const searchLayerClose = document.getElementById('search-layer-close');
const searchResults = document.getElementById('search-results');
const searchQueryInput = document.getElementById('search-query');
const searchReplaceInput = document.getElementById('search-replace');
const searchReplaceWrap = document.getElementById('search-replace-wrap');
const searchRunButton = document.getElementById('search-run');
const searchReplaceRunButton = document.getElementById('search-replace-run');
const searchScopeLabel = document.getElementById('search-scope-label');
const searchResultCount = document.getElementById('search-result-count');
const searchModeButtons = document.querySelectorAll('[data-search-mode]');

const fileDialog = document.getElementById('file-dialog');
const fileDialogTitle = document.getElementById('file-dialog-title');
const fileDialogSubtitle = document.getElementById('file-dialog-subtitle');
const fileDialogClose = document.getElementById('file-dialog-close');
const fileDialogCancel = document.getElementById('file-dialog-cancel');
const fileDialogConfirm = document.getElementById('file-dialog-confirm');
const forkDialog = document.getElementById('fork-dialog');
const forkDialogForm = document.getElementById('fork-dialog-form');
const forkDialogTitle = document.getElementById('fork-dialog-title');
const forkDialogSubtitle = document.getElementById('fork-dialog-subtitle');
const forkDialogClose = document.getElementById('fork-dialog-close');
const forkDialogCancel = document.getElementById('fork-dialog-cancel');
const forkDialogConfirm = document.getElementById('fork-dialog-confirm');
const forkParentSessionInput = document.getElementById('fork-parent-session');
const forkMessageIndexInput = document.getElementById('fork-message-index');
const forkBranchNameInput = document.getElementById('fork-branch-name');
const forkBranchPreviewInput = document.getElementById('fork-branch-preview');
const forkDialogError = document.getElementById('fork-dialog-error');
const manageEditorDialog = document.getElementById('manage-editor-dialog');
const manageEditorForm = document.getElementById('manage-editor-form');
const manageEditorTitle = document.getElementById('manage-editor-title');
const manageEditorSubtitle = document.getElementById('manage-editor-subtitle');
const manageEditorFields = document.getElementById('manage-editor-fields');
const manageEditorClose = document.getElementById('manage-editor-close');
const manageEditorCancel = document.getElementById('manage-editor-cancel');
const manageEditorDelete = document.getElementById('manage-editor-delete');
const manageEditorApply = document.getElementById('manage-editor-apply');
const pathQuickLinks = document.getElementById('path-quick-links');
const pathUpButton = document.getElementById('path-up-button');
const pathRefreshButton = document.getElementById('path-refresh-button');
const pathCurrentInput = document.getElementById('path-current-input');
const pathBreadcrumbs = document.getElementById('path-breadcrumbs');
const pathEntryList = document.getElementById('path-entry-list');
const pathNameInput = document.getElementById('path-name-input');
const pathSelectedInput = document.getElementById('path-selected-input');

const terminalDrawer = document.getElementById('terminal-drawer');
const terminalTabsHost = document.getElementById('terminal-tabs');
const terminalNewTabBtn = document.getElementById('terminal-new-tab');
const terminalHideBtn = document.getElementById('terminal-hide');
const terminalCwd = document.getElementById('terminal-cwd');
const terminalOutput = document.getElementById('terminal-output');
const terminalViewport = document.getElementById('terminal-viewport');

const statusConnection = document.getElementById('status-connection');
const statusProvider = document.getElementById('status-provider');
const statusWorkspace = document.getElementById('status-workspace');
const statusShell = document.getElementById('status-shell');
const statusPermission = document.getElementById('status-permission');
const statusBranch = document.getElementById('status-branch');
const statusTurn = document.getElementById('status-turn');

const sidebarTabs = document.querySelectorAll('.sidebar-tab');
const activityButtons = document.querySelectorAll('.activity-button');
const viewModeBtns = document.querySelectorAll('.view-mode-btn');
const localeButtons = document.querySelectorAll('[data-locale]');
const localeElements = document.querySelectorAll('[data-i18n]');
const localePlaceholders = document.querySelectorAll('[data-i18n-placeholder]');
const localeTitles = document.querySelectorAll('[data-i18n-title]');
const terminalMenuActions = document.querySelectorAll('[data-terminal-action]');

const resizeLeft = document.getElementById('resize-left');
const resizeRight = document.getElementById('resize-right');
const workspaceGrid = document.getElementById('workspace-grid');
const themeToggle = document.getElementById('theme-toggle');
const managePanelTitle = document.getElementById('manage-panel-title');
const managePanelSubtitle = document.getElementById('manage-panel-subtitle');
const managePanelSections = document.querySelectorAll('.manage-panel-section');
const managePanelButtons = document.querySelectorAll('[data-manage-panel]');
const manageProvidersList = document.getElementById('manage-providers-list');
const manageMcpList = document.getElementById('manage-mcp-list');
const manageSkillsList = document.getElementById('manage-skills-list');
const manageHooksList = document.getElementById('manage-hooks-list');
const manageToolsList = document.getElementById('manage-tools-list');
const manageCommandsList = document.getElementById('manage-commands-list');

const dropdownPairs = [
  { button: fileMenuButton, panel: fileMenuPanel },
  { button: editMenuButton, panel: editMenuPanel },
  { button: viewMenuButton, panel: viewLanguageMenu },
  { button: manageMenuButton, panel: manageMenuPanel },
  { button: toolsMenuButton, panel: toolsMenuPanel },
  { button: terminalMenuButton, panel: terminalMenuPanel },
  { button: helpMenuButton, panel: helpMenuPanel },
];

let currentState = null;
let currentView = 'sessions';
let currentManagePanel = 'overview';
let currentSessionId = null;
let currentMessages = [];
let currentEventFeed = [];
// Last signature of the rendered transcript + view-mode + model. Used to
// short-circuit `renderMessages` when nothing visible has changed, so the
// 15-second snapshot refresh does not visibly tear down and rebuild the
// entire conversation pane (which manifested to operators as a "对话栏不停
// 刷新" flicker).
let lastRenderedMessagesSignature = '';
let lastRenderedSidebarSignature = '';
let activeLocale = 'zh-CN';
let localeMessages = {};
let activeViewMode = 'normal';
let isSubmitting = false;
let streamAbortController = null;
let lastSettingsSaveAt = null;
let lastToolRun = null;
let currentWorkObject = { type: 'session', name: 'demo', path: '-' };
let terminalSessions = [];
let activeTerminalId = null;
let terminalVisible = false;
let manageCatalog = null;
let manageCatalogPromise = null;
let searchLayerMode = 'find';
let latestSearchResult = null;
let authRefreshPromise = null;
let conversationRuntime = null;
let snapshotRefreshTimer = 0;
let fileDialogState = {
  open: false,
  create: false,
  kind: 'file',
  currentPath: '',
  selectedPath: '',
  selectedKind: '',
  workspaceRoot: '',
  entries: [],
};
let forkDialogState = {
  open: false,
  pending: false,
  parentSessionId: '',
  parentSessionTitle: '',
  messageIndex: null,
  branchName: '',
  normalizedBranchName: '',
  defaultBranchName: '',
  error: '',
};
let manageEditorState = null;

const managePanelMeta = {
  overview: { titleKey: 'manage.overview', titleFallback: '概览', subtitleKey: 'manage.overviewHint', subtitleFallback: '查看系统状态、安装配置和工具接入情况。' },
  providers: { titleKey: 'manage.providers', titleFallback: 'Providers', subtitleKey: 'manage.providersHint', subtitleFallback: '查看 Provider 路由、健康状态和当前激活情况。' },
  mcp: { titleKey: 'manage.mcp', titleFallback: 'MCP', subtitleKey: 'manage.mcpHint', subtitleFallback: '查看当前已发现的 MCP 服务、传输方式和可信状态。' },
  skills: { titleKey: 'manage.skills', titleFallback: 'Skills', subtitleKey: 'manage.skillsHint', subtitleFallback: '查看工作区与用户级 Skill 的来源与描述。' },
  hooks: { titleKey: 'manage.hooks', titleFallback: 'Hooks', subtitleKey: 'manage.hooksHint', subtitleFallback: '查看全局与按工具生效的 Hook 配置。' },
  tools: { titleKey: 'manage.tools', titleFallback: 'Tools', subtitleKey: 'manage.toolsHint', subtitleFallback: '查看当前工具能力与权限要求。' },
  commands: { titleKey: 'manage.commands', titleFallback: 'Commands', subtitleKey: 'manage.commandsHint', subtitleFallback: '查看斜杠命令入口并快速插入对话框。' },
  settings: { titleKey: 'manage.settings', titleFallback: 'Settings', subtitleKey: 'manage.settingsHint', subtitleFallback: '修改 Provider、模型和权限等运行设置。' },
  github: { titleKey: 'manage.github', titleFallback: 'GitHub 连接', subtitleKey: 'manage.githubHint', subtitleFallback: '管理用户名/密码、项目接入 Key、管理 Token 等 GitHub 主流接入方式。凭据仅保存在本浏览器。' },
};

const SESSION_TREE_COLLAPSE_STORAGE_KEY = 'octocode-session-tree-collapsed';

function readCollapsedSessionTreeIds() {
  try {
    const raw = localStorage.getItem(SESSION_TREE_COLLAPSE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map((value) => String(value || '').trim()).filter(Boolean) : []);
  } catch (_) {
    return new Set();
  }
}

function writeCollapsedSessionTreeIds() {
  try {
    localStorage.setItem(SESSION_TREE_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsedSessionTreeIds)));
  } catch (_) {}
}

let collapsedSessionTreeIds = readCollapsedSessionTreeIds();

function t(key, fallback = '') {
  return localeMessages[key] || fallback || key;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function extractSessionId(state, fallback = '') {
  return state?.activeSession?.summary?.id
    || state?.activeSession?.sessionId
    || fallback
    || '';
}

function updateAuthToken(token) {
  authToken = String(token || '').trim();
  window.__OCTOCODE_AUTH_TOKEN__ = authToken;
}

function extractAuthTokenFromHtml(html) {
  const match = String(html || '').match(/window\.__OCTOCODE_AUTH_TOKEN__\s*=\s*"([^"]+)"/);
  return match ? match[1] : '';
}

async function refreshAuthToken() {
  if (authRefreshPromise) return authRefreshPromise;
  authRefreshPromise = (async () => {
    const response = await fetch(`/ui-shell/index.html?authRefresh=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`auth refresh: HTTP ${response.status}`);
    const html = await response.text();
    const token = extractAuthTokenFromHtml(html);
    if (!token) throw new Error('auth refresh token missing');
    updateAuthToken(token);
    return token;
  })();
  try {
    return await authRefreshPromise;
  } finally {
    authRefreshPromise = null;
  }
}

async function fetchWithAuth(url, options = {}, allowAuthRefresh = true) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders(options.headers || {}),
  });
  if (response.status !== 401 || !allowAuthRefresh) return response;
  await refreshAuthToken();
  return fetch(url, {
    ...options,
    headers: authHeaders(options.headers || {}),
  });
}

function activeSessionMessageCount(state = currentState) {
  return state?.activeSession?.messages?.length || 0;
}

function activeSessionTurn(state = currentState) {
  return state?.activeSession?.turn || null;
}

function normalizeTurnPhase(value) {
  return String(value || 'idle').trim().toLowerCase();
}

function isTerminalTurnPhase(phase) {
  return ['completed', 'cancelled', 'failed', 'interrupted'].includes(phase);
}

function describeTurnPhase(turn) {
  const phase = normalizeTurnPhase(turn?.phase);
  if (phase === 'running') {
    return turn?.activeSseClients > 0
      ? t('turn.runningStreaming', 'running · stream attached')
      : t('turn.runningRecovering', 'running · waiting for stream');
  }
  return t(`turn.${phase}`, phase || 'idle');
}

function beginConversationRuntime(promptText) {
  if (conversationRuntime) conversationRuntime.stopped = true;
  const runtime = {
    promptText,
    sessionId: currentSessionId,
    baselineMessageCount: activeSessionMessageCount(),
    baselineTurnId: activeSessionTurn()?.turnId || null,
    tokenCount: 0,
    // P8-C: track last token arrival so the "AI is responding" indicator can
    // stay hidden while the assistant is actively streaming output, and show
    // again when the stream pauses (thinking / tool call / background work).
    lastTokenAt: 0,
    stopped: false,
    settledState: null,
    settledViaSnapshot: false,
    watcherPromise: null,
  };
  conversationRuntime = runtime;
  return runtime;
}

function clearConversationRuntime(runtime) {
  if (runtime) runtime.stopped = true;
  if (conversationRuntime === runtime) conversationRuntime = null;
}

function conversationSettledInState(runtime, state) {
  const turn = activeSessionTurn(state);
  const phase = normalizeTurnPhase(turn?.phase);
  if (turn?.turnId && turn.turnId !== runtime.baselineTurnId) {
    if (phase === 'running') return false;
    if (isTerminalTurnPhase(phase)) return true;
  }

  const messages = state?.activeSession?.messages || [];
  if (messages.length <= runtime.baselineMessageCount) return false;
  const appended = messages.slice(runtime.baselineMessageCount);
  const promptIndex = appended.findIndex((message) => {
    return String(message?.role || '').toLowerCase() === 'user'
      && String(message?.content || '').trim() === runtime.promptText;
  });
  const assistantIndex = appended.findIndex((message) => {
    return String(message?.role || '').toLowerCase() === 'assistant'
      && String(message?.content || '').trim();
  });
  if (assistantIndex < 0) return false;
  return promptIndex < 0 || assistantIndex > promptIndex;
}

async function fetchSessionSnapshot(sessionId) {
  const params = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const [stateResponse, eventsResponse] = await Promise.all([
    fetchWithAuth(`/api/state${params}`),
    fetchWithAuth(`/api/events${params}`),
  ]);
  if (!stateResponse.ok) {
    const message = await stateResponse.text();
    throw new Error(message || `state: HTTP ${stateResponse.status}`);
  }
  const state = await stateResponse.json();
  if (eventsResponse.ok) {
    const events = await eventsResponse.json();
    currentEventFeed = events.events || events.items || [];
    state.eventFeed = currentEventFeed;
  }
  return state;
}

const sessionController = window.createOctocodeSessionController({
  sessionStorageKey: 'octocode-browser-session-id',
  getCurrentSessionId: () => currentSessionId,
  getRequestedSessionId: () => String(urlState.searchParams.get('session') || '').trim(),
  getTerminalCount: () => terminalSessions.length,
  extractSessionId,
  postForm,
  applyState,
  closeAllTerminalSessions,
  fetchSessionSnapshot,
  loadState,
  refreshEventFeed,
  renderError,
  requestStreamStop,
  resetStreamingUiState,
  setConnectionState,
});

async function monitorConversationSettlement(runtime) {
  while (!runtime.stopped && streamAbortController) {
    await delay(STREAM_STATE_POLL_MS);
    if (runtime.stopped || !streamAbortController) break;
    try {
      const state = await fetchSessionSnapshot(runtime.sessionId);
      if (!conversationSettledInState(runtime, state)) continue;
      runtime.settledState = state;
      runtime.settledViaSnapshot = true;
      if (streamAbortController) streamAbortController.abort();
      return;
    } catch (_) {}
  }
}

function scheduleSnapshotRefresh() {
  if (snapshotRefreshTimer) window.clearInterval(snapshotRefreshTimer);
  snapshotRefreshTimer = window.setInterval(() => {
    if (document.hidden || isSubmitting || !currentSessionId) return;
    void sessionController.syncSessionSnapshot();
  }, SNAPSHOT_REFRESH_MS);
}

let recoveryRefreshTimer = null;
function scheduleRecoveryRefresh() {
  if (recoveryRefreshTimer || isSubmitting) return;
  recoveryRefreshTimer = window.setTimeout(() => {
    recoveryRefreshTimer = null;
    if (!isSubmitting && currentSessionId) {
      void sessionController.syncSessionSnapshot();
    }
  }, 3000);
}

function setConnectionState(state) {
  if (!statusConnection) return;
  statusConnection.className = `status-connection ${state}`;
  const labels = {
    connected: t('status.connected', '● connected'),
    disconnected: t('status.disconnected', '● disconnected'),
    loading: t('status.loading', '● loading...'),
  };
  statusConnection.textContent = labels[state] || state;
}

function showToast(message, type = 'info') {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(value || '')));
  return div.innerHTML;
}

function pathBaseName(path) {
  if (!path) return '-';
  const normalized = String(path).replace(/\\/g, '/').replace(/\/$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : normalized;
}

function normalizePermissionValue(value) {
  switch (String(value || '')) {
    case 'ReadOnly':
    case 'readOnly':
    case 'read-only':
      return 'read-only';
    case 'DangerFullAccess':
    case 'dangerFullAccess':
    case 'danger-full-access':
      return 'danger-full-access';
    case 'WorkspaceWrite':
    case 'workspaceWrite':
    case 'workspace-write':
      return 'workspace-write';
    default:
      return 'workspace-write';
  }
}

function resolveSupportedLocale(locale) {
  if (!locale) return 'zh-CN';
  if (builtInLocales.includes(locale)) return locale;
  if (locale.startsWith('zh')) return 'zh-CN';
  if (locale.startsWith('ja')) return 'ja-JP';
  if (locale.startsWith('ko')) return 'ko-KR';
  return 'en-US';
}

function updateClock() {
  if (!menuTime) return;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  menuTime.textContent = `${year}-${month}-${day} ${hour}`;
}

function syncLocaleControls() {
  localeButtons.forEach((button) => {
    const active = button.dataset.locale === activeLocale;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function syncViewControls(view) {
  sidebarTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  activityButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === view));
}

function syncManagePanelControls(panel) {
  managePanelButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.managePanel === panel);
  });
  managePanelSections.forEach((section) => {
    section.classList.toggle('active', section.id === `manage-panel-${panel}`);
  });
  const meta = managePanelMeta[panel] || managePanelMeta.overview;
  if (managePanelTitle) managePanelTitle.textContent = t(meta.titleKey, meta.titleFallback);
  if (managePanelSubtitle) managePanelSubtitle.textContent = t(meta.subtitleKey, meta.subtitleFallback);
}

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle('is-loading', loading);
  const sendIcon = button.querySelector('.send-icon');
  const stopIcon = button.querySelector('.stop-icon');
  if (sendIcon && stopIcon) {
    sendIcon.style.display = loading ? 'none' : '';
    stopIcon.style.display = loading ? '' : 'none';
  }
  syncSubmitButtonLabel();
}

function syncSubmitButtonLabel() {
  if (!submitBtnLabel || !submitBtn) return;
  const label = isSubmitting ? t('composer.stop', '停止') : t('composer.send', '发送');
  submitBtnLabel.textContent = label;
  submitBtn.setAttribute('aria-label', label);
  submitBtn.title = label;
}

function resetStreamingUiState(options = {}) {
  const { abortActive = false } = options;
  if (abortActive && streamAbortController) {
    try {
      streamAbortController.abort();
    } catch (_) {}
  }
  streamAbortController = null;
  isSubmitting = false;
  if (streamIndicator) streamIndicator.hidden = true;
  setButtonLoading(submitBtn, false);
}

function closeDropdown(button, panel) {
  if (!button || !panel) return;
  panel.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

function closeAllDropdowns(exceptPanel = null) {
  dropdownPairs.forEach(({ button, panel }) => {
    if (!button || !panel || panel === exceptPanel) return;
    closeDropdown(button, panel);
  });
}

function closeContextMenu() {
  if (!contextMenu) return;
  contextMenu.hidden = true;
  contextMenu.replaceChildren();
}

function openContextMenu(anchor, items) {
  if (!contextMenu || !anchor || !items?.length) return;
  contextMenu.replaceChildren();
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-menu-item';
    button.textContent = item.label;
    button.addEventListener('click', async () => {
      closeContextMenu();
      await item.action();
    });
    contextMenu.appendChild(button);
  });
  const rect = anchor.getBoundingClientRect();
  contextMenu.style.left = `${Math.min(window.innerWidth - 220, rect.right - 180)}px`;
  contextMenu.style.top = `${Math.min(window.innerHeight - 160, rect.bottom + 6)}px`;
  contextMenu.hidden = false;
}

function openDropdown(button, panel) {
  if (!button || !panel) return;
  closeAllDropdowns(panel);
  panel.hidden = false;
  button.setAttribute('aria-expanded', 'true');
}

function toggleDropdown(button, panel) {
  if (!button || !panel) return;
  if (panel.hidden) openDropdown(button, panel);
  else closeDropdown(button, panel);
}

function renderWorkObject() {
  const sessionId = currentSessionId || '-';
  if (!breadcrumbSession || !workObjectPathEl || !breadcrumbSessionId) return;
  if (currentWorkObject.type === 'folder') {
    breadcrumbSession.textContent = currentWorkObject.path || '-';
    workObjectPathEl.textContent = '';
  } else {
    const lineage = describeSessionLineage(activeSessionSummary());
    breadcrumbSession.textContent = currentWorkObject.name || '-';
    workObjectPathEl.textContent = lineage || currentWorkObject.path || '-';
  }
  breadcrumbSessionId.textContent = sessionId;
}

function setCurrentWorkObject(nextObject) {
  currentWorkObject = { ...currentWorkObject, ...nextObject };
  renderWorkObject();
}

function linkifyWorkspacePaths(html) {
  if (!html) return html;
  // Recognise the tool output prefixes that embed a workspace path and
  // wrap the path in a clickable <a> pointing at /api/fs/read. Runs on the
  // already-rendered HTML so existing markdown links are preserved.
  // Matches e.g. "created foo.txt", "wrote src/main.rs", "appended to x.md",
  // "deleted test.text", "saved to notes.md", "moved a -> b".
  const verbs = '(created|wrote|appended to|saved to|deleted|moved|patched|updated)';
  const pathish = "([^\\s<>'\"`]+\\.[A-Za-z0-9_.+-]{1,16}|[^\\s<>'\"`]+[/\\\\][^\\s<>'\"`]+)";
  const re = new RegExp(`\\b${verbs}\\s+(${pathish})`, 'gi');
  return html.replace(re, (match, verb, full, path) => {
    const encoded = encodeURIComponent(path);
    return `${verb} <a href="/api/fs/read?path=${encoded}" data-fs-link data-fs-path="${path}" target="_blank" rel="noopener">${path}</a>`;
  });
}

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
    try {
      marked.setOptions({
        highlight(code, lang) {
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
      let html = marked.parse(text);
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      html = html.replace(/\son\w+\s*=/gi, ' data-blocked=');
      html = linkifyWorkspacePaths(html);
      return html;
    } catch (_) {}
  }
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = linkifyWorkspacePaths(html);
  return html;
}

function syncHighlightTheme(theme) {
  const styleSheet = document.getElementById('hljs-light');
  if (!styleSheet) return;
  styleSheet.href = theme === 'dark'
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeToggle) {
    themeToggle.textContent = theme === 'dark' ? '☾' : '☀';
    themeToggle.title = theme === 'dark'
      ? t('theme.toLight', 'Switch to light theme')
      : t('theme.toDark', 'Switch to dark theme');
  }
  syncHighlightTheme(theme);
  document.querySelectorAll('[data-color-scheme]').forEach((button) => {
    button.classList.toggle('active', button.dataset.colorScheme === theme);
  });
  try {
    localStorage.setItem('octocode-theme', theme);
  } catch (_) {}
}

async function loadLocalePlugin() {
  const pluginUrl = urlState.searchParams.get('localePlugin');
  activeLocale = resolveSupportedLocale(urlState.searchParams.get('locale') || navigator.language || 'zh-CN');
  const candidates = pluginUrl
    ? [pluginUrl]
    : [`/ui-shell/locales/${activeLocale}.json`, '/ui-shell/locales/en-US.json'];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: 'no-store' });
      if (!response.ok) continue;
      const messages = await response.json();
      applyLocaleMessages(messages);
      return;
    } catch (_) {}
  }
  applyLocaleMessages({});
}

function applyLocaleMessages(messages) {
  localeMessages = messages || {};
  localeElements.forEach((element) => {
    const key = element.dataset.i18n;
    if (messages[key]) element.textContent = messages[key];
  });
  localePlaceholders.forEach((element) => {
    const key = element.dataset.i18nPlaceholder;
    if (messages[key]) element.placeholder = messages[key];
  });
  localeTitles.forEach((element) => {
    const key = element.dataset.i18nTitle;
    if (messages[key]) element.title = messages[key];
  });
  syncSubmitButtonLabel();
  syncLocaleControls();
  updateClock();
  if (currentState) render(currentState);
  else renderWorkObject();
}

async function requestStreamStop(sessionId = currentSessionId) {
  if (!sessionId) return;
  try {
    await postForm('/api/sessions/stop', { sessionId });
  } catch (error) {
    console.warn('failed to stop active session stream', error);
  }
}

async function setActiveLocale(locale) {
  activeLocale = resolveSupportedLocale(locale);
  urlState.searchParams.set('locale', activeLocale);
  window.history.replaceState({}, '', urlState);
  await loadLocalePlugin();
  closeDropdown(viewMenuButton, viewLanguageMenu);
}

async function postForm(url, fields, options = {}) {
  const { keepalive = false } = options;
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) body.set(key, String(value));
  });
  const response = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    keepalive,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchJson(url) {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}

async function refreshEventFeed(sessionId) {
  try {
    const params = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
    const response = await fetchWithAuth(`/api/events${params}`);
    if (!response.ok) return;
    const data = await response.json();
    currentEventFeed = data.events || data.items || [];
    if (currentState) currentState.eventFeed = currentEventFeed;
  } catch (_) {}
}

async function loadState(sessionId) {
  setConnectionState('loading');
  try {
    const state = await fetchSessionSnapshot(sessionId);
    setConnectionState('connected');
    applyState(state, sessionId);
  } catch (error) {
    setConnectionState('disconnected');
    renderError(error);
  }
}

function applyState(state, sessionId) {
  currentState = state;
  const activeSession = state.activeSession || state.sessions?.[0] || null;
  // BugFix-1: session isolation. Pin `currentSessionId` to the caller's
  // explicit sessionId whenever one was supplied. Previously we fell
  // through to `activeSession?.summary?.id` — which silently re-pointed
  // this tab at whichever session the server happened to mark active
  // (e.g. one another tab just wrote to), causing messages typed in THIS
  // tab to land in ANOTHER tab's transcript. The server's activeSession
  // is only used when this tab has no session identity yet.
  if (sessionId) {
    currentSessionId = sessionId;
  } else if (!currentSessionId) {
    currentSessionId = activeSession?.summary?.id || activeSession?.sessionId || null;
  }
  // Always render the transcript for the session this tab is pinned to,
  // not whatever the server currently considers "active". If the server
  // snapshot happens to include a different session's messages, ignore
  // them.
  const pinnedSession = currentSessionId && activeSession
    && (activeSession?.summary?.id === currentSessionId
      || activeSession?.sessionId === currentSessionId)
    ? activeSession
    : (state.sessions || []).find((s) =>
        (s?.summary?.id || s?.sessionId) === currentSessionId) || null;
  currentMessages = pinnedSession?.messages || [];
  if (currentSessionId) {
    urlState.searchParams.set('session', currentSessionId);
  } else {
    urlState.searchParams.delete('session');
  }
  window.history.replaceState({}, '', urlState);
  render(state);
}

function render(state) {
  if (!state) return;
  const activeSession = state.activeSession || state.sessions?.[0] || null;
  renderHeader(state, activeSession);
  renderSidebar(state, currentSessionId);
  renderMessages(currentMessages);
  renderInfoCards(state);
  renderSettings(state);
  renderManagePanel(state);
  renderStatusBar(state);
  renderTerminalUi();
  updateClock();
}

function renderHeader(state, activeSession) {
  const sessionId = activeSession?.summary?.id || currentSessionId || '-';
  const summary = activeSession?.summary || activeSession || null;
  if (sessionTitle) {
    sessionTitle.textContent = activeSession?.summary?.title
      || activeSession?.summary?.label
      || activeSession?.summary?.id
      || t('session.interactive', '交互式会话');
  }
  if (composerSession) composerSession.textContent = `${t('session.label', 'session')}: ${sessionId}`;
  if (platformPill) platformPill.textContent = state.workspace?.platform || state.config?.platform || '-';
  if (permissionPill) permissionPill.textContent = state.config?.permissionMode || '-';
  if (providerId) providerId.textContent = state.status?.activeProviderId || state.status?.providerId || 'loading';
  if (menuProvider) menuProvider.textContent = state.status?.activeProviderId || state.status?.providerId || '-';
  if (menuPlatform) menuPlatform.textContent = state.workspace?.platform || '-';
  if (modelInfoName) modelInfoName.textContent = state.config?.defaultModel || activeSession?.summary?.model || '-';
  if (modelInfoProvider) modelInfoProvider.textContent = state.status?.activeProviderId || state.status?.providerId || '-';
  if (summary?.branchName && sessionTitle) {
    sessionTitle.textContent = `${sessionTitle.textContent} · ${summary.branchName}`;
  }
  renderWorkObject();
}

function renderInfoCards(state) {
  if (workspaceRoot) workspaceRoot.textContent = state.workspace?.root || '-';
  if (workspaceShell) workspaceShell.textContent = state.workspace?.shell || '-';
  if (defaultModel) defaultModel.textContent = state.config?.defaultModel || '-';
  if (sessionCount) sessionCount.textContent = String(state.sessions?.length || 0);
  if (sessionCountInline) sessionCountInline.textContent = String(state.sessions?.length || 0);
  if (activeProviderEl) activeProviderEl.textContent = state.status?.activeProviderId || '-';
  if (circuitStateEl) circuitStateEl.textContent = state.status?.providerCircuit?.circuitState || '-';
}

function renderSettings(state) {
  const providers = state.providers || [];
  const profiles = manageCatalog?.providerProfiles || [];
  if (!manageCatalog) void ensureManageCatalog();
  if (settingProvider && (providers.length || profiles.length)) {
    settingProvider.replaceChildren();
    providers.forEach((provider) => {
      const option = document.createElement('option');
      option.value = provider.id || provider;
      option.textContent = provider.label || provider.id || provider;
      settingProvider.appendChild(option);
    });
    profiles.forEach((profile) => {
      const option = document.createElement('option');
      option.value = `profile:${profile.id}`;
      option.textContent = `${profile.displayName || profile.id} [profile]`;
      settingProvider.appendChild(option);
    });
  }
  if (state.config && settingProvider) {
    const matchedProfile = profiles.find((profile) =>
      profile.providerId === state.config.providerId
      && (profile.providerBaseUrl || '') === (state.config.providerBaseUrl || '')
      && (profile.defaultModel || '') === (state.config.defaultModel || '')
    );
    settingProvider.value = matchedProfile ? `profile:${matchedProfile.id}` : (state.config.providerId || '');
    settingBaseUrl.value = state.config.providerBaseUrl || '';
    settingModel.value = state.config.defaultModel || '';
    settingPermission.value = normalizePermissionValue(state.config.permissionMode);
    settingHistory.value = state.config.historyLimit || 50;
  }

  const tools = manageCatalog?.tools || state.tools || [];
  if (tools.length && toolName) {
    toolName.replaceChildren();
    tools.forEach((tool) => {
      const option = document.createElement('option');
      option.value = tool.name;
      option.textContent = `${tool.name} - ${tool.summary || ''}`;
      toolName.appendChild(option);
    });
  }
}

function selectedProviderProfile() {
  const rawValue = settingProvider?.value || '';
  if (!rawValue.startsWith('profile:')) return null;
  const profileId = rawValue.slice('profile:'.length);
  return (manageCatalog?.providerProfiles || []).find((profile) => profile.id === profileId) || null;
}

function resolveSettingsSubmissionFields() {
  const profile = selectedProviderProfile();
  if (profile) {
    return {
      providerId: profile.providerId,
      providerBaseUrl: profile.providerBaseUrl || '',
      defaultModel: profile.defaultModel || '',
    };
  }
  return {
    providerId: settingProvider?.value || '',
    providerBaseUrl: settingBaseUrl?.value || '',
    defaultModel: settingModel?.value || '',
  };
}

function syncProviderProfileSelection() {
  const profile = selectedProviderProfile();
  if (!profile) return;
  if (settingBaseUrl) settingBaseUrl.value = profile.providerBaseUrl || '';
  if (settingModel) settingModel.value = profile.defaultModel || '';
}

function renderStatusBar(state) {
  const summary = activeSessionSummary(state);
  if (statusProvider) statusProvider.textContent = `${t('status.provider', 'provider')}: ${state.status?.activeProviderId || '-'}`;
  if (statusWorkspace) statusWorkspace.textContent = `${t('status.workspace', 'workspace')}: ${state.workspace?.root || '-'}`;
  if (statusShell) statusShell.textContent = `${t('status.shell', 'shell')}: ${state.workspace?.shell || '-'}`;
  const turn = activeSessionTurn(state);
  const phase = normalizeTurnPhase(turn?.phase);
  if (statusPermission) {
    statusPermission.textContent = `${t('status.permission', 'permission')}: ${state.config?.permissionMode || '-'}`;
  }
  if (statusTurn) {
    statusTurn.textContent = `${t('status.turn', 'turn')}: ${describeTurnPhase(turn)}`;
    statusTurn.dataset.phase = phase;
  }
  if (statusBranch) {
    statusBranch.textContent = describeSessionLineage(summary) || t('session.rootBranch', 'branch: root');
  }
  if (streamIndicatorLabel) {
    // P8-C / BugFix-2 / live-P13: label reflects the *reason* the indicator
    // is on. We prioritize **client-observed** streaming state over the
    // server's turn phase, because the SSE stream begins before the phase
    // snapshot rolls forward. That race previously left the label stuck at
    // "AI 正在响应..." during the model's think phase even while the backend
    // was still awaiting the first token.
    const rt = conversationRuntime;
    const now = Date.now();
    const sinceLastToken = rt && rt.lastTokenAt > 0 ? (now - rt.lastTokenAt) : Infinity;
    const isStreamingOutput = rt && rt.tokenCount > 0 && sinceLastToken < 1200;
    // Awaiting-first-token no longer requires lastTokenAt to be falsy — a
    // freshly-begun runtime with tokenCount===0 is always in "thinking" even
    // when the client has not yet observed a token timestamp.
    const isAwaitingFirstToken = rt && !rt.stopped && rt.tokenCount === 0;
    if (isStreamingOutput) {
      streamIndicatorLabel.textContent = t('stream.outputting', '输出中...');
    } else if (isAwaitingFirstToken) {
      streamIndicatorLabel.textContent = t('stream.thinking', 'AI 思考中...');
    } else if (phase === 'running') {
      streamIndicatorLabel.textContent = (turn?.activeSseClients > 0)
        ? (rt && rt.tokenCount > 0
          ? t('stream.toolOrThink', '工具调用 / 思考中...')
          : t('stream.thinking', 'AI 思考中...'))
        : t('stream.recovering', '后端 turn 运行中，等待流恢复...');
    } else if (isSubmitting) {
      // Submit in progress but no runtime attached yet (ensureWritableSession
      // / SSE open pending). Show "thinking" rather than the generic
      // "responding" fallback so operators see truthful state.
      streamIndicatorLabel.textContent = t('stream.thinking', 'AI 思考中...');
    } else {
      streamIndicatorLabel.textContent = t('stream.responding', 'AI is responding...');
    }
  }
  if (streamIndicator && !isSubmitting) {
    // P8-C / BugFix-2: Show the indicator whenever a client stream is
    // live (awaiting first token OR between tokens) OR the server turn
    // is running with no active SSE (recovery window). Hide only when
    // tokens are actively arriving — in that case the streaming bubble
    // itself is the user's visual cue.
    const rt = conversationRuntime;
    const now = Date.now();
    const sinceLastToken = rt?.lastTokenAt ? (now - rt.lastTokenAt) : Infinity;
    const isStreamingOutput = rt && rt.tokenCount > 0 && sinceLastToken < 1200;
    const isAwaitingFirstToken = rt && !rt.stopped && rt.tokenCount === 0;
    const hasActiveSse = Number(turn?.activeSseClients || 0) > 0;
    const shouldShow = !isStreamingOutput
      && (isAwaitingFirstToken || (phase === 'running' && hasActiveSse));
    streamIndicator.hidden = !shouldShow;
    if (shouldShow) scheduleRecoveryRefresh();
  }
}

function activeSessionSummary(state = currentState) {
  const activeSession = state?.activeSession
    || state?.sessions?.find((session) => (session?.id || session?.sessionId) === currentSessionId);
  return activeSession?.summary || activeSession || null;
}

function describeSessionLineage(summary) {
  const parts = [];
  if (summary?.branchName) parts.push(`branch: ${summary.branchName}`);
  if (summary?.parentId) parts.push(`parent: ${summary.parentId}`);
  return parts.join(' · ');
}

function buildSessionDescription(session) {
  const summary = session?.summary || session;
  const parts = [summary?.model || t('session.noModel', '未绑定模型')];
  const lineage = describeSessionLineage(summary);
  if (lineage) parts.push(lineage);
  parts.push(summary?.id || session?.sessionId || '-');
  return parts.join(' · ');
}

function defaultForkBranchName(messageIndex) {
  const summary = activeSessionSummary();
  const base = String(summary?.branchName || summary?.title || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'branch';
  return Number.isInteger(messageIndex) ? `${base}-m${messageIndex + 1}` : `${base}-fork`;
}

function normalizeForkBranchName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function setForkBranchName(value) {
  const branchName = String(value || '');
  forkDialogState.branchName = branchName;
  forkDialogState.normalizedBranchName = normalizeForkBranchName(branchName);
}

async function forkSessionFromHistory(options = {}) {
  const parentSessionId = String(options.parentSessionId || currentSessionId || '').trim();
  if (!parentSessionId) return;
  const parentSession = (currentState?.sessions || []).find((session) => (session.id || session.sessionId) === parentSessionId);
  forkDialogState = {
    open: true,
    pending: false,
    parentSessionId,
    parentSessionTitle: parentSession?.title || parentSession?.summary?.title || parentSessionId,
    messageIndex: Number.isInteger(options.messageIndex) ? options.messageIndex : null,
    branchName: '',
    normalizedBranchName: '',
    defaultBranchName: String(options.defaultBranchName || defaultForkBranchName(options.messageIndex)).trim(),
    error: '',
  };
  setForkBranchName(forkDialogState.defaultBranchName);
  closeContextMenu();
  renderForkDialog();
  if (forkDialog) forkDialog.hidden = false;
  requestAnimationFrame(() => {
    forkBranchNameInput?.focus();
    forkBranchNameInput?.select();
  });
}

function buildSidebarItems(state, activeSessionId) {
  const sessions = (state.sessions || []).map((session, index) => {
    const summary = session.summary || session;
    return {
      raw: session,
      index,
      id: summary.id || session.sessionId,
      title: summary.title || summary.label || summary.id || session.sessionId || t('session.label', 'session'),
      description: buildSessionDescription(session),
      branchName: summary.branchName || '',
      parentId: summary.parentId || '',
      active: (summary.id || session.sessionId) === activeSessionId,
    };
  });
  const nodesById = new Map(sessions.map((item) => [item.id, item]));
  const childrenByParent = new Map();
  const roots = [];
  sessions.forEach((item) => {
    if (item.parentId && nodesById.has(item.parentId)) {
      const siblings = childrenByParent.get(item.parentId) || [];
      siblings.push(item);
      childrenByParent.set(item.parentId, siblings);
      return;
    }
    roots.push(item);
  });
  const items = [];
  const activePathIds = new Set();
  let activeNode = nodesById.get(activeSessionId);
  while (activeNode) {
    activePathIds.add(activeNode.id);
    activeNode = activeNode.parentId ? nodesById.get(activeNode.parentId) : null;
  }
  function visit(node, depth, ancestry) {
    const children = (childrenByParent.get(node.id) || []).sort((left, right) => left.index - right.index);
    const hasChildren = children.length > 0;
    const branchLabel = node.branchName || (depth === 0 ? t('session.rootNode', 'root') : t('session.branchNode', 'branch'));
    const lineage = [...ancestry, branchLabel].join(' / ');
    const collapsed = hasChildren && collapsedSessionTreeIds.has(node.id) && !activePathIds.has(node.id);
    items.push({
      ...node,
      depth,
      branchLabel,
      lineage,
      hasChildren,
      collapsed,
      onSelect: () => { void sessionController.switchSession(node.id); },
    });
    if (collapsed) return;
    children.forEach((child) => visit(child, depth + 1, [...ancestry, branchLabel]));
  }
  roots.sort((left, right) => left.index - right.index).forEach((root) => visit(root, 0, []));
  return items;
}

function renderSidebar(state, activeSessionId) {
  currentView = 'sessions';
  syncViewControls('sessions');
  if (sidebarTitle) sidebarTitle.textContent = t('sidebar.sessions', 'Sessions');
  const items = buildSidebarItems(state, activeSessionId);
  // Dedupe identical re-renders so the 15s snapshot refresh does not
  // tear down and rebuild every sidebar row (visible flicker).
  const sig = JSON.stringify({
    a: activeSessionId,
    items: items.map((it) => [it.id, it.active ? 1 : 0, it.collapsed ? 1 : 0, it.depth || 0, it.title, it.description, it.lineage || '', it.branchLabel || '']),
  });
  if (sig === lastRenderedSidebarSignature) return;
  lastRenderedSidebarSignature = sig;
  sidebarList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-item';
    empty.innerHTML = `<div class="sidebar-item-desc">${escapeHtml(t('sidebar.noData', '当前没有可以显示的数据'))}</div>`;
    sidebarList.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = `sidebar-row${item.active ? ' active' : ''}`;
    row.dataset.depth = String(item.depth || 0);
    row.style.setProperty('--tree-depth', String(item.depth || 0));
    row.style.setProperty('--tree-indent', `${(item.depth || 0) * 18}px`);
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `sidebar-item${item.active ? ' active' : ''}`;
    const toggleMarkup = item.hasChildren
      ? `<span class="session-tree-toggle" role="button" aria-label="${escapeHtml(item.collapsed ? t('session.expandBranch', '展开分支') : t('session.collapseBranch', '折叠分支'))}" data-expanded="${item.collapsed ? 'false' : 'true'}">${item.collapsed ? '▸' : '▾'}</span>`
      : '<span class="session-tree-spacer"></span>';
    element.innerHTML = `
      <div class="sidebar-item-row">
        ${toggleMarkup}
        <span class="sidebar-item-branch-badge" title="${escapeHtml(item.lineage || '')}">${escapeHtml(item.lineage || item.branchLabel || t('session.rootNode', 'root'))}</span>
        <span class="sidebar-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
      </div>
      <div class="sidebar-item-desc">${escapeHtml(item.description)}</div>
    `;
    if (typeof item.onSelect === 'function') element.addEventListener('click', item.onSelect);
    const toggleButton = element.querySelector('.session-tree-toggle');
    if (toggleButton) {
      toggleButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (collapsedSessionTreeIds.has(item.id)) collapsedSessionTreeIds.delete(item.id);
        else collapsedSessionTreeIds.add(item.id);
        writeCollapsedSessionTreeIds();
        if (currentState) renderSidebar(currentState, currentSessionId);
      });
    }

    const actions = document.createElement('button');
    actions.type = 'button';
    actions.className = 'session-menu-btn';
    actions.textContent = '⋯';
    actions.setAttribute('aria-label', t('session.actions', '会话菜单'));
    actions.addEventListener('click', (event) => {
      event.stopPropagation();
      openContextMenu(actions, [
        {
          label: t('session.open', '打开会话'),
          action: async () => item.onSelect(),
        },
        {
          label: t('session.copyId', '复制会话 ID'),
          action: async () => {
            try {
              if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(item.id || '');
              showToast(t('session.copyIdDone', '会话 ID 已复制'), 'success');
            } catch (_) {
              showToast(t('session.copyIdFailed', '无法复制会话 ID'), 'error');
            }
          },
        },
        {
          label: t('session.fork', 'Fork 新会话'),
          action: async () => forkSessionFromHistory({
            parentSessionId: item.id,
            defaultBranchName: `${String(item.branchName || item.id || 'session').trim() || 'session'}-fork`,
          }),
        },
        {
          label: t('session.delete', '删除会话'),
          action: async () => deleteSessionById(item.id),
        },
      ]);
    });

    row.appendChild(element);
    row.appendChild(actions);
    sidebarList.appendChild(row);
  });
}

function formatTimestamp(timestamp) {
  if (!timestamp) return '';
  try {
    const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
    return date.toLocaleTimeString(activeLocale || 'zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (_) {
    return '';
  }
}

function transcriptEventsToMessages(events) {
  return (events || [])
    .filter((event) => event?.scope === 'transcript' && event?.message)
    .map((event) => {
      const raw = String(event.message);
      const match = raw.match(/^(user|assistant|tool|system)\s+([\s\S]*)$/i);
      if (!match) {
        return {
          role: 'system',
          content: raw,
          timestamp: event.atMs || Date.now(),
        };
      }
      return {
        role: match[1].toLowerCase(),
        content: match[2],
        timestamp: event.atMs || Date.now(),
      };
    });
}

function renderMessages(messages) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const events = currentState?.eventFeed || currentEventFeed || [];
  const messagesToRender = sourceMessages.length ? sourceMessages : transcriptEventsToMessages(events);
  // Skip the full DOM rebuild when neither the messages nor the relevant
  // render parameters have changed. Otherwise every 15-second snapshot
  // refresh causes a full replaceChildren() flicker even when the
  // transcript is identical.
  const signature = JSON.stringify({
    n: messagesToRender.length,
    mode: activeViewMode,
    model: currentState?.config?.defaultModel || '',
    items: messagesToRender.map((m) => [m.role || 'system', String(m.content || '').length, m.timestamp || m.atMs || 0]),
  });
  if (signature === lastRenderedMessagesSignature) return;
  lastRenderedMessagesSignature = signature;
  const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 40;
  messageList.replaceChildren();
  if (!messagesToRender.length) {
    const empty = document.createElement('div');
    empty.className = 'message-empty';
    empty.textContent = t('message.empty', '当前没有消息。通过下方输入框发送消息开始对话。');
    messageList.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  messagesToRender.forEach((message, index) => {
    const role = message.role || 'system';
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble role-${role}`;
    bubble.dataset.index = String(index);
    const content = message.content || '';
    let contentHtml = renderMarkdown(content);
    if (activeViewMode === 'compact' && content.length > 220) {
      contentHtml = escapeHtml(content.slice(0, 220)) + '…';
    }
    const header = document.createElement('div');
    header.className = 'msg-header';
    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    const modelTag = role === 'assistant' && currentState?.config?.defaultModel
      ? `<span class="msg-model">${escapeHtml(currentState.config.defaultModel)}</span>`
      : '';
    roleEl.innerHTML = `${escapeHtml(role)}${modelTag}`;
    header.appendChild(roleEl);
    const contentEl = document.createElement('div');
    contentEl.className = 'msg-content';
    contentEl.innerHTML = contentHtml;
    const footer = document.createElement('div');
    footer.className = 'msg-footer';
    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = formatTimestamp(message.timestamp || message.atMs);
    footer.appendChild(timeEl);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy-btn';
    copyBtn.setAttribute('aria-label', t('message.copy', '复制消息内容'));
    copyBtn.title = t('message.copy', '复制消息内容');
    copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    copyBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const text = message.content || '';
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        const original = copyBtn.innerHTML;
        copyBtn.classList.add('is-copied');
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => {
          copyBtn.classList.remove('is-copied');
          copyBtn.innerHTML = original;
        }, 1200);
      } catch (_) {
        copyBtn.classList.add('is-failed');
        setTimeout(() => copyBtn.classList.remove('is-failed'), 1200);
      }
    });
    footer.appendChild(copyBtn);
    bubble.appendChild(header);
    bubble.appendChild(contentEl);
    bubble.appendChild(footer);
    fragment.appendChild(bubble);
  });
  messageList.appendChild(fragment);
  if (nearBottom) {
    requestAnimationFrame(() => {
      messageList.scrollTop = messageList.scrollHeight;
    });
  }
}

function renderError(error) {
  resetStreamingUiState();
  if (providerId) providerId.textContent = 'offline';
  if (sessionTitle) sessionTitle.textContent = t('error.loadFailed', '交互状态加载失败');
  if (composerSession) composerSession.textContent = `${t('session.label', 'session')}: offline`;
  if (platformPill) platformPill.textContent = '-';
  if (permissionPill) permissionPill.textContent = '-';
  if (workspaceRoot) workspaceRoot.textContent = '-';
  if (workspaceShell) workspaceShell.textContent = '-';
  if (defaultModel) defaultModel.textContent = '-';
  if (sessionCount) sessionCount.textContent = '0';
  if (menuProvider) menuProvider.textContent = 'offline';
  if (menuPlatform) menuPlatform.textContent = '-';
  if (sidebarTitle) sidebarTitle.textContent = t('status.offline', 'Offline');
  renderWorkObject();
  sidebarList.innerHTML = `<div class="sidebar-item"><div class="sidebar-item-desc">${escapeHtml(t('error.cannotConnect', '无法连接到服务器'))}</div></div>`;
  messageList.innerHTML = `<div class="msg-bubble role-system"><div class="msg-role">SYSTEM</div><div class="msg-content">${escapeHtml(t('error.recoverHint', '请运行 octocode-cli serve --port 999 --session demo 后刷新页面。'))}\n\n${escapeHtml(error.message || String(error))}</div></div>`;
  terminalVisible = false;
  renderTerminalUi();
}

function currentWorkspaceRoot() {
  return currentState?.workspace?.root || '.';
}

function pathDirName(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/$/, '');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return normalized;
  const parent = normalized.slice(0, index) || normalized.slice(0, index + 1);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

function joinPath(basePath, childName) {
  const separator = String(basePath || '').includes('\\') ? '\\' : '/';
  return `${String(basePath || '').replace(/[\\/]$/, '')}${separator}${String(childName || '').replace(/^[\\/]+/, '')}`;
}

function renderManageCards(host, items, buildMeta) {
  if (!host) return;
  host.replaceChildren();
  if (!items || !items.length) {
    const empty = document.createElement('div');
    empty.className = 'manage-empty';
    empty.textContent = t('manage.empty', '当前面板没有可展示的数据。');
    host.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const meta = buildMeta(item);
    const card = document.createElement('article');
    card.className = `manage-card${meta.onAction ? ' actionable' : ''}${meta.cardClass ? ` ${meta.cardClass}` : ''}`;
    const detailHtml = (meta.details || [])
      .filter(Boolean)
      .map((line) => `<div class="manage-card-detail">${escapeHtml(line)}</div>`)
      .join('');
    card.innerHTML = `
      <div class="manage-card-head">
        <div class="manage-card-title">${escapeHtml(meta.title || '-')}</div>
        ${meta.badge ? `<span class="manage-card-badge${meta.badgeClass ? ` ${meta.badgeClass}` : ''}">${escapeHtml(meta.badge)}</span>` : ''}
      </div>
      <div class="manage-card-desc">${escapeHtml(meta.description || '-')}</div>
      ${detailHtml}
      ${meta.free ? `<span class="manage-card-free" title="${escapeHtml(t('manage.free.hint', '本地或免费模型'))}">free</span>` : ''}
    `;
    if (typeof meta.onAction === 'function') {
      card.addEventListener('click', meta.onAction);
    }
    host.appendChild(card);
  });
}

function manageCreateCard(label, description, action) {
  return {
    __manageAction: true,
    label,
    description,
    action,
  };
}

// Decide whether a provider profile should be flagged as "free" in the
// manage panel. Resolution order:
//   1. Explicit `isFree` field on the profile (set by the operator or by
//      the curated default seed). True/false here is authoritative.
//   2. Profile id starts with `fcc-` — the curated free-claude-code list
//      that ships pointing at NVIDIA NIM's free public tier.
//   3. Display name or default model literally contains "free".
// The LAN/private-IP catch-all was removed: too many users front their
// paid relays via 127.0.0.1 / 192.168.* and would get a misleading badge.
function isFreeProviderProfile(profile) {
  if (!profile) return false;
  if (profile.isFree === true) return true;
  if (profile.isFree === false) return false;
  const id = String(profile.id || '').toLowerCase();
  const name = String(profile.displayName || '').toLowerCase();
  const model = String(profile.defaultModel || '').toLowerCase();
  if (id.startsWith('fcc-')) return true;
  if (name.includes('free') || model.includes('free')) return true;
  return false;
}

function providerOptionsMarkup(selectedValue = '') {
  return (currentState?.providers || [])
    .map((provider) => {
      const value = provider.id || '';
      const label = provider.label || provider.id || '';
      return `<option value="${escapeHtml(value)}"${value === selectedValue ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
}

function scopeOptionsMarkup(selectedValue = 'user') {
  return ['user', 'workspace']
    .map((scope) => `<option value="${scope}"${scope === selectedValue ? ' selected' : ''}>${scope}</option>`)
    .join('');
}

function closeManageEditor() {
  manageEditorState = null;
  if (manageEditorDialog) manageEditorDialog.hidden = true;
  if (manageEditorFields) manageEditorFields.replaceChildren();
}

function openManageEditor(kind, item = null) {
  if (!manageEditorDialog || !manageEditorFields) return;
  manageEditorState = { kind, item };
  const creating = !item;
  const sourcePath = item?.sourcePath || item?.path || item?.descriptor?.manifestPath || '';

  if (manageEditorTitle) {
    manageEditorTitle.textContent = `${creating ? t('action.add', '新增') : t('action.edit', '编辑')} ${kind}`;
  }
  if (manageEditorSubtitle) {
    manageEditorSubtitle.textContent = sourcePath || t('manage.overviewHint', '查看系统状态、安装配置和工具接入情况。');
  }
  if (manageEditorDelete) manageEditorDelete.hidden = creating;
  if (manageEditorApply) manageEditorApply.hidden = kind !== 'providerProfile' || creating;

  if (kind === 'providerProfile') {
    manageEditorFields.innerHTML = `
      <label><span>Profile ID</span><input name="id" type="text" value="${escapeHtml(item?.id || '')}" /></label>
      <label><span>Display Name</span><input name="displayName" type="text" value="${escapeHtml(item?.displayName || '')}" /></label>
      <label><span>Provider</span><select name="providerId">${providerOptionsMarkup(item?.providerId || currentState?.config?.providerId || '')}</select></label>
      <label><span>Base URL</span><input name="providerBaseUrl" type="text" value="${escapeHtml(item?.providerBaseUrl || '')}" /></label>
      <label><span>Default Model</span><input name="defaultModel" type="text" value="${escapeHtml(item?.defaultModel || '')}" /></label>
    `;
  } else if (kind === 'mcp') {
    manageEditorFields.innerHTML = `
      <label><span>Scope</span><select name="scope">${scopeOptionsMarkup(item?.scope || 'user')}</select></label>
      <label><span>ID</span><input name="id" type="text" value="${escapeHtml(item?.descriptor?.id || '')}" /></label>
      <label><span>Transport</span><select name="transport"><option value="stdio"${(item?.descriptor?.transport || 'stdio') === 'stdio' ? ' selected' : ''}>stdio</option><option value="websocket"${item?.descriptor?.transport === 'websocket' ? ' selected' : ''}>websocket</option></select></label>
      <label><span>Command</span><input name="command" type="text" value="${escapeHtml(item?.descriptor?.command || '')}" /></label>
      <label><span>Endpoint</span><input name="endpoint" type="text" value="${escapeHtml(item?.descriptor?.endpoint || '')}" /></label>
      <label><span>Description</span><input name="description" type="text" value="${escapeHtml(item?.descriptor?.description || '')}" /></label>
      <label><span><input name="trusted" type="checkbox"${item?.descriptor?.trusted ? ' checked' : ''} /> Trusted</span></label>
    `;
  } else if (kind === 'skill') {
    manageEditorFields.innerHTML = `
      <label><span>Scope</span><select name="scope">${scopeOptionsMarkup(item?.scope || 'user')}</select></label>
      <label><span>ID</span><input name="id" type="text" value="${escapeHtml(item?.id || '')}" /></label>
      <label><span>Summary</span><input name="summary" type="text" value="${escapeHtml(item?.summary || '')}" /></label>
      <label><span>Content</span><textarea name="content">${escapeHtml(item?.content || '')}</textarea></label>
    `;
  } else if (kind === 'hook') {
    manageEditorFields.innerHTML = `
      <label><span>Scope</span><select name="scope">${scopeOptionsMarkup(item?.scope || 'user')}</select></label>
      <label><span>Tool (empty = global)</span><input name="tool" type="text" value="${escapeHtml(item?.tool || '')}" /></label>
      <label><span>Command</span><input name="command" type="text" value="${escapeHtml(item?.command || '')}" /></label>
      <label><span>Timing</span><select name="timing"><option value="before"${(item?.timing || 'before') === 'before' ? ' selected' : ''}>before</option><option value="after"${item?.timing === 'after' ? ' selected' : ''}>after</option></select></label>
      <label><span>Timeout (ms)</span><input name="timeoutMs" type="number" min="1000" step="100" value="${escapeHtml(String(item?.timeoutMs || item?.timeout_ms || 5000))}" /></label>
      <label><span><input name="blocking" type="checkbox"${item?.blocking ? ' checked' : ''} /> Blocking</span></label>
    `;
  } else if (kind === 'externalTool') {
    manageEditorFields.innerHTML = `
      <label><span>Scope</span><select name="scope">${scopeOptionsMarkup(item?.scope || 'user')}</select></label>
      <label><span>Name</span><input name="name" type="text" value="${escapeHtml(item?.name || '')}" /></label>
      <label><span>Summary</span><input name="summary" type="text" value="${escapeHtml(item?.summary || '')}" /></label>
      <label><span>Command Template</span><textarea name="commandTemplate">${escapeHtml(item?.commandTemplate || '')}</textarea></label>
      <label><span>Minimum Permission</span><select name="minimumPermission"><option value="read-only"${(item?.minimumPermission || 'danger-full-access') === 'read-only' ? ' selected' : ''}>read-only</option><option value="workspace-write"${(item?.minimumPermission || 'danger-full-access') === 'workspace-write' ? ' selected' : ''}>workspace-write</option><option value="danger-full-access"${(item?.minimumPermission || 'danger-full-access') === 'danger-full-access' ? ' selected' : ''}>danger-full-access</option></select></label>
    `;
  } else if (kind === 'externalCommand') {
    manageEditorFields.innerHTML = `
      <label><span>Scope</span><select name="scope">${scopeOptionsMarkup(item?.scope || 'user')}</select></label>
      <label><span>Name</span><input name="name" type="text" value="${escapeHtml(item?.name || '')}" /></label>
      <label><span>Summary</span><input name="summary" type="text" value="${escapeHtml(item?.summary || '')}" /></label>
      <label><span>Template</span><textarea name="template">${escapeHtml(item?.template || '')}</textarea></label>
    `;
  }

  manageEditorDialog.hidden = false;
}

function manageEditorPayload() {
  if (!manageEditorState || !manageEditorForm) return null;
  const payload = { kind: manageEditorState.kind };
  const formData = new FormData(manageEditorForm);
  formData.forEach((value, key) => {
    payload[key] = value;
  });
  const blocking = manageEditorForm.querySelector('[name="blocking"]');
  const trusted = manageEditorForm.querySelector('[name="trusted"]');
  if (blocking) payload.blocking = blocking.checked;
  if (trusted) payload.trusted = trusted.checked;
  if (manageEditorState.item?.id) payload.originalId = manageEditorState.item.id;
  if (manageEditorState.item?.name) payload.originalName = manageEditorState.item.name;
  if (typeof manageEditorState.item?.index === 'number') payload.originalIndex = manageEditorState.item.index;
  if (manageEditorState.item?.tool) payload.originalTool = manageEditorState.item.tool;
  if (manageEditorState.item?.path) payload.originalPath = manageEditorState.item.path;
  if (manageEditorState.item?.sourcePath) payload.originalPath = manageEditorState.item.sourcePath;
  if (manageEditorState.item?.descriptor?.manifestPath) payload.originalPath = manageEditorState.item.descriptor.manifestPath;
  return payload;
}

async function saveManageEditor() {
  const payload = manageEditorPayload();
  if (!payload) return;
  manageCatalog = await postForm('/api/manage/upsert', payload);
  if (currentState) renderManagePanel(currentState);
  closeManageEditor();
  showToast(t('settings.saved', '设置已保存'), 'success');
}

async function deleteManageEditor() {
  if (!manageEditorState?.item) return;
  if (!window.confirm(t('session.confirmDelete', '确定删除这个会话吗？'))) return;
  const item = manageEditorState.item;
  const payload = { kind: manageEditorState.kind };
  if (item.id) payload.id = item.id;
  if (item.name) payload.name = item.name;
  if (item.scope) payload.scope = item.scope;
  if (typeof item.index === 'number') payload.index = item.index;
  if (item.tool) payload.tool = item.tool;
  if (item.path) payload.originalPath = item.path;
  if (item.sourcePath) payload.originalPath = item.sourcePath;
  if (item.descriptor?.manifestPath) {
    payload.originalPath = item.descriptor.manifestPath;
    payload.id = item.descriptor.id || payload.id;
  }
  manageCatalog = await postForm('/api/manage/delete', payload);
  if (currentState) renderManagePanel(currentState);
  closeManageEditor();
  showToast(t('session.deleted', '会话已删除'), 'success');
}

async function applyProviderProfile() {
  const item = manageEditorState?.item;
  if (!item) return;
  const sessionId = await sessionController.ensureWritableSession();
  const state = await postForm('/api/settings', {
    sessionId,
    providerId: item.providerId,
    providerBaseUrl: item.providerBaseUrl || '',
    defaultModel: item.defaultModel || '',
    permissionMode: settingPermission?.value || normalizePermissionValue(currentState?.config?.permissionMode),
    historyLimit: settingHistory?.value || currentState?.config?.historyLimit || 50,
  });
  applyState(state, sessionId);
  await refreshEventFeed(sessionId);
  closeManageEditor();
  showToast(t('settings.saved', '设置已保存'), 'success');
}

function renderHooksPanel() {
  if (!manageHooksList) return;
  manageHooksList.replaceChildren();
  const hooks = manageCatalog?.hooks?.items || [];
  const actions = document.createElement('div');
  actions.className = 'manage-list';
  renderManageCards(actions, [manageCreateCard(t('action.add', '新增 Hook'), '新增全局或按工具的 Hook 配置。', () => openManageEditor('hook'))], (entry) => ({
    title: entry.label,
    description: entry.description,
    badge: t('action.add', '新增'),
    badgeClass: 'accent',
    onAction: entry.action,
    cardClass: 'manage-card-add',
  }));
  manageHooksList.appendChild(actions);
  const groups = [];
  const globalHooks = hooks.filter((hook) => !hook.tool);
  if (globalHooks.length) {
    groups.push({
      title: t('manage.hooksGlobal', '全局 Hooks'),
      items: globalHooks,
    });
  }
  [...new Set(hooks.map((hook) => hook.tool).filter(Boolean))].forEach((toolName) => {
    groups.push({
      title: toolName,
      items: hooks.filter((hook) => hook.tool === toolName),
    });
  });
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'manage-empty';
    empty.textContent = t('manage.hooksEmpty', '当前没有检测到 Hook 配置。');
    manageHooksList.appendChild(empty);
    return;
  }
  groups.forEach((group) => {
    const section = document.createElement('section');
    section.className = 'manage-group';
    const title = document.createElement('h3');
    title.className = 'manage-group-title';
    title.textContent = group.title;
    section.appendChild(title);
    const list = document.createElement('div');
    list.className = 'manage-list';
    section.appendChild(list);
    renderManageCards(list, group.items, (hook) => ({
      title: hook.command,
      description: `${hook.timing || '-'} · ${hook.blocking ? t('manage.blocking', '阻断') : t('manage.nonBlocking', '非阻断')}`,
      details: [`timeout=${hook.timeoutMs || hook.timeout_ms || 0}ms`, hook.sourcePath || '-'],
      onAction: () => openManageEditor('hook', hook),
    }));
    manageHooksList.appendChild(section);
  });
}

function renderManagePanel(state) {
  syncManagePanelControls(currentManagePanel);
  const providers = [
    manageCreateCard(t('action.add', '新增 Provider'), '保存 providerId / baseUrl / model 组合供后续快速应用。', () => openManageEditor('providerProfile')),
    ...(manageCatalog?.providerProfiles || []),
  ];
  renderManageCards(manageProvidersList, providers, (provider) => {
    if (provider.__manageAction) {
      return {
        title: provider.label,
        description: provider.description,
        badge: t('action.add', '新增'),
        badgeClass: 'accent',
        onAction: provider.action,
        cardClass: 'manage-card-add',
      };
    }
    return {
      title: provider.displayName || provider.id || '-',
      description: provider.defaultModel || provider.providerBaseUrl || '-',
      badge: provider.providerId || '-',
      details: [provider.providerBaseUrl || '-', provider.defaultModel || '-'],
      free: isFreeProviderProfile(provider),
      onAction: () => openManageEditor('providerProfile', provider),
    };
  });

  const tools = [
    manageCreateCard(t('action.add', '新增 Tool'), '新增一个外部命令包装工具，运行时转发到 shell-command。', () => openManageEditor('externalTool')),
    ...(manageCatalog?.tools || state?.tools || []),
  ];
  renderManageCards(manageToolsList, tools, (tool) => {
    if (tool.__manageAction) {
      return {
        title: tool.label,
        description: tool.description,
        badge: t('action.add', '新增'),
        badgeClass: 'accent',
        onAction: tool.action,
        cardClass: 'manage-card-add',
      };
    }
    return {
      title: tool.name,
      description: tool.summary || '-',
      badge: tool.isCustom ? (tool.scope || 'custom') : (tool.minimumPermission || '-'),
      badgeClass: tool.isCustom ? 'accent' : '',
      details: tool.isCustom ? [tool.minimumPermission || '-', tool.commandTemplate || '-', tool.sourcePath || '-'] : [tool.minimumPermission || '-'],
      onAction: tool.isCustom ? () => openManageEditor('externalTool', tool) : undefined,
    };
  });

  const commands = [
    manageCreateCard(t('action.add', '新增 Command'), '新增一个斜杠命令模板，支持 {args} 或自动追加参数。', () => openManageEditor('externalCommand')),
    ...(manageCatalog?.commands || state?.commands || []),
  ];
  renderManageCards(manageCommandsList, commands, (command) => {
    if (command.__manageAction) {
      return {
        title: command.label,
        description: command.description,
        badge: t('action.add', '新增'),
        badgeClass: 'accent',
        onAction: command.action,
        cardClass: 'manage-card-add',
      };
    }
    return {
      title: `/${command.name}`,
      description: command.summary || '-',
      badge: command.isCustom ? (command.scope || 'custom') : t('manage.insert', '插入'),
      badgeClass: command.isCustom ? 'accent' : 'accent',
      details: command.isCustom ? [command.template || '-', command.sourcePath || '-'] : [],
      onAction: command.isCustom
        ? () => openManageEditor('externalCommand', command)
        : () => {
          chatInput.value = `/${command.name} `;
          chatInput.focus();
          charCount.textContent = String(chatInput.value.length);
        },
    };
  });

  if (manageCatalog) {
    renderManageCards(manageMcpList, [manageCreateCard(t('action.add', '新增 MCP'), '新增或维护 MCP manifest。', () => openManageEditor('mcp')), ...(manageCatalog.mcpServers || [])], (server) => {
      if (server.__manageAction) {
        return {
          title: server.label,
          description: server.description,
          badge: t('action.add', '新增'),
          badgeClass: 'accent',
          onAction: server.action,
          cardClass: 'manage-card-add',
        };
      }
      return {
        title: server.descriptor?.id || '-',
        description: server.detail || '-',
        badge: server.state || '-',
        badgeClass: server.state === 'running' || server.state === 'ready-for-prompt' ? 'success' : '',
        details: [
          `${t('manage.transport', '传输')}: ${server.descriptor?.transport || '-'}`,
          `${t('manage.manifest', '清单')}: ${server.descriptor?.manifestPath || '-'}`,
        ],
        onAction: () => openManageEditor('mcp', server),
      };
    });

    renderManageCards(manageSkillsList, [manageCreateCard(t('action.add', '新增 Skill'), '新增或修改本地 skill。', () => openManageEditor('skill')), ...(manageCatalog.skills || [])], (skill) => {
      if (skill.__manageAction) {
        return {
          title: skill.label,
          description: skill.description,
          badge: t('action.add', '新增'),
          badgeClass: 'accent',
          onAction: skill.action,
          cardClass: 'manage-card-add',
        };
      }
      return {
        title: skill.id,
        description: skill.summary || '-',
        badge: skill.scope || '-',
        details: [skill.path || '-'],
        onAction: () => openManageEditor('skill', skill),
      };
    });

    renderHooksPanel();
  } else if (['mcp', 'skills', 'hooks'].includes(currentManagePanel)) {
    const loadingText = t('manage.loading', '正在加载管理目录...');
    [manageMcpList, manageSkillsList, manageHooksList].forEach((host) => {
      if (!host) return;
      host.innerHTML = `<div class="manage-empty">${escapeHtml(loadingText)}</div>`;
    });
    void ensureManageCatalog();
  }
}

async function ensureManageCatalog(force = false) {
  if (manageCatalog && !force) return manageCatalog;
  if (manageCatalogPromise && !force) return manageCatalogPromise;
  manageCatalogPromise = fetchJson('/api/manage/catalog')
    .then((data) => {
      manageCatalog = data;
      manageCatalogPromise = null;
      if (currentState) {
        renderManagePanel(currentState);
        renderSettings(currentState);
      }
      return data;
    })
    .catch((error) => {
      manageCatalogPromise = null;
      showToast(`${t('error.loadManageFailed', '管理目录加载失败')}: ${error.message || String(error)}`, 'error');
      throw error;
    });
  return manageCatalogPromise;
}

function setManagePanel(panel) {
  currentManagePanel = panel || 'overview';
  syncManagePanelControls(currentManagePanel);
  if (currentState) renderManagePanel(currentState);
  if (currentManagePanel !== 'overview' && currentManagePanel !== 'settings') {
    void ensureManageCatalog();
  }
}

async function deleteSessionById(sessionId) {
  if (!sessionId) return;
  if (!window.confirm(t('session.confirmDelete', '确定删除这个会话吗？'))) return;
  try {
    const state = await postForm('/api/sessions/delete', { sessionId });
    const nextSessionId = state.activeSession?.summary?.id || state.activeSession?.sessionId || undefined;
    sessionController.handleDeletedSession(sessionId, nextSessionId);
    applyState(state, nextSessionId);
    await refreshEventFeed(nextSessionId);
    showToast(t('session.deleted', '会话已删除'), 'success');
  } catch (error) {
    showToast(`${t('error.sessionDeleteFailed', '删除会话失败')}: ${error.message}`, 'error');
  }
}

async function deleteAllSessions() {
  if (!window.confirm(t('session.confirmDeleteAll', '确定删除全部会话吗？此操作不可撤销。'))) return;
  try {
    const state = await postForm('/api/sessions/delete-all', {});
    const nextSessionId = state.activeSession?.summary?.id || state.activeSession?.sessionId || undefined;
    sessionController.claimOwnedSession(nextSessionId || '');
    applyState(state, nextSessionId);
    await refreshEventFeed(nextSessionId);
    showToast(t('session.deletedAll', '全部会话已删除'), 'success');
  } catch (error) {
    showToast(`${t('error.sessionDeleteFailed', '删除会话失败')}: ${error.message}`, 'error');
  }
}

function resolveSearchScopePath() {
  if (currentWorkObject?.path && currentWorkObject.path !== '-') return currentWorkObject.path;
  return currentWorkspaceRoot();
}

function renderSearchResults(payload) {
  latestSearchResult = payload;
  if (searchScopeLabel) searchScopeLabel.textContent = resolveSearchScopePath();
  if (searchResultCount) {
    const count = payload?.resultCount ?? payload?.replacementCount ?? 0;
    searchResultCount.textContent = String(count);
  }
  if (!searchResults) return;
  searchResults.replaceChildren();

  const items = payload?.results || payload?.items || [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = t('edit.find.none', '未找到匹配');
    searchResults.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result-item';
    const lineInfo = item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : '';
    const snippet = item.snippet || `${t('edit.replace.done', '替换已完成')} (${item.replacements || 0})`;
    button.innerHTML = `
      <div class="search-result-path">${escapeHtml(item.path || '-')}<span>${escapeHtml(lineInfo)}</span></div>
      <div class="search-result-snippet">${escapeHtml(snippet)}</div>
    `;
    button.addEventListener('click', () => {
      if (item.path) {
        setCurrentWorkObject({
          type: 'file',
          name: pathBaseName(item.path),
          path: item.path,
        });
      }
    });
    searchResults.appendChild(button);
  });
}

function closeSearchLayer() {
  if (!searchLayer) return;
  searchLayer.hidden = true;
}

function openSearchLayer(mode = 'find') {
  searchLayerMode = mode;
  if (!searchLayer) return;
  searchLayer.hidden = false;
  searchModeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.searchMode === mode);
  });
  if (searchReplaceWrap) searchReplaceWrap.hidden = mode !== 'replace';
  if (searchReplaceRunButton) searchReplaceRunButton.hidden = mode !== 'replace';
  if (searchRunButton) searchRunButton.hidden = mode !== 'find';
  if (searchScopeLabel) searchScopeLabel.textContent = resolveSearchScopePath();
  if (searchQueryInput) searchQueryInput.focus();
}

async function runSearchLayerAction(replace = false) {
  const query = searchQueryInput?.value.trim() || '';
  if (!query) {
    showToast(t('edit.prompt.find', '请输入查找文本'), 'error');
    return;
  }
  const scopePath = resolveSearchScopePath();
  try {
    if (replace) {
      const payload = await postForm('/api/fs/replace', {
        path: scopePath,
        oldText: query,
        newText: searchReplaceInput?.value || '',
      });
      renderSearchResults(payload);
      showToast(t('edit.replace.done', '替换已完成'), 'success');
      return;
    }
    const payload = await postForm('/api/fs/search', { path: scopePath, query });
    renderSearchResults(payload);
    showToast(t('edit.find.done', '查找已完成'), 'success');
  } catch (error) {
    showToast(`${t('error.editFailed', '编辑操作失败')}: ${error.message}`, 'error');
  }
}

function closeFileDialog() {
  if (!fileDialog) return;
  fileDialog.hidden = true;
  fileDialogState.open = false;
}

function validateForkBranchName(value) {
  const normalized = normalizeForkBranchName(value);
  if (!normalized) return t('session.forkNameRequired', '分支名称不能为空');
  if (normalized.length > 80) return t('session.forkNameTooLong', '分支名称不能超过 80 个字符');
  if (/\r|\n/.test(normalized)) return t('session.forkNameInvalid', '分支名称不能包含换行');
  return '';
}

function closeForkDialog() {
  if (!forkDialog) return;
  forkDialog.hidden = true;
  forkDialogState.open = false;
  forkDialogState.pending = false;
  forkDialogState.error = '';
}

function renderForkDialog() {
  if (!forkDialog) return;
  const labelText = forkDialogState.messageIndex === null
    ? t('session.forkAllHistory', '完整会话历史')
    : `${t('session.forkUntilMessage', '到消息')} #${forkDialogState.messageIndex + 1}`;
  const previewName = forkDialogState.normalizedBranchName || normalizeForkBranchName(forkDialogState.branchName);
  const errorText = forkDialogState.error || validateForkBranchName(forkDialogState.branchName);
  if (forkDialogTitle) forkDialogTitle.textContent = t('session.forkDialogTitle', 'Fork 新会话');
  if (forkDialogSubtitle) forkDialogSubtitle.textContent = t('session.forkDialogSubtitle', '从当前会话历史创建一个新的分支会话。');
  if (forkParentSessionInput) forkParentSessionInput.value = `${forkDialogState.parentSessionTitle || '-'} · ${forkDialogState.parentSessionId || '-'}`;
  if (forkMessageIndexInput) forkMessageIndexInput.value = labelText;
  if (forkBranchNameInput && forkBranchNameInput.value !== forkDialogState.branchName) {
    forkBranchNameInput.value = forkDialogState.branchName || '';
  }
  if (forkBranchPreviewInput) forkBranchPreviewInput.value = previewName;
  if (forkDialogError) {
    forkDialogError.hidden = !errorText;
    forkDialogError.textContent = errorText;
  }
  if (forkDialogConfirm) {
    forkDialogConfirm.disabled = Boolean(errorText) || forkDialogState.pending;
    forkDialogConfirm.textContent = forkDialogState.pending
      ? t('session.forking', '创建中...')
      : t('session.forkConfirm', '创建分支');
  }
}

async function confirmForkDialog() {
  const branchName = forkDialogState.normalizedBranchName || normalizeForkBranchName(forkDialogState.branchName);
  const validationMessage = validateForkBranchName(branchName);
  if (validationMessage) {
    forkDialogState.error = validationMessage;
    renderForkDialog();
    forkBranchNameInput?.focus();
    return;
  }
  forkDialogState.pending = true;
  forkDialogState.error = '';
  renderForkDialog();
  try {
    const previousSessionId = currentSessionId;
    const detachOwnedSession = sessionController.currentViewOwnsSession();
    const state = await postForm('/api/sessions/fork', {
      parentSessionId: forkDialogState.parentSessionId,
      branchName,
      messageIndex: forkDialogState.messageIndex,
    });
    const forkSessionId = extractSessionId(state);
    if (!forkSessionId) throw new Error('missing fork session id');
    if (previousSessionId) {
      await sessionController.closeSessionContext(previousSessionId, {
        detachOwnedSession,
        closeTerminals: true,
      });
    }
    sessionController.claimOwnedSession(forkSessionId);
    applyState(state, forkSessionId);
    await refreshEventFeed(forkSessionId);
    closeForkDialog();
    showToast(t('session.forked', '已创建分支会话'), 'success');
  } catch (error) {
    forkDialogState.pending = false;
    forkDialogState.error = `${t('error.sessionForkFailed', '创建分支会话失败')}: ${error.message}`;
    renderForkDialog();
  }
}

function renderFileDialogBreadcrumbs(currentPath) {
  if (!pathBreadcrumbs) return;
  pathBreadcrumbs.replaceChildren();
  const normalized = String(currentPath || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  let cursor = normalized.startsWith('/') ? '/' : '';

  if (/^[A-Za-z]:/.test(normalized)) {
    const drive = normalized.slice(0, 2);
    const driveButton = document.createElement('button');
    driveButton.type = 'button';
    driveButton.className = 'path-crumb';
    driveButton.textContent = drive;
    driveButton.addEventListener('click', () => {
      void loadFileDialogPath(`${drive}/`);
    });
    pathBreadcrumbs.appendChild(driveButton);
    cursor = `${drive}/`;
    parts.shift();
  }

  parts.forEach((part) => {
    cursor = cursor ? `${cursor.replace(/[\\/]$/, '')}/${part}` : part;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'path-crumb';
    button.textContent = part;
    button.addEventListener('click', () => {
      void loadFileDialogPath(cursor);
    });
    pathBreadcrumbs.appendChild(button);
  });
}

function renderFileDialog() {
  if (!fileDialog) return;
  const modeKey = `${fileDialogState.create ? 'create' : 'open'}${fileDialogState.kind === 'folder' ? 'Folder' : 'File'}`;
  const titles = {
    openFile: t('file.dialog.openFile', '打开文件对象'),
    openFolder: t('file.dialog.openFolder', '打开文件夹对象'),
    createFile: t('file.dialog.createFile', '新建文件对象'),
    createFolder: t('file.dialog.createFolder', '新建文件夹对象'),
  };
  if (fileDialogTitle) fileDialogTitle.textContent = titles[modeKey] || t('file.dialog.title', '打开工作对象');
  if (fileDialogSubtitle) fileDialogSubtitle.textContent = t('file.dialog.subtitle', '使用类似 Windows 资源管理器的方式浏览和选择路径。');
  if (pathCurrentInput) pathCurrentInput.value = fileDialogState.currentPath || '';
  if (pathSelectedInput) pathSelectedInput.value = fileDialogState.selectedPath || fileDialogState.currentPath || '';
  if (pathNameInput) {
    pathNameInput.disabled = !fileDialogState.create;
    if (!fileDialogState.create) pathNameInput.value = '';
  }

  if (pathQuickLinks) {
    pathQuickLinks.replaceChildren();
    [
      { label: t('file.dialog.workspaceRoot', '工作区根目录'), path: fileDialogState.workspaceRoot || currentWorkspaceRoot() },
      { label: t('file.dialog.currentFolder', '当前目录'), path: fileDialogState.currentPath },
      { label: t('file.dialog.parentFolder', '上一级目录'), path: pathDirName(fileDialogState.currentPath) },
    ].filter((item) => item.path).forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'path-quick-link';
      button.textContent = item.label;
      button.addEventListener('click', () => {
        void loadFileDialogPath(item.path);
      });
      pathQuickLinks.appendChild(button);
    });
  }

  renderFileDialogBreadcrumbs(fileDialogState.currentPath);

  if (pathEntryList) {
    pathEntryList.replaceChildren();
    if (!fileDialogState.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'manage-empty';
      empty.textContent = t('file.dialog.emptyFolder', '当前目录没有可显示的项目。');
      pathEntryList.appendChild(empty);
    }
    fileDialogState.entries.forEach((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `path-entry${fileDialogState.selectedPath === entry.path ? ' selected' : ''}`;
      button.innerHTML = `
        <span class="path-entry-kind">${entry.kind === 'directory' ? 'DIR' : 'FILE'}</span>
        <span class="path-entry-name">${escapeHtml(entry.name || '-')}</span>
        <span class="path-entry-meta">${escapeHtml(entry.kind === 'directory' ? t('file.dialog.folder', '文件夹') : t('file.dialog.file', '文件'))}</span>
      `;
      button.addEventListener('click', () => {
        fileDialogState.selectedPath = entry.path;
        fileDialogState.selectedKind = entry.kind;
        if (pathSelectedInput) pathSelectedInput.value = entry.path;
        renderFileDialog();
      });
      button.addEventListener('dblclick', () => {
        if (entry.kind === 'directory') {
          void loadFileDialogPath(entry.path);
        } else if (!fileDialogState.create && fileDialogState.kind === 'file') {
          fileDialogState.selectedPath = entry.path;
          fileDialogState.selectedKind = entry.kind;
          void confirmFileDialogSelection();
        }
      });
      pathEntryList.appendChild(button);
    });
  }
}

async function loadFileDialogPath(path) {
  try {
    const target = path || fileDialogState.currentPath || currentWorkspaceRoot();
    const payload = await fetchJson(`/api/fs/list?path=${encodeURIComponent(target)}`);
    fileDialogState.currentPath = payload.currentPath || target;
    fileDialogState.workspaceRoot = payload.workspaceRoot || currentWorkspaceRoot();
    fileDialogState.entries = payload.entries || [];
    fileDialogState.selectedPath = '';
    fileDialogState.selectedKind = '';
    renderFileDialog();
  } catch (error) {
    showToast(`${t('error.fileActionFailed', '文件操作失败')}: ${error.message}`, 'error');
  }
}

async function openFileDialog({ kind, create }) {
  fileDialogState = {
    open: true,
    create: Boolean(create),
    kind: kind || 'file',
    currentPath: currentWorkObject.type === 'folder'
      ? currentWorkObject.path
      : (currentWorkObject.path && currentWorkObject.path !== '-' ? pathDirName(currentWorkObject.path) : currentWorkspaceRoot()),
    selectedPath: '',
    selectedKind: '',
    workspaceRoot: currentWorkspaceRoot(),
    entries: [],
  };
  if (pathNameInput) pathNameInput.value = '';
  if (fileDialog) fileDialog.hidden = false;
  await loadFileDialogPath(fileDialogState.currentPath || currentWorkspaceRoot());
}

async function confirmFileDialogSelection() {
  let finalPath = pathSelectedInput?.value.trim() || '';
  let resolvedType = fileDialogState.kind;
  if (fileDialogState.create) {
    const name = pathNameInput?.value.trim() || '';
    if (!name) {
      showToast(t('file.dialog.nameRequired', '请输入名称后再继续。'), 'error');
      return;
    }
    finalPath = joinPath(fileDialogState.currentPath, name);
    const created = await postForm('/api/fs/create', {
      kind: fileDialogState.kind === 'folder' ? 'folder' : 'file',
      path: finalPath,
    });
    finalPath = created.path || finalPath;
    resolvedType = created.kind === 'folder' ? 'folder' : 'file';
  } else if (fileDialogState.kind === 'folder') {
    finalPath = finalPath || fileDialogState.currentPath;
  } else if (!finalPath) {
    showToast(t('file.dialog.selectFile', '请先选择一个文件。'), 'error');
    return;
  }

  setCurrentWorkObject({
    type: resolvedType,
    name: pathBaseName(finalPath),
    path: finalPath,
  });
  closeFileDialog();
  showToast(
    fileDialogState.create
      ? t(resolvedType === 'folder' ? 'folder.created' : 'file.created', resolvedType === 'folder' ? '文件夹对象已创建' : '文件对象已创建')
      : t(resolvedType === 'folder' ? 'folder.opened' : 'file.opened', resolvedType === 'folder' ? '文件夹对象已打开' : '文件对象已打开'),
    'success',
  );
}

function extractApprovalPayload(message) {
  let text = String(message || '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') {
      text = parsed.error;
    } else if (typeof parsed === 'string') {
      text = parsed;
    }
  } catch (_) {}
  const index = text.indexOf('__approve:');
  if (index < 0) return '';
  return text.slice(index).trim().replace(/["'}\]]+$/, '');
}

function extractToolOutput(name) {
  const prefix = `tool ${name} =>`;
  const events = currentState?.eventFeed || currentEventFeed || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const message = String(event?.message || '');
    if (event?.scope === 'transcript' && message.startsWith(prefix)) {
      return message.slice(prefix.length).trim();
    }
  }
  return '';
}

async function runToolRaw(name, input) {
  const sessionId = await sessionController.ensureWritableSession();
  const state = await postForm('/api/tool', {
    sessionId,
    name,
    input,
  });
  applyState(state, sessionId);
  await refreshEventFeed(sessionId);
  render(currentState || state);
  return { state: currentState || state, output: extractToolOutput(name) };
}

async function runTool(name, input, options = {}) {
  try {
    return await runToolRaw(name, input);
  } catch (error) {
    if (options.autoApprove) {
      const approvedInput = extractApprovalPayload(error.message);
      if (approvedInput) {
        // P13-C: surface a human-readable argument preview before the
        // approval-token replay fires. Operators can now see which tool
        // they are about to auto-approve and the payload it will run
        // with. The preview is truncated + type-safe to avoid leaking
        // binary blobs into the toast.
        try {
          const previewArgs = String(input ?? '');
          const trimmed = previewArgs.length > 200
            ? `${previewArgs.slice(0, 200)}…`
            : previewArgs;
          showToast(
            t('approval.preview', '已自动批准工具调用')
              + `: ${name}(${trimmed})`,
            'info',
          );
        } catch (_) { /* toast is best-effort */ }
        return runToolRaw(name, approvedInput);
      }
    }
    throw error;
  }
}

function shellDisplayName() {
  const shell = currentState?.workspace?.shell || '';
  const base = pathBaseName(shell);
  if (/powershell/i.test(base)) return 'PowerShell';
  if (/bash/i.test(base)) return 'Bash';
  return base || 'Shell';
}

function getActiveTerminal() {
  return terminalSessions.find((session) => session.id === activeTerminalId) || terminalSessions[0] || null;
}

function psQuote(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function terminalSocketUrl(terminalId) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/terminal/ws?id=${encodeURIComponent(terminalId)}&token=${encodeURIComponent(AUTH_TOKEN)}`;
}

function getTerminalViewportSize() {
  const width = terminalOutput?.clientWidth || 960;
  const height = terminalOutput?.clientHeight || 240;
  return {
    cols: Math.max(40, Math.floor(width / 9)),
    rows: Math.max(12, Math.floor(height / 18)),
  };
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function ensureTerminalViewportReady() {
  if (!terminalDrawer) return;
  terminalVisible = true;
  terminalDrawer.hidden = false;
  await nextAnimationFrame();
  await nextAnimationFrame();
}

function buildTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue('--bg-0').trim() || '#101418',
    foreground: styles.getPropertyValue('--ink').trim() || '#e6edf3',
    cursor: styles.getPropertyValue('--accent').trim() || '#58a6ff',
    cursorAccent: styles.getPropertyValue('--bg-0').trim() || '#101418',
    selectionBackground: styles.getPropertyValue('--accent-dim').trim() || 'rgba(88,166,255,0.25)',
  };
}

function applyTerminalTheme(session) {
  if (!session?.term) return;
  session.term.options.theme = buildTerminalTheme();
}

function ensureTerminalPane(session) {
  if (!terminalViewport || !session?.term) return null;
  if (!session.pane) {
    const pane = document.createElement('div');
    pane.className = 'terminal-pane';
    // Show the pane BEFORE calling term.open so xterm.js can measure the
    // container dimensions — opening into a display:none element produces
    // a 0x0 render that never recovers until a manual resize.
    pane.style.display = 'block';
    pane.tabIndex = 0;
    // Click anywhere in the pane routes keyboard focus into xterm's
    // hidden textarea so the user can type immediately without having
    // to click precisely on the blinking cursor.
    pane.addEventListener('mousedown', () => {
      try { session.term.focus(); } catch (_) {}
    });
    terminalViewport.appendChild(pane);
    session.pane = pane;
    session.term.open(pane);
    applyTerminalTheme(session);
    // Fit + focus on the next frame so the container has a measured size.
    requestAnimationFrame(() => {
      try {
        if (session.fit && terminalVisible) session.fit.fit();
        session.term.focus();
      } catch (_) {}
    });
  }
  return session.pane;
}

async function sendTerminalResize(session, cols, rows) {
  if (!session?.id) return;
  window.clearTimeout(session.resizeTimer);
  session.resizeTimer = window.setTimeout(async () => {
    try {
      await postForm('/api/terminal/resize', {
        id: session.id,
        cols,
        rows,
      });
      session.cols = cols;
      session.rows = rows;
    } catch (error) {
      showToast(`${t('error.terminalFailed', '终端命令执行失败')}: ${error.message}`, 'error');
    }
  }, 80);
}

function fitTerminalSession(session) {
  if (!session?.fit || !session?.term || !terminalVisible) return;
  ensureTerminalPane(session);
  session.fit.fit();
  if (session.term.cols && session.term.rows) {
    void sendTerminalResize(session, session.term.cols, session.term.rows);
  }
}

function attachTerminalSessionSocket(session) {
  const socket = new WebSocket(terminalSocketUrl(session.id));
  session.socket = socket;
  socket.addEventListener('open', () => {
    session.connected = true;
    renderTerminalTabs();
    requestAnimationFrame(() => fitTerminalSession(session));
  });
  socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (_) {
      payload = { type: 'output', data: String(event.data || '') };
    }
    const data = String(payload.data || '');
    if (payload.type === 'snapshot' || payload.type === 'output') {
      session.term.write(data);
      return;
    }
    if (payload.type === 'error') {
      session.term.write(data);
      showToast(`${t('error.terminalFailed', '终端命令执行失败')}: ${data}`, 'error');
      return;
    }
    if (payload.type === 'exit') {
      session.connected = false;
      session.term.write(data);
      renderTerminalTabs();
    }
  });
  socket.addEventListener('close', () => {
    session.connected = false;
    session.socket = null;
    renderTerminalTabs();
  });
  socket.addEventListener('error', () => {
    session.connected = false;
    renderTerminalTabs();
  });
}

async function createTerminalSession(label) {
  if (typeof window.Terminal !== 'function') {
    showToast(t('terminal.unavailable', '真实终端依赖未加载，无法创建终端会话。'), 'error');
    return null;
  }
  const writableSessionId = await sessionController.ensureWritableSession();
  await ensureTerminalViewportReady();
  const size = getTerminalViewportSize();
  const info = await postForm('/api/terminal/open', {
    sessionId: writableSessionId,
    label: label || '',
    cwd: currentState?.workspace?.root || '.',
    cols: size.cols,
    rows: size.rows,
  });
  const term = new window.Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'IBM Plex Mono, monospace',
    fontSize: 12,
    lineHeight: 1.3,
    scrollback: 5000,
    theme: buildTerminalTheme(),
  });
  const fit = window.FitAddon && window.FitAddon.FitAddon ? new window.FitAddon.FitAddon() : null;
  if (fit) term.loadAddon(fit);
  const session = {
    ...info,
    term,
    fit,
    pane: null,
    socket: null,
    connected: false,
    resizeTimer: 0,
  };
  term.onData((data) => {
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.send(data);
    }
  });
  term.onResize(({ cols, rows }) => {
    void sendTerminalResize(session, cols, rows);
  });
  terminalSessions.push(session);
  activeTerminalId = session.id;
  terminalVisible = true;
  renderTerminalUi();
  attachTerminalSessionSocket(session);
  return session;
}

async function openTerminalDrawer(forceCreate = true) {
  if (forceCreate && !terminalSessions.length) {
    await createTerminalSession();
  }
  terminalVisible = terminalSessions.length > 0;
  renderTerminalUi();
  if (terminalVisible) {
    const session = getActiveTerminal();
    if (session?.term) {
      window.setTimeout(() => session.term.focus(), 0);
    }
  }
}

async function toggleTerminalDrawer() {
  if (!terminalSessions.length) {
    await createTerminalSession();
    return;
  }
  terminalVisible = !terminalVisible;
  renderTerminalUi();
  if (terminalVisible) {
    const session = getActiveTerminal();
    if (session?.term) {
      window.setTimeout(() => session.term.focus(), 0);
    }
  }
}

async function closeAllTerminalSessions(options = {}) {
  const { fetchKeepalive = false, skipRender = false } = options;
  const closingIds = terminalSessions.map((session) => session.id);
  terminalSessions.forEach((session) => {
    window.clearTimeout(session.resizeTimer);
    session.socket?.close();
    session.term?.dispose();
    session.pane?.remove();
  });
  terminalSessions = [];
  activeTerminalId = null;
  terminalVisible = false;
  await Promise.allSettled(closingIds.map((id) => postForm('/api/terminal/close', { id }, { keepalive: fetchKeepalive })));
  if (!skipRender) renderTerminalUi();
}

function selectTerminalSession(id) {
  activeTerminalId = id;
  terminalVisible = true;
  renderTerminalUi();
  const session = getActiveTerminal();
  if (session?.term) window.setTimeout(() => session.term.focus(), 0);
}

async function closeTerminalSession(id) {
  const index = terminalSessions.findIndex((session) => session.id === id);
  if (index < 0) return;
  const session = terminalSessions[index];
  window.clearTimeout(session.resizeTimer);
  session.socket?.close();
  session.term?.dispose();
  session.pane?.remove();
  const wasActive = terminalSessions[index].id === activeTerminalId;
  terminalSessions.splice(index, 1);
  if (!terminalSessions.length) {
    activeTerminalId = null;
    terminalVisible = false;
  } else if (wasActive) {
    activeTerminalId = terminalSessions[Math.max(0, index - 1)]?.id || terminalSessions[0].id;
  }
  try {
    await postForm('/api/terminal/close', { id });
  } catch (_) {}
  renderTerminalUi();
}

async function closeActiveTerminalSession() {
  const session = getActiveTerminal();
  if (!session) return;
  await closeTerminalSession(session.id);
}

async function handleTerminalMenuAction(action) {
  if (action === 'new') {
    await createTerminalSession();
    return;
  }
  if (action === 'toggle') {
    await toggleTerminalDrawer();
    return;
  }
  if (action === 'close-current') {
    await closeActiveTerminalSession();
    return;
  }
  if (action === 'close-all') {
    await closeAllTerminalSessions();
  }
}

async function showTerminalResult(title, output) {
  const session = getActiveTerminal() || await createTerminalSession();
  if (!session?.term) return;
  terminalVisible = true;
  renderTerminalUi();
  session.term.writeln('');
  if (title) session.term.writeln(`[octocode] ${title}`);
  String(output || t('terminal.noOutput', '(no output)'))
    .split(/\r?\n/)
    .forEach((line) => session.term.writeln(line));
}

function renderTerminalTabs() {
  if (!terminalTabsHost) return;
  terminalTabsHost.replaceChildren();
  terminalSessions.forEach((session) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `terminal-session-tab${session.id === activeTerminalId ? ' active' : ''}`;
    const ownerLabel = session.ownerSessionId ? ` · ${session.ownerSessionId}` : '';
    const statusLabel = session.connected ? `${session.label}${ownerLabel}` : `${session.label}${ownerLabel} · offline`;
    tab.innerHTML = `<span class="terminal-session-label">${escapeHtml(statusLabel)}</span><button type="button" class="terminal-session-close" aria-label="${escapeHtml(t('terminal.tabClose', 'Close terminal'))}">×</button>`;
    tab.title = `${session.cwd || '-'}\n${t('terminal.owner', 'Owner session')}: ${session.ownerSessionId || '-'}`;
    tab.addEventListener('click', () => selectTerminalSession(session.id));
    const closeButton = tab.querySelector('.terminal-session-close');
    if (closeButton) {
      closeButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        await closeTerminalSession(session.id);
      });
    }
    terminalTabsHost.appendChild(tab);
  });
}

function renderTerminalUi() {
  if (!terminalDrawer || !terminalOutput) return;
  const shouldShow = terminalVisible && terminalSessions.length > 0;
  terminalDrawer.hidden = !shouldShow;
  if (!shouldShow) return;
  renderTerminalTabs();
  const session = getActiveTerminal();
  if (!session) return;
  if (terminalCwd) terminalCwd.textContent = `${session.shell || 'Shell'} · ${session.cwd || '-'} · ${t('terminal.owner', 'Owner session')}: ${session.ownerSessionId || '-'}`;
  terminalSessions.forEach((item) => {
    ensureTerminalPane(item);
    if (item.pane) {
      item.pane.classList.toggle('active', item.id === session.id);
    }
  });
  requestAnimationFrame(() => {
    fitTerminalSession(session);
    // Defer a second fit after layout settles — the first fit right after
    // the drawer un-hides can report stale container sizes on some browsers.
    window.setTimeout(() => fitTerminalSession(session), 120);
    try { session.term?.focus(); } catch (_) {}
  });
}

// Re-fit whichever terminal is currently active when its container resizes
// (window resize, drawer show/hide, CSS reflow). Without this the PTY retains
// the size captured at the first paint and the output wraps incorrectly.
if (typeof ResizeObserver === 'function' && terminalOutput) {
  const ro = new ResizeObserver(() => {
    if (!terminalVisible) return;
    const s = getActiveTerminal();
    if (s) fitTerminalSession(s);
  });
  ro.observe(terminalOutput);
}

// Clicking anywhere in the drawer (toolbar, empty areas) focuses the active
// xterm so the user can start typing without precisely clicking the cursor.
if (terminalDrawer) {
  terminalDrawer.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    const s = getActiveTerminal();
    if (s?.term) {
      try { s.term.focus(); } catch (_) {}
    }
  });
}

function buildFolderReplaceCommand(folderPath, oldText, newText) {
  const root = psQuote(folderPath);
  const oldValue = psQuote(oldText);
  const newValue = psQuote(newText);
  return `$changed = New-Object System.Collections.Generic.List[string]; Get-ChildItem -LiteralPath '${root}' -Recurse -File -ErrorAction Stop | ForEach-Object { $content = [System.IO.File]::ReadAllText($_.FullName); if ($content.Contains('${oldValue}')) { $updated = $content.Replace('${oldValue}', '${newValue}'); if ($updated -ne $content) { [System.IO.File]::WriteAllText($_.FullName, $updated); $changed.Add($_.FullName) } } }; if ($changed.Count -eq 0) { Write-Output 'no matches' } else { $changed | ForEach-Object { Write-Output $_ }; Write-Output ('replaced-in=' + $changed.Count) }`;
}

async function bindWorkObjectFromPath(type, path, shouldCreate = false) {
  const trimmedPath = String(path || '').trim();
  if (!trimmedPath) return;
  let resolvedType = type;
  let resolvedPath = trimmedPath;
  if (shouldCreate) {
    const created = await postForm('/api/fs/create', {
      kind: type === 'folder' ? 'folder' : 'file',
      path: trimmedPath,
    });
    resolvedType = created.kind === 'folder' ? 'folder' : 'file';
    resolvedPath = created.path || trimmedPath;
  }
  setCurrentWorkObject({
    type: resolvedType,
    name: pathBaseName(resolvedPath),
    path: resolvedPath,
  });
  showToast(
    t(resolvedType === 'folder'
      ? (shouldCreate ? 'folder.created' : 'folder.opened')
      : (shouldCreate ? 'file.created' : 'file.opened'),
    shouldCreate
      ? (resolvedType === 'folder' ? '文件夹对象已创建' : '文件对象已创建')
      : (resolvedType === 'folder' ? '文件夹对象已打开' : '文件对象已打开')),
    'success',
  );
}

const SLASH_COMMANDS = [
  'plan', 'workflow', 'agent', 'repl', 'search', 'pipe',
  'snapshot', 'sessions', 'status', 'events', 'health', 'circuit-log', 'doctor', 'tokens',
  'history', 'read', 'list', 'write', 'append', 'tree', 'tool',
  'git', 'context', 'fetch', 'session-add', 'session',
  'provider', 'model', 'permission', 'approve', 'reload', 'refresh',
];

function availableSlashCommands() {
  const commands = [];
  const seen = new Set();
  const append = (name, summary = '') => {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    commands.push({ name: normalized, summary: summary || '' });
  };

  SLASH_COMMANDS.forEach((name) => append(name));
  (currentState?.commands || []).forEach((command) => append(command?.name, command?.summary));
  (manageCatalog?.commands || []).forEach((command) => append(command?.name, command?.summary));
  return commands;
}

function isSlashCommand(text) {
  if (!text.startsWith('/')) return false;
  const verb = text.slice(1).split(/\s+/)[0].toLowerCase();
  return availableSlashCommands().some((command) => command.name === verb);
}

function slashCommandVerb(text) {
  return text.startsWith('/') ? text.slice(1).split(/\s+/)[0].toLowerCase() : '';
}

function updateComposerHints() {
  const text = chatInput.value;
  charCount.textContent = String(text.length);
  if (!text.startsWith('/') || text.includes('\n')) {
    composerHints.classList.remove('visible');
    return;
  }
  const partial = text.slice(1).split(/\s+/)[0].toLowerCase();
  const commands = availableSlashCommands();
  const matches = commands.filter((command) => command.name.startsWith(partial)).slice(0, 8);
  if (!matches.length) {
    composerHints.classList.remove('visible');
    return;
  }
  composerHints.replaceChildren();
  matches.forEach((command) => {
    const hint = document.createElement('div');
    hint.className = 'hint-item';
    hint.innerHTML = `<span class="hint-item-name">/${escapeHtml(command.name)}</span><span class="hint-item-desc">${escapeHtml(command.summary || '')}</span>`;
    hint.addEventListener('click', () => {
      chatInput.value = `/${command.name} `;
      chatInput.focus();
      composerHints.classList.remove('visible');
      charCount.textContent = String(chatInput.value.length);
    });
    composerHints.appendChild(hint);
  });
  composerHints.classList.add('visible');
}

async function streamChat(text, sessionId) {
  // P8-C: Don't force the indicator on here. `renderStatusBar` will decide
  // based on backend phase + streaming state so the indicator is only
  // visible during thinking / tool-call / background gaps.
  streamAbortController = new AbortController();
  // BugFix-2 (live P13): reuse the preflight runtime the submit handler may
  // already have created before awaiting ensureWritableSession. Creating a
  // second runtime here would flip `stopped=true` on the preflight one and
  // flash the indicator into the generic fallback label.
  const existing = conversationRuntime;
  const runtime = (existing && !existing.stopped && existing.promptText === text)
    ? existing
    : beginConversationRuntime(text);
  runtime.sessionId = sessionId;
  runtime.watcherPromise = runtime.watcherPromise || monitorConversationSettlement(runtime);
  let sawToken = false;
  let streamEstablished = false;
  const isViewing = () => currentSessionId === sessionId;
  currentMessages.push({ role: 'user', content: text, timestamp: Date.now() });
  renderMessages(currentMessages);
  const assistantMessage = { role: 'assistant', content: '', timestamp: Date.now() };
  currentMessages.push(assistantMessage);
  renderMessages(currentMessages);
  try {
    const params = new URLSearchParams({
      session: sessionId,
      text,
    });
    const response = await fetchWithAuth(`/api/stream?${params.toString()}`, {
      signal: streamAbortController.signal,
    });
    if (!response.ok || !response.body) {
      currentMessages.pop();
      currentMessages.pop();
      showToast(`${t('error.chatFailed', '操作失败')}: ${t('stream.unavailable', '流式响应不可用')}`, 'error');
      return 'failed';
    }
    streamEstablished = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      let streamDone = false;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      let updated = false;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          streamDone = true;
          break;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            throw new Error(parsed.error);
          }
          if (parsed.token) {
            sawToken = true;
            runtime.tokenCount += 1;
            runtime.lastTokenAt = Date.now();
            // BugFix-2 (live P13): flip the indicator label the moment the
            // first real token arrives, independent of renderStatusBar's
            // next tick.
            if (streamIndicatorLabel && runtime.tokenCount === 1) {
              streamIndicatorLabel.textContent = t('stream.outputting', '输出中...');
            }
            assistantMessage.content += parsed.token;
            updated = true;
          }
        } catch (_) {
          assistantMessage.content += data;
          sawToken = true;
          runtime.tokenCount += 1;
          runtime.lastTokenAt = Date.now();
          if (streamIndicatorLabel && runtime.tokenCount === 1) {
            streamIndicatorLabel.textContent = t('stream.outputting', '输出中...');
          }
          updated = true;
        }
      }
      if (updated) {
        if (isViewing()) {
          // Incremental update: only patch the last assistant bubble's content
          // element rather than rebuilding the whole message list. This avoids
          // the flicker/full-screen-refresh effect during streaming.
          const bubbles = messageList.querySelectorAll('.msg-bubble');
          const lastBubble = bubbles[bubbles.length - 1];
          const contentEl = lastBubble ? lastBubble.querySelector('.msg-content') : null;
          if (contentEl && lastBubble.classList.contains('role-assistant')) {
            contentEl.innerHTML = renderMarkdown(assistantMessage.content);
            const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
            if (nearBottom) messageList.scrollTop = messageList.scrollHeight;
          } else {
            // Fallback: first frame after adding the assistant placeholder —
            // full render once, then subsequent frames go through the fast path.
            renderMessages(currentMessages);
            messageList.scrollTop = messageList.scrollHeight;
          }
        }
      }
      if (streamDone) {
        break;
      }
    }
    if (runtime.settledState) {
      const settledPhase = normalizeTurnPhase(runtime.settledState?.activeSession?.turn?.phase);
      if (currentSessionId === sessionId) {
        applyState(runtime.settledState, sessionId);
      }
      if (settledPhase === 'cancelled') return 'stopped';
      if (settledPhase === 'failed' || settledPhase === 'interrupted') return 'failed';
      return 'completed';
    }
    renderMessages(currentMessages);
    return 'completed';
  } catch (error) {
    if (error.name === 'AbortError' && runtime.settledViaSnapshot && runtime.settledState) {
      const settledPhase = normalizeTurnPhase(runtime.settledState?.activeSession?.turn?.phase);
      if (currentSessionId === sessionId) {
        applyState(runtime.settledState, sessionId);
      }
      if (settledPhase === 'cancelled') return 'stopped';
      if (settledPhase === 'failed' || settledPhase === 'interrupted') return 'failed';
      return 'completed';
    }
    if (error.name === 'AbortError') {
      assistantMessage.content = assistantMessage.content.trimEnd();
      assistantMessage.content += `${assistantMessage.content ? '\n' : ''}${t('stream.stopped', '[stopped by user]')}`;
      renderMessages(currentMessages);
      return 'stopped';
    } else if (sawToken) {
      assistantMessage.content += `\n${t('stream.failed', '[stream failed]')} ${error.message || String(error)}`;
      renderMessages(currentMessages);
      showToast(`${t('error.chatFailed', '操作失败')}: ${error.message || String(error)}`, 'error');
      return 'failed';
    } else if (streamEstablished) {
      currentMessages.pop();
      currentMessages.pop();
      showToast(`${t('error.chatFailed', '操作失败')}: ${error.message || String(error)}`, 'error');
      return 'failed';
    }
  } finally {
    clearConversationRuntime(runtime);
    streamIndicator.hidden = true;
    streamAbortController = null;
    if (runtime.watcherPromise) {
      try {
        await runtime.watcherPromise;
      } catch (_) {}
    }
  }
}

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
    let activeMutationSessionId = currentSessionId;
    if (isSlashCommand(text)) {
      const command = text.slice(1).trim();
      const verb = slashCommandVerb(text);
      if (verb === 'events') {
        await refreshEventFeed(currentSessionId);
        showTerminalResult(t('terminal.title', '终端'), currentEventFeed.map((item) => item.message || JSON.stringify(item)).join('\n') || t('terminal.noOutput', '(no output)'));
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
      const writableSessionId = await sessionController.ensureWritableSession();
      activeMutationSessionId = writableSessionId;
      const commandText = command.includes(' | ') ? `pipe ${command}` : command;
      state = await postForm('/api/command', { sessionId: writableSessionId, command: commandText });
    } else {
      if (streamIndicator) {
        streamIndicator.hidden = false;
        // BugFix-2 (live P13): set the label directly here. renderStatusBar
        // only runs when a new state snapshot arrives; between submit and
        // the first applyState, the label would otherwise retain its
        // previous (often stale "AI 正在响应...") text.
        if (streamIndicatorLabel) {
          streamIndicatorLabel.textContent = t('stream.thinking', 'AI 思考中...');
        }
      }
      // BugFix-2 (live P13): establish the conversation runtime BEFORE any
      // async session work so renderStatusBar sees `tokenCount === 0` and
      // labels the indicator as "AI 思考中..." instead of falling through
      // to the generic "AI 正在响应..." while ensureWritableSession awaits.
      const preflightRuntime = beginConversationRuntime(text);
      const writableSessionId = await sessionController.ensureWritableSession();
      preflightRuntime.sessionId = writableSessionId;
      activeMutationSessionId = writableSessionId;
      chatInput.value = '';
      charCount.textContent = '0';
      const streamState = await streamChat(text, writableSessionId);
      if (streamState === 'completed') {
        await loadState(writableSessionId);
        setConnectionState('connected');
        return;
      }
      if (streamState === 'stopped') {
        setConnectionState('connected');
        await refreshEventFeed(writableSessionId);
        return;
      }
      if (streamState === 'failed') {
        return;
      }
      return;
    }
    chatInput.value = '';
    charCount.textContent = '0';
    setConnectionState('connected');
    applyState(state, activeMutationSessionId);
    await refreshEventFeed(activeMutationSessionId);
  } catch (error) {
    setConnectionState('disconnected');
    showToast(`${t('error.chatFailed', '操作失败')}: ${error.message}`, 'error');
  } finally {
    isSubmitting = false;
    if (streamIndicator) streamIndicator.hidden = true;
    setButtonLoading(submitBtn, false);
  }
});

submitBtn.addEventListener('click', async (event) => {
  if (isSubmitting && streamAbortController) {
    event.preventDefault();
    const stopRequest = requestStreamStop();
    streamAbortController.abort();
    await stopRequest;
  }
});

chatInput.addEventListener('input', updateComposerHints);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const sessionId = await sessionController.ensureWritableSession();
    const providerSelection = resolveSettingsSubmissionFields();
    const state = await postForm('/api/settings', {
      sessionId,
      providerId: providerSelection.providerId,
      providerBaseUrl: providerSelection.providerBaseUrl,
      defaultModel: providerSelection.defaultModel,
      permissionMode: settingPermission.value,
      historyLimit: settingHistory.value,
    });
    lastSettingsSaveAt = new Date();
    applyState(state, sessionId);
    await refreshEventFeed(sessionId);
    showToast(t('settings.saved', '设置已保存'), 'success');
  } catch (error) {
    showToast(`${t('error.settingsFailed', '保存设置失败')}: ${error.message}`, 'error');
  }
});

if (settingProvider) {
  settingProvider.addEventListener('change', () => {
    syncProviderProfileSelection();
  });
}

if (toolForm) {
  toolForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!toolName?.value) return;
    try {
      const startedAt = Date.now();
      const result = await runTool(toolName.value, toolInput?.value || '');
      const durationMs = Date.now() - startedAt;
      lastToolRun = {
        name: toolName.value,
        input: toolInput?.value || '',
        output: result.output || t('terminal.noOutput', '(no output)'),
        durationMs,
      };
      await showTerminalResult(`${toolName.value} (${durationMs}ms)`, lastToolRun.output);
      showToast(t('tool.completed', '工具执行完成'), 'success');
    } catch (error) {
      showToast(`${t('error.toolFailed', '工具执行失败')}: ${error.message}`, 'error');
    }
  });
}

[...sidebarTabs, ...activityButtons].forEach((control) => {
  control.addEventListener('click', () => {
    currentView = control.dataset.view || 'sessions';
    if (currentState) renderSidebar(currentState, currentSessionId);
    else syncViewControls(currentView);
  });
});

viewModeBtns.forEach((button) => {
  button.addEventListener('click', () => {
    activeViewMode = button.dataset.mode || 'normal';
    viewModeBtns.forEach((item) => item.classList.toggle('active', item === button));
    renderMessages(currentMessages);
  });
});

function initResize(handle, side) {
  if (!handle) return;
  let startX = 0;
  let startWidth = 0;
  const panelId = side === 'left' ? 'panel-left' : 'panel-right';
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const panel = document.getElementById(panelId);
    if (!panel) return;
    startX = event.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (moveEvent) => {
      const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      const nextWidth = Math.max(150, Math.min(500, startWidth + delta));
      workspaceGrid.style.setProperty(side === 'left' ? '--left-width' : '--right-width', `${nextWidth}px`);
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

if (fileMenuButton) fileMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDropdown(fileMenuButton, fileMenuPanel);
});
if (editMenuButton) editMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDropdown(editMenuButton, editMenuPanel);
});
if (viewMenuButton) viewMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDropdown(viewMenuButton, viewLanguageMenu);
});
if (manageMenuButton) manageMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDropdown(manageMenuButton, manageMenuPanel);
});
if (toolsMenuButton) toolsMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDropdown(toolsMenuButton, toolsMenuPanel);
});
if (terminalMenuButton) terminalMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDropdown(terminalMenuButton, terminalMenuPanel);
});
if (helpMenuButton) helpMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleDropdown(helpMenuButton, helpMenuPanel);
});
if (terminalNewTabBtn) terminalNewTabBtn.addEventListener('click', () => { void createTerminalSession(); });
if (terminalHideBtn) terminalHideBtn.addEventListener('click', () => { void closeAllTerminalSessions(); });
terminalMenuActions.forEach((button) => {
  button.addEventListener('click', async () => {
    closeDropdown(terminalMenuButton, terminalMenuPanel);
    await handleTerminalMenuAction(button.dataset.terminalAction || 'toggle');
  });
});

window.addEventListener('pagehide', () => {
  resetStreamingUiState({ abortActive: true });
  if (!terminalSessions.length) return;
  void closeAllTerminalSessions({ skipRender: true, fetchKeepalive: true });
});

window.addEventListener('pageshow', () => {
  resetStreamingUiState({ abortActive: true });
});

document.addEventListener('click', (event) => {
  dropdownPairs.forEach(({ button, panel }) => {
    if (!button || !panel || panel.hidden) return;
    if (button.contains(event.target) || panel.contains(event.target)) return;
    closeDropdown(button, panel);
  });
  if (contextMenu && !contextMenu.hidden && !contextMenu.contains(event.target)) {
    closeContextMenu();
  }
});

localeButtons.forEach((button) => {
  button.addEventListener('click', () => setActiveLocale(button.dataset.locale));
});

document.querySelectorAll('[data-color-scheme]').forEach((button) => {
  button.addEventListener('click', () => {
    applyTheme(button.dataset.colorScheme || 'light');
    closeDropdown(viewMenuButton, viewLanguageMenu);
  });
});

managePanelButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setManagePanel(button.dataset.managePanel || 'overview');
    closeAllDropdowns();
  });
});

document.querySelectorAll('[data-help-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.helpAction;
    const helpPlaceholders = {
      license: t('help.placeholder.license', '许可信息入口已预留，稍后可接入许可证文档。'),
      'release-notes': t('help.placeholder.releaseNotes', '发行说明入口已预留，稍后可接入版本说明。'),
      privacy: t('help.placeholder.privacy', '隐私声明入口已预留，稍后可接入隐私文档。'),
      contact: t('help.placeholder.contact', '联系我们入口已预留，稍后可接入联系信息。'),
      about: t('help.placeholder.about', '关于入口已预留，稍后可接入产品说明。'),
    };
    if (action === 'check-updates') {
      await loadState(currentSessionId);
      showToast(t('help.placeholder.checkUpdates', '已完成更新检查，当前为本地开发构建。'), 'info');
    } else {
      showToast(helpPlaceholders[action] || t('help.placeholder.default', '帮助入口已预留。'), 'info');
    }
    closeDropdown(helpMenuButton, helpMenuPanel);
  });
});

if (fileNewFileBtn) {
  fileNewFileBtn.addEventListener('click', async () => {
    await openFileDialog({ kind: 'file', create: true });
    closeDropdown(fileMenuButton, fileMenuPanel);
  });
}

if (fileOpenFileBtn) {
  fileOpenFileBtn.addEventListener('click', async () => {
    await openFileDialog({ kind: 'file', create: false });
    closeDropdown(fileMenuButton, fileMenuPanel);
  });
}

if (fileNewFolderBtn) {
  fileNewFolderBtn.addEventListener('click', async () => {
    await openFileDialog({ kind: 'folder', create: true });
    closeDropdown(fileMenuButton, fileMenuPanel);
  });
}

if (fileOpenFolderBtn) {
  fileOpenFolderBtn.addEventListener('click', async () => {
    await openFileDialog({ kind: 'folder', create: false });
    closeDropdown(fileMenuButton, fileMenuPanel);
  });
}

if (editFindBtn) {
  editFindBtn.addEventListener('click', () => {
    openSearchLayer('find');
    closeDropdown(editMenuButton, editMenuPanel);
  });
}

if (editReplaceBtn) {
  editReplaceBtn.addEventListener('click', () => {
    openSearchLayer('replace');
    closeDropdown(editMenuButton, editMenuPanel);
  });
}

if (refreshButton) {
  refreshButton.addEventListener('click', () => {
    if (!currentSessionId) return;
    void loadState(currentSessionId);
  });
}

if (closeShortcuts) {
  closeShortcuts.addEventListener('click', () => {
    shortcutsOverlay.hidden = true;
  });
}

if (sidebarActionsButton) {
  sidebarActionsButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openContextMenu(sidebarActionsButton, [
      {
        label: t('session.deleteAll', '删除全部会话'),
        action: async () => deleteAllSessions(),
      },
    ]);
  });
}

if (searchLayerClose) {
  searchLayerClose.addEventListener('click', closeSearchLayer);
}

searchModeButtons.forEach((button) => {
  button.addEventListener('click', () => openSearchLayer(button.dataset.searchMode || 'find'));
});

if (searchRunButton) {
  searchRunButton.addEventListener('click', () => {
    void runSearchLayerAction(false);
  });
}

if (searchReplaceRunButton) {
  searchReplaceRunButton.addEventListener('click', () => {
    void runSearchLayerAction(true);
  });
}

if (fileDialogClose) fileDialogClose.addEventListener('click', closeFileDialog);
if (fileDialogCancel) fileDialogCancel.addEventListener('click', closeFileDialog);
if (forkDialogClose) forkDialogClose.addEventListener('click', closeForkDialog);
if (forkDialogCancel) forkDialogCancel.addEventListener('click', closeForkDialog);
if (fileDialogConfirm) {
  fileDialogConfirm.addEventListener('click', () => {
    void confirmFileDialogSelection();
  });
}
if (forkDialogForm) {
  forkDialogForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void confirmForkDialog();
  });
}
if (forkBranchNameInput) {
  forkBranchNameInput.addEventListener('input', () => {
    setForkBranchName(forkBranchNameInput.value);
    forkDialogState.error = '';
    renderForkDialog();
  });
}
if (pathUpButton) {
  pathUpButton.addEventListener('click', () => {
    void loadFileDialogPath(pathDirName(fileDialogState.currentPath));
  });
}
if (pathRefreshButton) {
  pathRefreshButton.addEventListener('click', () => {
    void loadFileDialogPath(fileDialogState.currentPath);
  });
}
if (pathCurrentInput) {
  pathCurrentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void loadFileDialogPath(pathCurrentInput.value.trim());
    }
  });
}
if (fileDialog) {
  fileDialog.addEventListener('click', (event) => {
    if (event.target === fileDialog) closeFileDialog();
  });
}
if (forkDialog) {
  forkDialog.addEventListener('click', (event) => {
    if (event.target === forkDialog) closeForkDialog();
  });
}
if (manageEditorClose) manageEditorClose.addEventListener('click', closeManageEditor);
if (manageEditorCancel) manageEditorCancel.addEventListener('click', closeManageEditor);
if (manageEditorDelete) {
  manageEditorDelete.addEventListener('click', () => {
    void deleteManageEditor();
  });
}
if (manageEditorApply) {
  manageEditorApply.addEventListener('click', () => {
    void applyProviderProfile();
  });
}
if (manageEditorForm) {
  manageEditorForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveManageEditor();
  });
}
if (manageEditorDialog) {
  manageEditorDialog.addEventListener('click', (event) => {
    if (event.target === manageEditorDialog) closeManageEditor();
  });
}

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter' && document.activeElement === chatInput) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    currentMessages = [];
    renderMessages(currentMessages);
  }
  if (event.ctrlKey && event.code === 'Backquote') {
    event.preventDefault();
    void toggleTerminalDrawer();
  }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
    event.preventDefault();
    void createTerminalSession();
  }
  if (event.ctrlKey && event.key === '/') {
    event.preventDefault();
    shortcutsOverlay.hidden = !shortcutsOverlay.hidden;
  }
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openSearchLayer('find');
  }
  if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'h') {
    event.preventDefault();
    openSearchLayer('replace');
  }
  if (event.key === 'Escape') {
    closeAllDropdowns();
    closeContextMenu();
    closeSearchLayer();
    closeFileDialog();
    closeForkDialog();
    closeManageEditor();
    if (shortcutsOverlay) shortcutsOverlay.hidden = true;
  }
});

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });
}

window.addEventListener('resize', () => {
  terminalSessions.forEach((session) => fitTerminalSession(session));
});

window.addEventListener('focus', () => {
  if (!isSubmitting && currentSessionId) void sessionController.syncSessionSnapshot();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isSubmitting && currentSessionId) void sessionController.syncSessionSnapshot();
});

applyTheme((() => {
  try {
    const savedTheme = localStorage.getItem('octocode-theme');
    if (savedTheme) return savedTheme;
  } catch (_) {}
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
})());

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    try {
      if (localStorage.getItem('octocode-theme')) return;
    } catch (_) {}
    applyTheme(event.matches ? 'dark' : 'light');
  });
}

async function init() {
  setInterval(updateClock, 60000);
  updateClock();
  scheduleSnapshotRefresh();
  resetStreamingUiState();
  await loadLocalePlugin();
  await sessionController.initializeSessionContext();
  void ensureManageCatalog();
  setManagePanel(currentManagePanel);
  initGithubConnectionPanel();
}

init();

// =====================================================================
// P8-B: GitHub connection management.
// Stored ONLY in localStorage under `octocode-github-connection`. The
// backend never sees these credentials unless the user clicks "测试连通"
// which performs a direct request from the browser to api.github.com.
// =====================================================================
const GITHUB_CONN_STORAGE_KEY = 'octocode-github-connection';

function loadGithubConnection() {
  try {
    const raw = localStorage.getItem(GITHUB_CONN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function saveGithubConnection(data) {
  try {
    localStorage.setItem(GITHUB_CONN_STORAGE_KEY, JSON.stringify(data || {}));
    return true;
  } catch (_) {
    return false;
  }
}

function initGithubConnectionPanel() {
  const form = document.getElementById('github-form');
  if (!form) return;
  const fields = [
    'authMethod', 'username', 'password', 'token', 'appId',
    'installationId', 'privateKey', 'apiBase', 'scopes',
  ];
  const statusEl = document.getElementById('github-status');
  const readForm = () => {
    const obj = {};
    for (const name of fields) {
      const el = form.elements.namedItem(name);
      if (el) obj[name] = el.value || '';
    }
    return obj;
  };
  const writeForm = (data) => {
    for (const name of fields) {
      const el = form.elements.namedItem(name);
      if (el && data[name] != null) el.value = data[name];
    }
  };
  writeForm(loadGithubConnection());

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = readForm();
    if (saveGithubConnection(data)) {
      if (statusEl) statusEl.textContent = t('github.saved', '已保存到本地浏览器。');
      showToast(t('github.saved', '已保存到本地浏览器。'), 'success');
    } else {
      showToast(t('github.saveFailed', '保存失败，请检查浏览器存储权限。'), 'error');
    }
  });

  const clearBtn = document.getElementById('github-clear-button');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!window.confirm(t('github.confirmClear', '确定清除本地保存的 GitHub 凭据吗？'))) return;
      try { localStorage.removeItem(GITHUB_CONN_STORAGE_KEY); } catch (_) {}
      writeForm({ authMethod: 'pat', username: '', password: '', token: '', appId: '', installationId: '', privateKey: '', apiBase: '', scopes: '' });
      if (statusEl) statusEl.textContent = t('github.cleared', '本地凭据已清除。');
      showToast(t('github.cleared', '本地凭据已清除。'), 'success');
    });
  }

  const testBtn = document.getElementById('github-test-button');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const data = readForm();
      const base = (data.apiBase || 'https://api.github.com').replace(/\/+$/, '');
      const headers = { 'Accept': 'application/vnd.github+json' };
      if (data.authMethod === 'basic' && data.username && data.password) {
        headers['Authorization'] = 'Basic ' + btoa(`${data.username}:${data.password}`);
      } else if (data.token) {
        headers['Authorization'] = `Bearer ${data.token}`;
      }
      if (statusEl) statusEl.textContent = t('github.testing', '正在测试连通...');
      try {
        const res = await fetch(`${base}/user`, { headers, credentials: 'omit' });
        const body = await res.text();
        const text = `HTTP ${res.status}\n${body.slice(0, 800)}`;
        if (statusEl) statusEl.textContent = text;
        if (res.ok) {
          showToast(t('github.testOk', '连通成功 ✓'), 'success');
        } else {
          showToast(t('github.testFail', `连通失败：HTTP ${res.status}`), 'error');
        }
      } catch (error) {
        if (statusEl) statusEl.textContent = `error: ${error.message || String(error)}`;
        showToast(`${t('github.testFail', '连通失败')}: ${error.message || String(error)}`, 'error');
      }
    });
  }
}