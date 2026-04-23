# vscode-octocode

Minimal VS Code extension that embeds the Octocode Workbench inside the editor.

## Features

- **Octocode: Open Workbench** — opens a webview pointing at your Octocode server (`octocode.serverUrl`, default `http://127.0.0.1:8899`).
- **Octocode: Start Local Server** — spawns `octocode-cli serve --port <octocode.port>` in the workspace folder.

## Configuration

| key | default | purpose |
|---|---|---|
| `octocode.serverUrl` | `http://127.0.0.1:8899` | URL loaded inside the webview iframe |
| `octocode.cliPath` | `octocode-cli` | Path to the Octocode CLI binary |
| `octocode.port` | `8899` | Port used when starting the local server |

## Build

```powershell
cd extensions/vscode-octocode
npm install
npm run compile
```

Then press F5 inside this folder to launch an Extension Development Host.

## Status

MVP scaffold (P2-A). No marketplace publish; local `.vsix` packaging is left as a follow-up.
