const stateUrl = './data/app-state.json';

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
const settingsList = document.querySelector('#settings-list');
const terminalOutput = document.querySelector('#terminal-output');
const messageStream = document.querySelector('#message-stream');
const messageTemplate = document.querySelector('#message-template');
const breadcrumbSession = document.querySelector('#breadcrumb-session');
const menuProvider = document.querySelector('#menu-provider');
const menuPlatform = document.querySelector('#menu-platform');
const menuTime = document.querySelector('#menu-time');
const statusBranch = document.querySelector('#status-branch');
const statusProvider = document.querySelector('#status-provider');
const statusWorkspace = document.querySelector('#status-workspace');
const statusShell = document.querySelector('#status-shell');
const statusPermission = document.querySelector('#status-permission');

let currentState = null;
let currentView = 'sessions';

async function loadState() {
  updateClock();
  try {
    const response = await fetch(`${stateUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    currentState = await response.json();
    render(currentState);
  } catch (error) {
    renderError(error);
  }
}

function render(state) {
  const activeSession = state.activeSession ?? buildFallbackSession(state.sessions[0]);
  providerId.textContent = state.status.providerId || 'unknown';
  sessionTitle.textContent = activeSession?.summary?.title || 'No Session Selected';
  breadcrumbSession.textContent = activeSession?.summary?.id || 'none';
  platformPill.textContent = state.workspace.platform;
  permissionPill.textContent = state.status.permissionMode;
  workspaceRoot.textContent = state.workspace.root;
  workspaceShell.textContent = state.workspace.shell;
  defaultModel.textContent = state.config.defaultModel || 'not set';
  sessionCount.textContent = String(state.sessions.length);

  menuProvider.textContent = state.status.providerId;
  menuPlatform.textContent = state.workspace.platform;
  updateClock();

  statusBranch.textContent = `branch: main`;
  statusProvider.textContent = `provider: ${state.status.providerId}`;
  statusWorkspace.textContent = `workspace: ${state.workspace.root}`;
  statusShell.textContent = `shell: ${state.workspace.shell}`;
  statusPermission.textContent = `permission: ${state.status.permissionMode}`;

  providerList.replaceChildren(
    ...state.providers.map((provider) => createTag(`${provider.id}:${provider.kind}`))
  );
  toolList.replaceChildren(
    ...state.tools.map((tool) => createTag(`${tool.name}:${tool.minimumPermission}`))
  );
  settingsList.replaceChildren(...buildSettings(state).map(createSettingRow));

  renderSidebar(state, currentView, activeSession?.summary?.id);
  renderMessages(activeSession?.messages || []);
  renderTerminal(state, activeSession);
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
        onSelect: () => {
          const detail = state.activeSession?.summary?.id === session.id
            ? state.activeSession
            : buildFallbackSession(session);
          render({ ...state, activeSession: detail });
        },
      })),
    },
    providers: {
      title: 'Providers',
      items: state.providers.map((provider) => ({
        title: provider.displayName,
        description: `${provider.id} · ${provider.kind}`,
        active: provider.id === state.status.providerId,
      })),
    },
    tools: {
      title: 'Tools',
      items: state.tools.map((tool) => ({
        title: tool.name,
        description: `${tool.summary} · ${tool.minimumPermission}`,
      })),
    },
    commands: {
      title: 'Commands',
      items: state.commands.map((command) => ({
        title: command.name,
        description: command.summary,
      })),
    },
    settings: {
      title: 'Workbench Settings',
      items: buildSettings(state).map((setting) => ({
        title: setting.label,
        description: setting.description,
        active: setting.enabled,
      })),
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
    messageStream.append(createEmpty('没有可渲染的消息。运行 octocode-cli chat <session-id> <text> 后重新导出 UI snapshot。'));
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
}

function renderTerminal(state, activeSession) {
  const commandLines = state.commands.slice(0, 10).map((command) => `> ${command.name.padEnd(14)} ${command.summary}`);
  const toolLines = state.tools.map((tool) => `$ ${tool.name.padEnd(14)} ${tool.minimumPermission}`);
  const transcriptLines = (activeSession?.messages || []).map((message) => `${message.role}> ${message.content}`);

  terminalOutput.textContent = [
    `provider=${state.status.providerId}`,
    `platform=${state.workspace.platform}`,
    `permission=${state.status.permissionMode}`,
    `workspace=${state.workspace.root}`,
    '',
    '[commands]',
    ...commandLines,
    '',
    '[tools]',
    ...toolLines,
    '',
    '[transcript tail]',
    ...(transcriptLines.length ? transcriptLines : ['system> no transcript loaded']),
  ].join('\n');
}

function renderError(error) {
  providerId.textContent = 'offline';
  sessionTitle.textContent = 'UI snapshot 加载失败';
  breadcrumbSession.textContent = 'offline';
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
  toolList.replaceChildren(createTag('snapshot-missing'));
  settingsList.replaceChildren(createSettingRow({
    label: 'Snapshot Missing',
    description: `无法加载 ${stateUrl}: ${error.message}`,
    enabled: false,
  }));
  sidebarTitle.textContent = 'Offline';
  sidebarList.innerHTML = '';
  sidebarList.append(createEmpty(`无法加载 ${stateUrl}: ${error.message}`));
  messageStream.innerHTML = '';
  messageStream.append(createEmpty('请先运行 octocode-cli ui-export ui-shell/data/app-state.json demo。'));
  terminalOutput.textContent = `load-error\n${error.message}`;
}

function buildSettings(state) {
  return [
    {
      label: 'Native Menu Bar',
      description: '保留 macOS 风格 File / Edit / View / Go / Run / Terminal / Help 菜单。',
      enabled: true,
    },
    {
      label: 'Activity Bar',
      description: '沿用 VS Code 左侧工作区入口，切换会话、providers、tools 与 commands。',
      enabled: true,
    },
    {
      label: 'Workspace Split',
      description: '右上工作区保持 metadata、settings 与 provider/tool capabilities 概览。',
      enabled: true,
    },
    {
      label: 'Integrated Terminal',
      description: `右下终端区当前受 ${state.status.permissionMode} 权限模式约束。`,
      enabled: state.status.permissionMode !== 'ReadOnly',
    },
  ];
}

function buildFallbackSession(session) {
  if (!session) {
    return null;
  }
  return {
    summary: session,
    messages: [{
      role: 'system',
      content: '当前导出的 UI snapshot 没有包含该会话 transcript。请重新执行 ui-export 并指定该 session id。',
    }],
  };
}

function createTag(label) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = label;
  return tag;
}

function createSettingRow(setting) {
  const row = document.createElement('div');
  row.className = 'settings-row';
  row.innerHTML = `
    <div>
      <strong>${escapeHtml(setting.label)}</strong>
      <span>${escapeHtml(setting.description)}</span>
    </div>
  `;
  const toggle = document.createElement('span');
  toggle.className = `toggle-pill${setting.enabled ? ' enabled' : ''}`;
  row.append(toggle);
  return row;
}

function createEmpty(message) {
  const box = document.createElement('div');
  box.className = 'empty-state';
  box.textContent = message;
  return box;
}

function syncViewControls(view) {
  sidebarTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  activityButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
}

function updateClock() {
  menuTime.textContent = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

[...sidebarTabs, ...activityButtons].forEach((control) => {
  control.addEventListener('click', () => {
    currentView = control.dataset.view;
    if (currentState) {
      render(currentState);
    } else {
      syncViewControls(currentView);
    }
  });
});

refreshButton.addEventListener('click', loadState);
setInterval(updateClock, 60_000);
loadState();
