import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';

let serverProc: ChildProcess | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('octocode.open', () => openWorkbench(context)),
    vscode.commands.registerCommand('octocode.startServer', () => startServer(context)),
  );

  context.subscriptions.push({
    dispose: () => {
      if (serverProc && !serverProc.killed) {
        serverProc.kill();
      }
    },
  });
}

export function deactivate(): void {
  if (serverProc && !serverProc.killed) {
    serverProc.kill();
  }
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('octocode');
  return {
    serverUrl: cfg.get<string>('serverUrl', 'http://127.0.0.1:8899'),
    cliPath: cfg.get<string>('cliPath', 'octocode-cli'),
    port: cfg.get<number>('port', 8899),
  };
}

function openWorkbench(context: vscode.ExtensionContext): void {
  const { serverUrl } = getConfig();
  const panel = vscode.window.createWebviewPanel(
    'octocodeWorkbench',
    'Octocode Workbench',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  panel.webview.html = renderWebviewHtml(serverUrl);
}

function renderWebviewHtml(serverUrl: string): string {
  // Minimal host page that embeds the running Octocode server via iframe.
  // Sandbox is wide-open within VS Code webview; users can disable the
  // extension if they prefer an external browser.
  const safeUrl = serverUrl.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' ${safeUrl}; frame-src ${safeUrl}; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>Octocode</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #111; color: #ccc; font-family: system-ui; }
    iframe { border: 0; width: 100vw; height: 100vh; }
    .msg { padding: 2em; }
    .msg a { color: #8cf; }
  </style>
</head>
<body>
  <iframe src="${safeUrl}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
  if (serverProc && !serverProc.killed) {
    vscode.window.showInformationMessage('Octocode server already running.');
    return;
  }
  const { cliPath, port } = getConfig();
  const out = vscode.window.createOutputChannel('Octocode');
  out.show(true);
  out.appendLine(`[octocode] starting: ${cliPath} serve --port ${port}`);

  try {
    serverProc = spawn(cliPath, ['serve', '--port', String(port)], {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env: process.env,
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to start octocode-cli: ${(err as Error).message}`);
    return;
  }

  serverProc.stdout?.on('data', (d) => out.append(d.toString()));
  serverProc.stderr?.on('data', (d) => out.append(d.toString()));
  serverProc.on('exit', (code, signal) => {
    out.appendLine(`[octocode] server exited (code=${code}, signal=${signal})`);
    serverProc = undefined;
  });

  vscode.window.showInformationMessage(`Octocode server starting on port ${port}.`);
}
