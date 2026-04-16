const stateUrl = '/api/state';

const canvas = document.querySelector('#workbench-canvas');
const canvasContext = canvas.getContext('2d');
const refreshButton = document.querySelector('#refresh-button');
const sidebarTitle = document.querySelector('#sidebar-title');
const sidebarList = document.querySelector('#sidebar-list');
const sidebarTabs = Array.from(document.querySelectorAll('.sidebar-tab'));
const activityButtons = Array.from(document.querySelectorAll('.activity-button'));
const providerId = document.querySelector('#provider-id');
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
const messageStream = document.querySelector('#message-stream');
const messageTemplate = document.querySelector('#message-template');
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
const settingsForm = document.querySelector('#settings-form');
const settingProvider = document.querySelector('#setting-provider');
const settingBaseUrl = document.querySelector('#setting-base-url');
const settingModel = document.querySelector('#setting-model');
const settingPermission = document.querySelector('#setting-permission');
const settingHistory = document.querySelector('#setting-history');
const toolForm = document.querySelector('#tool-form');
const toolName = document.querySelector('#tool-name');
const toolInput = document.querySelector('#tool-input');

const urlState = new URL(window.location.href);
let currentState = null;
let currentView = 'sessions';
let currentSessionId = urlState.searchParams.get('session') || 'demo';
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
  providerId.textContent = state.status.activeProviderId || state.status.providerId || 'unknown';
  sessionTitle.textContent = activeSession?.summary?.title || 'No Session Selected';
  breadcrumbSession.textContent = sessionId;
  composerSession.textContent = `session: ${sessionId}`;
  platformPill.textContent = state.workspace.platform;
  permissionPill.textContent = state.status.permissionMode;
  workspaceRoot.textContent = state.workspace.root;
  workspaceShell.textContent = state.workspace.shell;
  defaultModel.textContent = state.config.defaultModel || 'not set';
  sessionCount.textContent = String(state.sessions.length);

  menuProvider.textContent = state.status.activeProviderId || state.status.providerId;
  menuPlatform.textContent = state.workspace.platform;
  updateClock();

  statusBranch.textContent = 'branch: main';
  statusProvider.textContent = `provider: ${state.status.activeProviderId || state.status.providerId}`;
  statusWorkspace.textContent = `workspace: ${state.workspace.root}`;
  statusShell.textContent = `shell: ${state.workspace.shell}`;
  statusPermission.textContent = `permission: ${state.status.permissionMode}`;

  renderSettings(state);
  renderSidebar(state, currentView, sessionId);
  renderMessages(activeSession?.messages || []);
  renderTerminal(state, activeSession);
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
        `${health.providerId}:${health.healthy ? 'healthy' : 'down'}:${health.latencyMs ?? '-'}ms`
      )
    )
  );
  toolList.replaceChildren(
    ...state.tools.map((tool) => createTag(`${tool.name}:${tool.minimumPermission}`))
  );
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
        title: `${health.providerId} ${health.healthy ? 'ready' : 'down'}`,
        description: `${health.model || '-'} · ${health.latencyMs ?? '-'}ms`,
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
          description: '支持 approve / plan / search / health 命令。',
        },
      ],
    },
  };

  const activeDefinition = definitions[view] || definitions.sessions;
  sidebarTitle.textContent = activeDefinition.title;
  sidebarList.innerHTML = '';

  if (!activeDefinition.items.length) {
    sidebarList.append(createEmpty('当前没有可以显示的数据。'));
    return;
  }

  activeDefinition.items.forEach((item) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `sidebar-card${item.active ? ' active' : ''}`;
    node.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.description)}</span>`;
    if (item.onSelect) {
      node.addEventListener('click', item.onSelect);
    }
    sidebarList.append(node);
  });
}

function renderMessages(messages) {
  messageStream.innerHTML = '';
  if (!messages.length) {
    messageStream.append(createEmpty('当前没有消息。通过下方输入框直接走 /api/chat 即可创建真实会话。'));
    return;
  }

  messages.forEach((message) => {
    const fragment = messageTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.message-card');
    const role = fragment.querySelector('.message-role');
    const content = fragment.querySelector('.message-content');
    card.classList.add(message.role || 'system');
    role.textContent = String(message.role || 'system').toUpperCase();
    content.textContent = message.content;
    messageStream.append(fragment);
  });

  messageStream.scrollTop = messageStream.scrollHeight;
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
      `${health.providerId} healthy=${health.healthy} model=${health.model || '-'} latency=${health.latencyMs ?? '-'}ms`
  );

  terminalOutput.textContent = [
    '[events]',
    ...(eventLog.length ? eventLog : ['waiting for API calls...']),
    '',
    '[health]',
    ...(healthLines.length ? healthLines : ['no provider health data']),
    '',
    '[config]',
    ...configLines,
    '',
    '[transcript tail]',
    ...(transcriptLines.length ? transcriptLines : ['system> no transcript loaded']),
  ].join('\n');
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
  sidebarList.innerHTML = '';
  sidebarList.append(createEmpty(`无法加载 ${stateUrl}: ${error.message}`));
  messageStream.innerHTML = '';
  messageStream.append(createEmpty('请运行 octocode-cli serve 999 demo 或 start-webui 脚本后再刷新页面。'));
  terminalOutput.textContent = `load-error\n${error.message}`;
  drawWorkbench(null, null, null);
}

function drawWorkbench(state, activeHealth, activeSession) {
  resizeCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvasContext.clearRect(0, 0, width, height);

  const gradient = canvasContext.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#f7f9fe');
  gradient.addColorStop(0.55, '#eef3fb');
  gradient.addColorStop(1, '#e6edf8');
  canvasContext.fillStyle = gradient;
  canvasContext.fillRect(0, 0, width, height);

  drawGlow(width * 0.13, height * 0.16, 280, 'rgba(218,124,66,0.18)');
  drawGlow(width * 0.8, height * 0.18, 340, 'rgba(91,125,245,0.18)');
  drawGlow(width * 0.75, height * 0.82, 320, 'rgba(47,187,125,0.14)');

  drawPanel(18, 18, width - 36, height - 36, '#ffffff', 'rgba(165,179,203,0.35)');
  drawPanel(28, 28, width - 56, 46, 'rgba(255,255,255,0.82)', 'rgba(214,222,236,0.7)');
  drawPanel(28, 82, width - 56, 58, 'rgba(249,251,255,0.95)', 'rgba(214,222,236,0.7)');
  drawPanel(28, 150, 46, height - 220, 'rgba(242,246,251,0.96)', 'rgba(214,222,236,0.9)');
  drawPanel(84, 150, 254, height - 220, 'rgba(255,255,255,0.82)', 'rgba(214,222,236,0.9)');
  drawPanel(348, 150, width - 376, height - 220, 'rgba(255,255,255,0.72)', 'rgba(214,222,236,0.9)');

  canvasContext.fillStyle = '#1b2334';
  canvasContext.font = '600 18px Outfit';
  canvasContext.fillText('Octocode Canvas Workbench', 48, 112);
  canvasContext.font = '500 12px JetBrains Mono';
  canvasContext.fillStyle = '#5f6c82';
  canvasContext.fillText(
    `active=${state?.status?.activeProviderId || 'offline'}  session=${activeSession?.summary?.id || 'none'}  permission=${state?.status?.permissionMode || '-'}`,
    48,
    132
  );

  const healths = state?.providerHealths || [];
  canvasContext.font = '600 12px JetBrains Mono';
  healths.slice(0, 3).forEach((health, index) => {
    const x = width - 350;
    const y = 96 + index * 24;
    canvasContext.fillStyle = health.healthy ? '#2f8f68' : '#c25448';
    canvasContext.fillRect(x, y - 9, 8, 8);
    canvasContext.fillStyle = '#324055';
    canvasContext.fillText(
      `${health.providerId} ${health.healthy ? 'ready' : 'fallback'} ${health.latencyMs ?? '-'}ms`,
      x + 16,
      y
    );
  });

  if (activeHealth) {
    drawStatusBadge(104, 172, activeHealth.healthy ? '#dff5e9' : '#fde5df', activeHealth.healthy ? '#2c8b63' : '#c45a47', `provider ${activeHealth.providerId}`);
    drawStatusBadge(278, 172, '#e8efff', '#4563c2', `model ${activeHealth.model || '-'}`);
  }
}

function drawPanel(x, y, width, height, fill, stroke) {
  const radius = 22;
  canvasContext.beginPath();
  canvasContext.moveTo(x + radius, y);
  canvasContext.arcTo(x + width, y, x + width, y + height, radius);
  canvasContext.arcTo(x + width, y + height, x, y + height, radius);
  canvasContext.arcTo(x, y + height, x, y, radius);
  canvasContext.arcTo(x, y, x + width, y, radius);
  canvasContext.closePath();
  canvasContext.fillStyle = fill;
  canvasContext.fill();
  canvasContext.strokeStyle = stroke;
  canvasContext.lineWidth = 1;
  canvasContext.stroke();
}

function drawGlow(x, y, radius, color) {
  const gradient = canvasContext.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  canvasContext.fillStyle = gradient;
  canvasContext.beginPath();
  canvasContext.arc(x, y, radius, 0, Math.PI * 2);
  canvasContext.fill();
}

function drawStatusBadge(x, y, fill, ink, label) {
  const width = 148;
  const height = 28;
  drawPanel(x, y, width, height, fill, 'rgba(215,223,236,0.75)');
  canvasContext.fillStyle = ink;
  canvasContext.font = '600 11px JetBrains Mono';
  canvasContext.fillText(label, x + 12, y + 18);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    canvasContext.setTransform(1, 0, 0, 1, 0, 0);
    canvasContext.scale(dpr, dpr);
  }
}

function createTag(label) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = label;
  return tag;
}

function createEmpty(message) {
  const box = document.createElement('div');
  box.className = 'empty-state';
  box.textContent = message;
  return box;
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
    applyState(state, currentSessionId);
  } catch (error) {
    logEvent(`chat error: ${error.message}`);
    renderTerminal(currentState || { config: {}, status: {}, workspace: {}, providerHealths: [] }, currentState?.activeSession);
    alert(`聊天失败: ${error.message}`);
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

refreshButton.addEventListener('click', () => loadState(currentSessionId));
window.addEventListener('resize', () => drawWorkbench(currentState, currentState?.status?.providerHealth, currentState?.activeSession));
setInterval(updateClock, 60_000);
loadState();

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
