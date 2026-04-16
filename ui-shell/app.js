const stateUrl = '/api/state';

const workbenchCanvas = document.querySelector('#workbench-canvas');
const workbenchContext = workbenchCanvas.getContext('2d');
const sidebarCanvas = document.querySelector('#sidebar-canvas');
const sidebarContext = sidebarCanvas.getContext('2d');
const messageCanvas = document.querySelector('#message-canvas');
const messageContext = messageCanvas.getContext('2d');
const composerCanvas = document.querySelector('#composer-canvas');
const composerContext = composerCanvas.getContext('2d');
const refreshButton = document.querySelector('#refresh-button');
const sidebarTitle = document.querySelector('#sidebar-title');
const sidebarTabs = Array.from(document.querySelectorAll('.sidebar-tab'));
const activityButtons = Array.from(document.querySelectorAll('.activity-button'));
const providerId = document.querySelector('#provider-id');
const workspaceCanvas = document.querySelector('#workspace-canvas');
const workspaceContext = workspaceCanvas.getContext('2d');
const sessionTitle = document.querySelector('#session-title');
const platformPill = document.querySelector('#platform-pill');
const permissionPill = document.querySelector('#permission-pill');
const workspaceRoot = document.querySelector('#workspace-root');
const workspaceShell = document.querySelector('#workspace-shell');
const defaultModel = document.querySelector('#default-model');
const sessionCount = document.querySelector('#session-count');
const providerList = document.querySelector('#provider-list');
const toolList = document.querySelector('#tool-list');
const terminalOutput = document.querySelector('#terminal-output');
const terminalCanvas = document.querySelector('#terminal-canvas');
const terminalContext = terminalCanvas.getContext('2d');
const breadcrumbSession = document.querySelector('#breadcrumb-session');
const composerSession = document.querySelector('#composer-session');
const menuProvider = document.querySelector('#menu-provider');
const menuPlatform = document.querySelector('#menu-platform');
const menuTime = document.querySelector('#menu-time');
const statusBranch = document.querySelector('#status-branch');
const statusProvider = document.querySelector('#status-provider');
const statusWorkspace = document.querySelector('#status-workspace');
const statusShell = document.querySelector('#status-shell');
const statusPermission = document.querySelector('#status-permission');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const commandForm = document.querySelector('#command-form');
const commandPalette = document.querySelector('#command-palette');
const commandPreviewCanvas = document.querySelector('#command-preview-canvas');
const commandPreviewContext = commandPreviewCanvas.getContext('2d');
const settingsForm = document.querySelector('#settings-form');
const settingsCanvas = document.querySelector('#settings-canvas');
const settingsContext = settingsCanvas.getContext('2d');
const settingProvider = document.querySelector('#setting-provider');
const settingBaseUrl = document.querySelector('#setting-base-url');
const settingModel = document.querySelector('#setting-model');
const settingPermission = document.querySelector('#setting-permission');
const settingHistory = document.querySelector('#setting-history');
const toolForm = document.querySelector('#tool-form');
const toolCanvas = document.querySelector('#tool-canvas');
const toolContext = toolCanvas.getContext('2d');
const toolName = document.querySelector('#tool-name');
const toolInput = document.querySelector('#tool-input');

const urlState = new URL(window.location.href);

let currentState = null;
let currentView = 'sessions';
let currentSessionId = urlState.searchParams.get('session') || 'demo';
let currentMessages = [];
let selectedMessageIndex = null;
let sidebarItems = [];
let sidebarScrollOffset = 0;
let sidebarContentHeight = 0;
let sidebarHitRegions = [];
let messageScrollOffset = 0;
let messageContentHeight = 0;
let messageHitRegions = [];
const eventLog = [];

async function loadState(sessionId = currentSessionId) {
  updateClock();
  try {
    const url = new URL(stateUrl, window.location.origin);
    if (sessionId) {
      url.searchParams.set('session', sessionId);
    }
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const state = await response.json();
    applyState(state, sessionId);
    logEvent(`GET ${url.pathname} session=${sessionId || '-'}`);
  } catch (error) {
    renderError(error);
  }
}

function applyState(state, preferredSessionId) {
  currentState = state;
  currentSessionId =
    preferredSessionId ||
    state.activeSession?.summary?.id ||
    state.sessions[0]?.id ||
    'demo';
  urlState.searchParams.set('session', currentSessionId);
  window.history.replaceState({}, '', urlState);
  render(state);
}

function render(state) {
  const activeSession = state.activeSession ?? buildFallbackSession(state.sessions[0]);
  const sessionId = activeSession?.summary?.id || currentSessionId || 'demo';
  const activeHealth = state.status.providerHealth || null;
  const activeProviderId = state.status.activeProviderId || state.status.providerId || 'unknown';

  providerId.textContent = activeProviderId;
  sessionTitle.textContent = activeSession?.summary?.title || 'No Session Selected';
  breadcrumbSession.textContent = sessionId;
  composerSession.textContent = `session: ${sessionId}`;
  platformPill.textContent = state.workspace.platform;
  permissionPill.textContent = state.status.permissionMode;
  workspaceRoot.textContent = state.workspace.root;
  workspaceShell.textContent = state.workspace.shell;
  defaultModel.textContent = state.config.defaultModel || 'not set';
  sessionCount.textContent = String(state.sessions.length);

  menuProvider.textContent = activeProviderId;
  menuPlatform.textContent = state.workspace.platform;
  updateClock();

  statusBranch.textContent = 'branch: main';
  statusProvider.textContent = `provider: ${activeProviderId}`;
  statusWorkspace.textContent = `workspace: ${state.workspace.root}`;
  statusShell.textContent = `shell: ${state.workspace.shell}`;
  statusPermission.textContent = `permission: ${state.status.permissionMode}`;

  renderSettings(state);
  renderSidebar(state, currentView, sessionId);
  renderMessages(activeSession?.messages || []);
  renderTerminal(state, activeSession);
  drawWorkspaceCanvas(state);
  drawToolCanvas(state);
  drawComposerCanvas(activeSession);
  drawCommandPreviewCanvas();
  drawWorkbench(state, activeHealth, activeSession);
}

function renderSettings(state) {
  settingProvider.innerHTML = '';
  state.providers.forEach((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${provider.displayName} (${provider.id})`;
    if (provider.id === state.config.providerId) {
      option.selected = true;
    }
    settingProvider.append(option);
  });

  toolName.innerHTML = '';
  state.tools.forEach((tool) => {
    const option = document.createElement('option');
    option.value = tool.name;
    option.textContent = `${tool.name} · ${tool.minimumPermission}`;
    toolName.append(option);
  });

  settingBaseUrl.value = state.config.providerBaseUrl || '';
  settingModel.value = state.config.defaultModel || '';
  settingPermission.value = normalizePermissionValue(state.config.permissionMode);
  settingHistory.value = String(state.config.historyLimit || 24);

  providerList.replaceChildren(
    ...state.providerHealths.map((health) =>
      createTag(
        `${health.providerId}:${health.circuitState}:f${health.failureCount}:cd${health.cooldownRemainingMs ?? 0}`
      )
    )
  );
  toolList.replaceChildren(
    ...state.tools.map((tool) => createTag(`${tool.name}:${tool.minimumPermission}`))
  );
  drawSettingsCanvas(state);
}

function renderSidebar(state, view, activeSessionId) {
  syncViewControls(view);
  const definitions = {
    sessions: {
      title: 'Sessions',
      items: state.sessions.map((session) => ({
        title: session.title,
        description: `${session.id} ${session.model || ''}`.trim(),
        active: session.id === activeSessionId,
        onSelect: () => loadState(session.id),
      })),
    },
    providers: {
      title: 'Providers',
      items: state.providerHealths.map((health) => ({
        title: `${health.providerId} ${health.circuitState}`,
        description: `${health.healthy ? 'ready' : 'cooldown'} · fail=${health.failureCount} · ${health.cooldownRemainingMs ?? 0}ms`,
        active: health.providerId === state.status.activeProviderId,
        onSelect: () => {
          settingProvider.value = health.providerId;
          currentView = 'settings';
          renderSidebar(state, currentView, activeSessionId);
        },
      })),
    },
    tools: {
      title: 'Tools',
      items: state.tools.map((tool) => ({
        title: tool.name,
        description: `${tool.summary} · ${tool.minimumPermission}`,
        onSelect: () => {
          toolName.value = tool.name;
        },
      })),
    },
    commands: {
      title: 'Commands',
      items: state.commands.map((command) => ({
        title: command.name,
        description: command.summary,
        onSelect: () => {
          commandPalette.value = command.name === 'resume' ? 'reload' : command.name;
        },
      })),
    },
    settings: {
      title: 'Settings',
      items: [
        {
          title: `provider=${state.config.providerId || ''}`,
          description: `base=${state.config.providerBaseUrl || ''}`,
        },
        {
          title: `model=${state.config.defaultModel || ''}`,
          description: `history=${state.config.historyLimit}`,
        },
        {
          title: `permission=${state.config.permissionMode}`,
          description: 'canvas sidebar hit-test active',
        },
      ],
    },
  };

  const activeDefinition = definitions[view] || definitions.sessions;
  sidebarTitle.textContent = activeDefinition.title;
  sidebarItems = activeDefinition.items;
  drawSidebarCanvas();
}

function renderMessages(messages) {
  currentMessages = messages;
  if (selectedMessageIndex !== null && selectedMessageIndex >= currentMessages.length) {
    selectedMessageIndex = null;
  }
  drawMessageCanvas(true);
}

function renderTerminal(state, activeSession) {
  const transcriptLines = (activeSession?.messages || [])
    .slice(-8)
    .map((message) => `${message.role}> ${message.content}`);
  const configLines = [
    `provider=${state.config.providerId || '-'}`,
    `activeProvider=${state.status.activeProviderId || '-'}`,
    `baseUrl=${state.config.providerBaseUrl || '-'}`,
    `model=${state.config.defaultModel || '-'}`,
    `permission=${state.config.permissionMode}`,
    `historyLimit=${state.config.historyLimit}`,
  ];
  const healthLines = (state.providerHealths || []).map(
    (health) =>
      `${health.providerId} state=${health.circuitState} healthy=${health.healthy} fails=${health.failureCount} cooldown=${health.cooldownRemainingMs ?? 0}ms`
  );
  const circuitLines = (state.providerCircuits || []).flatMap((circuit) => [
    `${circuit.providerId} recent=${circuit.recentFailureReason || '-'} opened=${circuit.lastOpenedAtMs || '-'} recovered=${circuit.lastRecoveredAtMs || '-'}`,
    ...circuit.eventLog.slice(-3).map((event) => `  [${event.atMs}] ${event.kind} ${event.detail}`),
  ]);

  terminalOutput.textContent = [
    '[events]',
    ...(eventLog.length ? eventLog : ['waiting for API calls...']),
    '',
    '[health]',
    ...(healthLines.length ? healthLines : ['no provider health data']),
    '',
    '[circuits]',
    ...(circuitLines.length ? circuitLines : ['no circuit events']),
    '',
    '[config]',
    ...configLines,
    '',
    '[transcript tail]',
    ...(transcriptLines.length ? transcriptLines : ['system> no transcript loaded']),
  ].join('\n');
  drawTerminalCanvas(terminalOutput.textContent.split('\n'));
}

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
  providerList.replaceChildren(createTag('load-error'));
  toolList.replaceChildren(createTag('api-unreachable'));
  sidebarTitle.textContent = 'Offline';
  sidebarItems = [];
  currentMessages = [];
  drawSidebarCanvas('无法加载侧栏数据');
  drawMessageCanvas(false, '请运行 octocode-cli serve 999 demo 或 start-webui 脚本后再刷新页面。');
  terminalOutput.textContent = `load-error\n${error.message}`;
  drawTerminalCanvas(terminalOutput.textContent.split('\n'));
  drawSettingsCanvas(null, error.message);
  drawWorkspaceCanvas(null, error.message);
  drawToolCanvas(null, error.message);
  drawComposerCanvas(null, error.message);
  drawCommandPreviewCanvas('API unavailable');
  drawWorkbench(null, null, null);
}

function drawWorkspaceCanvas(state, errorMessage) {
  const { width, height } = prepareCanvas(workspaceCanvas, workspaceContext);
  workspaceContext.clearRect(0, 0, width, height);
  drawPanel(workspaceContext, 0.5, 0.5, width - 1, height - 1, 'rgba(250,252,255,0.96)', 'rgba(214,222,236,0.9)');
  workspaceContext.fillStyle = '#233149';
  workspaceContext.font = '600 12px JetBrains Mono';
  workspaceContext.fillText('Canvas Workspace Summary', 16, 24);
  workspaceContext.font = '500 11px JetBrains Mono';
  workspaceContext.fillStyle = '#6a7890';

  if (!state) {
    drawWrappedText(workspaceContext, errorMessage || 'workspace unavailable', 16, 46, width - 32, 16, 4);
    return;
  }

  const cards = [
    `root ${state.workspace.root || '-'}`,
    `shell ${state.workspace.shell || '-'}`,
    `model ${state.config.defaultModel || '-'}`,
    `sessions ${state.sessions.length}`,
    `provider ${state.status.activeProviderId || state.status.providerId || '-'}`,
    `circuit ${state.status.providerCircuit?.circuitState || '-'}`,
  ];
  cards.forEach((line, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 14 + column * ((width - 42) / 2 + 8);
    const y = 40 + row * 36;
    const cardWidth = (width - 42) / 2;
    drawPanel(workspaceContext, x, y, cardWidth, 26, 'rgba(255,255,255,0.92)', 'rgba(220,226,238,0.9)');
    drawWrappedText(workspaceContext, line, x + 10, y + 16, cardWidth - 18, 14, 1);
  });
}

function drawToolCanvas(state, errorMessage) {
  const { width, height } = prepareCanvas(toolCanvas, toolContext);
  toolContext.clearRect(0, 0, width, height);
  drawPanel(toolContext, 0.5, 0.5, width - 1, height - 1, 'rgba(251,252,255,0.95)', 'rgba(214,222,236,0.9)');
  toolContext.fillStyle = '#233149';
  toolContext.font = '600 12px JetBrains Mono';
  toolContext.fillText('Canvas Tool Runner', 16, 24);
  toolContext.font = '500 11px JetBrains Mono';
  toolContext.fillStyle = '#6a7890';

  if (!state) {
    drawWrappedText(toolContext, errorMessage || 'tool runner unavailable', 16, 48, width - 32, 16, 4);
    return;
  }

  const activeTool = toolName.value || state.tools[0]?.name || 'echo';
  const summary = state.tools.find((tool) => tool.name === activeTool)?.summary || 'select a tool';
  drawWrappedText(toolContext, `${activeTool} · ${summary}`, 16, 48, width - 32, 16, 2);
  drawWrappedText(toolContext, 'Use the native controls below as an input layer while the visual shell stays on canvas.', 16, 86, width - 32, 16, 3);
}

function drawComposerCanvas(activeSession, errorMessage) {
  const { width, height } = prepareCanvas(composerCanvas, composerContext);
  composerContext.clearRect(0, 0, width, height);
  drawPanel(composerContext, 0.5, 0.5, width - 1, height - 1, 'rgba(255,255,255,0.94)', 'rgba(214,222,236,0.86)');
  composerContext.fillStyle = '#20304a';
  composerContext.font = '600 12px JetBrains Mono';
  composerContext.fillText('Canvas Composer Shell', 16, 24);
  composerContext.font = '500 11px JetBrains Mono';
  composerContext.fillStyle = '#67748b';

  const text = errorMessage || chatInput.value.trim() || 'Native textarea retained for IME-safe input while the shell is canvas-rendered.';
  drawWrappedText(composerContext, text, 16, 46, width - 32, 16, 4);

  const sessionLabel = activeSession?.summary?.id || currentSessionId || 'demo';
  drawStatusBadge(composerContext, 16, height - 34, '#eef3ff', '#4462c1', `session ${sessionLabel}`);
  drawStatusBadge(composerContext, 156, height - 34, '#edf8f1', '#2c8b63', `chars ${chatInput.value.length}`);
}

function drawCommandPreviewCanvas(overrideHint) {
  const { width, height } = prepareCanvas(commandPreviewCanvas, commandPreviewContext);
  commandPreviewContext.clearRect(0, 0, width, height);
  drawPanel(commandPreviewContext, 0.5, 0.5, width - 1, height - 1, 'rgba(251,253,255,0.94)', 'rgba(214,222,236,0.9)');

  const query = overrideHint || commandPalette.value.trim();
  const commands = currentState?.commands || [];
  const matches = query
    ? commands.filter((command) => `${command.name} ${command.summary}`.toLowerCase().includes(query.toLowerCase())).slice(0, 3)
    : commands.slice(0, 3);

  commandPreviewContext.fillStyle = '#233149';
  commandPreviewContext.font = '600 12px JetBrains Mono';
  commandPreviewContext.fillText('Command Palette Preview', 16, 24);
  commandPreviewContext.font = '500 11px JetBrains Mono';
  commandPreviewContext.fillStyle = '#60708a';
  commandPreviewContext.fillText(query || 'type to filter commands', 16, 42);

  if (!matches.length) {
    drawWrappedText(commandPreviewContext, 'no matching commands', 16, 68, width - 32, 16, 2);
    return;
  }

  matches.forEach((command, index) => {
    const y = 58 + index * 16;
    commandPreviewContext.fillStyle = '#2b3954';
    commandPreviewContext.font = '600 11px JetBrains Mono';
    commandPreviewContext.fillText(command.name, 16, y);
    commandPreviewContext.fillStyle = '#73819a';
    commandPreviewContext.font = '500 11px JetBrains Mono';
    drawWrappedText(commandPreviewContext, command.summary, 122, y, width - 138, 14, 1);
  });
}

function drawSettingsCanvas(state, errorMessage) {
  const { width, height } = prepareCanvas(settingsCanvas, settingsContext);
  settingsContext.clearRect(0, 0, width, height);
  drawPanel(settingsContext, 0.5, 0.5, width - 1, height - 1, 'rgba(250,252,255,0.9)', 'rgba(214,222,236,0.88)');

  settingsContext.fillStyle = '#20304a';
  settingsContext.font = '600 12px JetBrains Mono';
  settingsContext.fillText('Canvas Settings List', 16, 24);
  settingsContext.font = '500 11px JetBrains Mono';
  settingsContext.fillStyle = '#6d7b92';

  if (!state) {
    drawWrappedText(settingsContext, errorMessage || 'settings unavailable', 16, 48, width - 32, 16, 4);
    return;
  }

  const lines = [
    `provider  ${state.config.providerId || '-'}`,
    `base url  ${state.config.providerBaseUrl || '-'}`,
    `model     ${state.config.defaultModel || '-'}`,
    `mode      ${state.config.permissionMode}`,
    `history   ${state.config.historyLimit}`,
  ];
  lines.forEach((line, index) => {
    const y = 52 + index * 24;
    drawPanel(settingsContext, 14, y - 14, width - 28, 18, 'rgba(255,255,255,0.9)', 'rgba(220,226,238,0.9)');
    settingsContext.fillStyle = '#2a3850';
    settingsContext.fillText(line, 22, y);
  });
}

function drawTerminalCanvas(lines) {
  const { width, height } = prepareCanvas(terminalCanvas, terminalContext);
  terminalContext.clearRect(0, 0, width, height);
  drawPanel(terminalContext, 0.5, 0.5, width - 1, height - 1, 'rgba(13,18,27,0.96)', 'rgba(72,84,104,0.85)');

  terminalContext.fillStyle = '#8fe1b1';
  terminalContext.font = '600 12px JetBrains Mono';
  terminalContext.fillText('terminal.viewer', 16, 22);
  terminalContext.fillStyle = '#9eb3d1';
  terminalContext.font = '500 11px JetBrains Mono';

  const visibleLines = (lines || []).slice(0, Math.max(1, Math.floor((height - 38) / 16)));
  visibleLines.forEach((line, index) => {
    const y = 44 + index * 16;
    drawWrappedText(terminalContext, line, 16, y, width - 32, 14, 1);
  });
}

function drawWorkbench(state, activeHealth, activeSession) {
  const { width, height } = prepareCanvas(workbenchCanvas, workbenchContext);
  workbenchContext.clearRect(0, 0, width, height);

  const gradient = workbenchContext.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#f7f9fe');
  gradient.addColorStop(0.55, '#eef3fb');
  gradient.addColorStop(1, '#e6edf8');
  workbenchContext.fillStyle = gradient;
  workbenchContext.fillRect(0, 0, width, height);

  drawGlow(workbenchContext, width * 0.13, height * 0.16, 280, 'rgba(218,124,66,0.18)');
  drawGlow(workbenchContext, width * 0.8, height * 0.18, 340, 'rgba(91,125,245,0.18)');
  drawGlow(workbenchContext, width * 0.75, height * 0.82, 320, 'rgba(47,187,125,0.14)');

  drawPanel(workbenchContext, 18, 18, width - 36, height - 36, '#ffffff', 'rgba(165,179,203,0.35)');
  drawPanel(workbenchContext, 28, 28, width - 56, 46, 'rgba(255,255,255,0.82)', 'rgba(214,222,236,0.7)');
  drawPanel(workbenchContext, 28, 82, width - 56, 58, 'rgba(249,251,255,0.95)', 'rgba(214,222,236,0.7)');
  drawPanel(workbenchContext, 28, 150, 46, height - 220, 'rgba(242,246,251,0.96)', 'rgba(214,222,236,0.9)');
  drawPanel(workbenchContext, 84, 150, 254, height - 220, 'rgba(255,255,255,0.82)', 'rgba(214,222,236,0.9)');
  drawPanel(workbenchContext, 348, 150, width - 376, height - 220, 'rgba(255,255,255,0.72)', 'rgba(214,222,236,0.9)');

  workbenchContext.fillStyle = '#1b2334';
  workbenchContext.font = '600 18px Outfit';
  workbenchContext.fillText('Octocode Canvas Workbench', 48, 112);
  workbenchContext.font = '500 12px JetBrains Mono';
  workbenchContext.fillStyle = '#5f6c82';
  workbenchContext.fillText(
    `active=${state?.status?.activeProviderId || 'offline'}  session=${activeSession?.summary?.id || 'none'}  permission=${state?.status?.permissionMode || '-'}  selected=${selectedMessageIndex ?? '-'}`,
    48,
    132
  );

  const healths = state?.providerHealths || [];
  workbenchContext.font = '600 12px JetBrains Mono';
  healths.slice(0, 3).forEach((health, index) => {
    const x = width - 430;
    const y = 96 + index * 24;
    workbenchContext.fillStyle = health.healthy ? '#2f8f68' : '#c25448';
    workbenchContext.fillRect(x, y - 9, 8, 8);
    workbenchContext.fillStyle = '#324055';
    workbenchContext.fillText(
      `${health.providerId} ${health.circuitState} fail=${health.failureCount} cd=${health.cooldownRemainingMs ?? 0}ms`,
      x + 16,
      y
    );
  });

  if (activeHealth) {
    drawStatusBadge(workbenchContext, 104, 172, activeHealth.healthy ? '#dff5e9' : '#fde5df', activeHealth.healthy ? '#2c8b63' : '#c45a47', `provider ${activeHealth.providerId}`);
    drawStatusBadge(workbenchContext, 278, 172, '#e8efff', '#4563c2', `state ${activeHealth.circuitState}`);
    drawStatusBadge(workbenchContext, 452, 172, '#fff0df', '#b76b34', `fails ${activeHealth.failureCount}`);
  }
}

function drawSidebarCanvas(emptyMessage) {
  const { width, height } = prepareCanvas(sidebarCanvas, sidebarContext);
  sidebarContext.clearRect(0, 0, width, height);
  sidebarHitRegions = [];
  sidebarContentHeight = 0;

  drawPanel(sidebarContext, 0.5, 0.5, width - 1, height - 1, 'rgba(251,252,255,0.9)', 'rgba(216,222,234,0.9)');

  if (!sidebarItems.length) {
    drawCanvasEmptyState(sidebarContext, width, height, emptyMessage || '当前没有可以显示的数据。');
    sidebarCanvas.style.cursor = 'default';
    return;
  }

  const padding = 12;
  const cardHeight = 64;
  const gap = 10;
  let y = padding - sidebarScrollOffset;

  sidebarItems.forEach((item) => {
    if (y + cardHeight >= 0 && y <= height) {
      const fill = item.active ? 'rgba(231,237,255,0.95)' : 'rgba(255,255,255,0.92)';
      const stroke = item.active ? 'rgba(91,125,245,0.35)' : 'rgba(216,222,234,0.9)';
      drawPanel(sidebarContext, padding, y, width - padding * 2, cardHeight, fill, stroke);
      sidebarContext.fillStyle = '#182131';
      sidebarContext.font = '600 13px Outfit';
      sidebarContext.fillText(item.title, padding + 14, y + 22);
      sidebarContext.fillStyle = '#5f6c82';
      sidebarContext.font = '500 11px JetBrains Mono';
      drawWrappedText(sidebarContext, item.description, padding + 14, y + 41, width - padding * 2 - 28, 14, 2);
      sidebarHitRegions.push({
        x: padding,
        y,
        width: width - padding * 2,
        height: cardHeight,
        onSelect: item.onSelect,
      });
    }
    y += cardHeight + gap;
  });

  sidebarContentHeight = sidebarItems.length * (cardHeight + gap) - gap + padding * 2;
  sidebarScrollOffset = clamp(sidebarScrollOffset, 0, Math.max(0, sidebarContentHeight - height));
}

function drawMessageCanvas(resetToBottom = false, emptyMessage) {
  const { width, height } = prepareCanvas(messageCanvas, messageContext);
  messageContext.clearRect(0, 0, width, height);
  messageHitRegions = [];

  drawPanel(messageContext, 0.5, 0.5, width - 1, height - 1, 'rgba(252,253,255,0.82)', 'rgba(216,222,234,0.85)');

  if (!currentMessages.length) {
    messageContentHeight = 0;
    drawCanvasEmptyState(messageContext, width, height, emptyMessage || '当前没有消息。通过下方输入框直接走 /api/chat 即可创建真实会话。');
    messageCanvas.style.cursor = 'default';
    return;
  }

  const padding = 14;
  const gap = 12;
  const innerWidth = width - padding * 2;
  const layouts = [];
  let cursorY = padding;

  currentMessages.forEach((message, index) => {
    const roleLabel = String(message.role || 'system').toUpperCase();
    const textLines = measureWrappedLines(messageContext, message.content, innerWidth - 28, '500 13px Outfit');
    const cardHeight = 22 + 20 + textLines.length * 18 + 18;
    layouts.push({
      index,
      message,
      roleLabel,
      lines: textLines,
      y: cursorY,
      height: cardHeight,
    });
    cursorY += cardHeight + gap;
  });

  messageContentHeight = cursorY - gap + padding;
  if (resetToBottom) {
    messageScrollOffset = Math.max(0, messageContentHeight - height);
  } else {
    messageScrollOffset = clamp(messageScrollOffset, 0, Math.max(0, messageContentHeight - height));
  }

  layouts.forEach((layout) => {
    const y = layout.y - messageScrollOffset;
    if (y + layout.height < 0 || y > height) {
      return;
    }

    const role = layout.message.role || 'system';
    const palette = messagePalette(role, layout.index === selectedMessageIndex);
    drawPanel(messageContext, padding, y, innerWidth, layout.height, palette.fill, palette.stroke);
    messageContext.fillStyle = palette.role;
    messageContext.font = '600 11px JetBrains Mono';
    messageContext.fillText(layout.roleLabel, padding + 14, y + 18);
    messageContext.fillStyle = '#1d2536';
    messageContext.font = '500 13px Outfit';
    let lineY = y + 42;
    layout.lines.forEach((line) => {
      messageContext.fillText(line, padding + 14, lineY);
      lineY += 18;
    });

    messageHitRegions.push({
      x: padding,
      y,
      width: innerWidth,
      height: layout.height,
      onSelect: () => {
        selectedMessageIndex = layout.index;
        drawMessageCanvas(false);
      },
    });
  });
}

function drawPanel(context, x, y, width, height, fill, stroke) {
  const radius = 18;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = stroke;
  context.lineWidth = 1;
  context.stroke();
}

function drawGlow(context, x, y, radius, color) {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

function drawStatusBadge(context, x, y, fill, ink, label) {
  const width = 148;
  const height = 28;
  drawPanel(context, x, y, width, height, fill, 'rgba(215,223,236,0.75)');
  context.fillStyle = ink;
  context.font = '600 11px JetBrains Mono';
  context.fillText(label, x + 12, y + 18);
}

function drawCanvasEmptyState(context, width, height, message) {
  context.fillStyle = '#5f6c82';
  context.font = '500 13px Outfit';
  drawWrappedText(context, message, 18, Math.max(40, height / 2 - 10), width - 36, 18, 4);
}

function prepareCanvas(canvas, context) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.floor(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function measureWrappedLines(context, text, maxWidth, font) {
  context.font = font;
  return wrapText(context, text, maxWidth);
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines = Infinity) {
  const lines = wrapText(context, text, maxWidth).slice(0, maxLines);
  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight);
  });
}

function wrapText(context, text, maxWidth) {
  const content = String(text || '').replaceAll('\r', '');
  const paragraphs = content.split('\n');
  const lines = [];
  paragraphs.forEach((paragraph) => {
    if (!paragraph.trim()) {
      lines.push('');
      return;
    }
    let currentLine = '';
    paragraph.split(/\s+/).forEach((word) => {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = breakLongWord(context, word, maxWidth, lines);
      }
    });
    if (currentLine) {
      lines.push(currentLine);
    }
  });
  return lines.length ? lines : [''];
}

function breakLongWord(context, word, maxWidth, lines) {
  if (context.measureText(word).width <= maxWidth) {
    return word;
  }
  let segment = '';
  for (const character of word) {
    const candidate = `${segment}${character}`;
    if (context.measureText(candidate).width <= maxWidth) {
      segment = candidate;
    } else {
      if (segment) {
        lines.push(segment);
      }
      segment = character;
    }
  }
  return segment;
}

function messagePalette(role, selected) {
  const selectedStroke = 'rgba(91,125,245,0.45)';
  if (role === 'user') {
    return {
      fill: selected ? 'rgba(254,244,235,0.98)' : 'rgba(253,247,242,0.96)',
      stroke: selected ? selectedStroke : 'rgba(242,209,189,0.95)',
      role: '#b8703e',
    };
  }
  if (role === 'assistant') {
    return {
      fill: selected ? 'rgba(231,237,255,0.98)' : 'rgba(236,241,255,0.94)',
      stroke: selected ? selectedStroke : 'rgba(207,219,255,0.95)',
      role: '#4964bf',
    };
  }
  if (role === 'tool') {
    return {
      fill: selected ? 'rgba(227,247,239,0.98)' : 'rgba(233,248,241,0.95)',
      stroke: selected ? selectedStroke : 'rgba(201,236,217,0.95)',
      role: '#2c8b63',
    };
  }
  return {
    fill: selected ? 'rgba(244,247,252,0.98)' : 'rgba(246,248,252,0.95)',
    stroke: selected ? selectedStroke : 'rgba(216,222,234,0.95)',
    role: '#5f6c82',
  };
}

function findHitRegion(regions, x, y) {
  return regions.find(
    (region) =>
      x >= region.x &&
      x <= region.x + region.width &&
      y >= region.y &&
      y <= region.y + region.height
  );
}

function bindCanvasInteractions(canvas, regionsAccessor, onMiss, redraw) {
  canvas.addEventListener('click', (event) => {
    const point = canvasPoint(event, canvas);
    const region = findHitRegion(regionsAccessor(), point.x, point.y);
    if (region?.onSelect) {
      region.onSelect();
      return;
    }
    if (onMiss) {
      onMiss();
      redraw();
    }
  });

  canvas.addEventListener('mousemove', (event) => {
    const point = canvasPoint(event, canvas);
    const region = findHitRegion(regionsAccessor(), point.x, point.y);
    canvas.style.cursor = region?.onSelect ? 'pointer' : 'default';
  });
}

function canvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createTag(label) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = label;
  return tag;
}

function buildFallbackSession(session) {
  if (!session) {
    return null;
  }
  return {
    summary: session,
    messages: [
      {
        role: 'system',
        content: '当前会话尚未载入 transcript，请从左侧切换或直接发送消息。',
      },
    ],
  };
}

function syncViewControls(view) {
  sidebarTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  activityButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
}

function normalizePermissionValue(value) {
  switch (value) {
    case 'ReadOnly':
      return 'read-only';
    case 'DangerFullAccess':
      return 'danger-full-access';
    default:
      return 'workspace-write';
  }
}

function updateClock() {
  menuTime.textContent = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function logEvent(text) {
  eventLog.unshift(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${text}`);
  if (eventLog.length > 18) {
    eventLog.length = 18;
  }
}

async function postForm(url, fields) {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      body.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }

  return response.json();
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  try {
    const state = await postForm('/api/chat', {
      sessionId: currentSessionId,
      text,
    });
    logEvent(`POST /api/chat session=${currentSessionId}`);
    chatInput.value = '';
    selectedMessageIndex = null;
    applyState(state, currentSessionId);
  } catch (error) {
    logEvent(`chat error: ${error.message}`);
    renderTerminal(currentState || { config: {}, status: {}, workspace: {}, providerHealths: [] }, currentState?.activeSession);
    alert(`聊天失败: ${error.message}`);
  }
});

chatInput.addEventListener('input', () => drawComposerCanvas(currentState?.activeSession));

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
    logEvent('POST /api/settings');
    applyState(state, currentSessionId);
  } catch (error) {
    logEvent(`settings error: ${error.message}`);
    alert(`保存设置失败: ${error.message}`);
  }
});

toolForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const state = await postForm('/api/tool', {
      sessionId: currentSessionId,
      name: toolName.value,
      input: toolInput.value,
    });
    logEvent(`POST /api/tool name=${toolName.value}`);
    applyState(state, currentSessionId);
  } catch (error) {
    logEvent(`tool error: ${error.message}`);
    alert(`工具执行失败: ${error.message}`);
  }
});

toolName.addEventListener('change', () => drawToolCanvas(currentState));
toolInput.addEventListener('input', () => drawToolCanvas(currentState));

commandForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const command = commandPalette.value.trim();
  if (!command) {
    return;
  }
  try {
    const state = await postForm('/api/command', {
      sessionId: currentSessionId,
      command,
    });
    logEvent(`POST /api/command command=${command}`);
    applyState(state, currentSessionId);
  } catch (error) {
    logEvent(`command error: ${error.message}`);
    alert(`命令执行失败: ${error.message}`);
  }
});

commandPalette.addEventListener('input', () => drawCommandPreviewCanvas());

[...sidebarTabs, ...activityButtons].forEach((control) => {
  control.addEventListener('click', () => {
    currentView = control.dataset.view;
    if (currentState) {
      renderSidebar(currentState, currentView, currentSessionId);
    } else {
      syncViewControls(currentView);
    }
  });
});

bindCanvasInteractions(sidebarCanvas, () => sidebarHitRegions, null, () => drawSidebarCanvas());
bindCanvasInteractions(
  messageCanvas,
  () => messageHitRegions,
  () => {
    selectedMessageIndex = null;
  },
  () => drawMessageCanvas(false)
);

sidebarCanvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const maxOffset = Math.max(0, sidebarContentHeight - sidebarCanvas.getBoundingClientRect().height);
    sidebarScrollOffset = clamp(sidebarScrollOffset + event.deltaY, 0, maxOffset);
    drawSidebarCanvas();
  },
  { passive: false }
);

messageCanvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const maxOffset = Math.max(0, messageContentHeight - messageCanvas.getBoundingClientRect().height);
    messageScrollOffset = clamp(messageScrollOffset + event.deltaY, 0, maxOffset);
    drawMessageCanvas(false);
  },
  { passive: false }
);

refreshButton.addEventListener('click', () => loadState(currentSessionId));
window.addEventListener('resize', () => {
  drawWorkbench(currentState, currentState?.status?.providerHealth, currentState?.activeSession);
  drawSidebarCanvas();
  drawMessageCanvas(false);
  drawWorkspaceCanvas(currentState);
  drawToolCanvas(currentState);
  drawComposerCanvas(currentState?.activeSession);
  drawCommandPreviewCanvas();
  drawSettingsCanvas(currentState);
  drawTerminalCanvas(terminalOutput.textContent.split('\n'));
});

setInterval(updateClock, 60_000);
loadState();