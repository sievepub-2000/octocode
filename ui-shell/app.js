const stateUrl = './data/app-state.json';

const refreshButton = document.querySelector('#refresh-button');
const sessionList = document.querySelector('#session-list');
const providerId = document.querySelector('#provider-id');
const sessionTitle = document.querySelector('#session-title');
const platformPill = document.querySelector('#platform-pill');
const permissionPill = document.querySelector('#permission-pill');
const workspaceRoot = document.querySelector('#workspace-root');
const workspaceShell = document.querySelector('#workspace-shell');
const defaultModel = document.querySelector('#default-model');
const providerList = document.querySelector('#provider-list');
const toolList = document.querySelector('#tool-list');
const terminalOutput = document.querySelector('#terminal-output');
const messageStream = document.querySelector('#message-stream');
const messageTemplate = document.querySelector('#message-template');

let currentState = null;

async function loadState() {
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
  providerId.textContent = state.status.providerId || 'unknown';
  sessionTitle.textContent = state.activeSession?.summary?.title || '选择一个会话后将显示对话';
  platformPill.textContent = state.workspace.platform;
  permissionPill.textContent = state.status.permissionMode;
  workspaceRoot.textContent = state.workspace.root;
  workspaceShell.textContent = state.workspace.shell;
  defaultModel.textContent = state.config.defaultModel || 'not set';

  providerList.replaceChildren(
    ...state.providers.map((provider) => createTag(`${provider.id}:${provider.kind}`))
  );
  toolList.replaceChildren(...state.tools.map((tool) => createTag(`${tool.name}:${tool.minimumPermission}`)));

  renderSessions(state.sessions, state.activeSession?.summary?.id);
  renderMessages(state.activeSession?.messages || []);
  renderTerminal(state);
}

function renderSessions(sessions, activeId) {
  sessionList.innerHTML = '';
  if (!sessions.length) {
    sessionList.append(createEmpty('当前没有 session，请先通过 CLI 执行 chat 或 session-add。'));
    return;
  }

  sessions.forEach((session) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `session-item${session.id === activeId ? ' active' : ''}`;
    item.innerHTML = `<strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.id)}</span>`;
    item.addEventListener('click', () => {
      if (!currentState) {
        return;
      }
      const detail = currentState.activeSession?.summary?.id === session.id
        ? currentState.activeSession
        : {
            summary: session,
            messages: [{ role: 'system', content: '当前导出的 UI snapshot 没有包含该会话的 transcript。请重新执行 ui-export 并指定该 session id。' }],
          };
      render({ ...currentState, activeSession: detail });
    });
    sessionList.append(item);
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

function renderTerminal(state) {
  const commandLines = state.commands.slice(0, 8).map((command) => `> ${command.name.padEnd(14)} ${command.summary}`);
  const toolLines = state.tools.map((tool) => `$ ${tool.name.padEnd(14)} ${tool.minimumPermission}`);
  terminalOutput.textContent = [
    `provider=${state.status.providerId}`,
    `platform=${state.workspace.platform}`,
    `permission=${state.status.permissionMode}`,
    '',
    '[commands]',
    ...commandLines,
    '',
    '[tools]',
    ...toolLines,
  ].join('\n');
}

function renderError(error) {
  providerId.textContent = 'offline';
  sessionTitle.textContent = 'UI snapshot 加载失败';
  platformPill.textContent = '-';
  permissionPill.textContent = '-';
  workspaceRoot.textContent = '-';
  workspaceShell.textContent = '-';
  defaultModel.textContent = '-';
  providerList.replaceChildren(createTag('load-error'));
  toolList.replaceChildren(createTag('snapshot-missing'));
  sessionList.innerHTML = '';
  sessionList.append(createEmpty(`无法加载 ${stateUrl}: ${error.message}`));
  messageStream.innerHTML = '';
  messageStream.append(createEmpty('请先运行 octocode-cli ui-export ui-shell/data/app-state.json demo。'));
  terminalOutput.textContent = `load-error\n${error.message}`;
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

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

refreshButton.addEventListener('click', loadState);
loadState();
