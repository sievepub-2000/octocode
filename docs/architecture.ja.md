# Octocode アーキテクチャ

> **対象**: Octocode を拡張する前にランタイム階層を理解する必要のある
> コントリビュータと統合担当者。

## 全体像

```
+-----------------------------------------------------------------+
|                        Shell（消費者）                          |
|  CLI         WebUI（HTML/JS）       デスクトップ（tao+wry）     |
|  └─ stdout   └─ /api/state, SSE     └─ WebUI を埋め込む         |
+-----------------------------------------------------------------+
                |              ^
                v              |
+-----------------------------------------------------------------+
|                       octocode-cli                              |
|   * argv 解析、出力レンダラー、ポート制限付きサーバー           |
|   * 内蔵: HTTP API + SSE イベント + デスクトップ起動            |
+-----------------------------------------------------------------+
                |              ^
                v              |
+-----------------------------------------------------------------+
|                  octocode-runtime（16k LOC）                    |
|   * SessionStore（SQLite、追記専用ターン）                      |
|   * PermissionPolicy（read-only / workspace-write + 拒否ツール）|
|   * RuntimeProviderRouter（並列 /health、重複排除）             |
|   * ツールレジストリ（81 個の組み込み）+ skills + コマンド（29）|
|   * プラットフォームシェル（Windows: PS7 → PS5.1 → cmd）        |
+-----------------------------------------------------------------+
                |              ^
                v              |
+-----------------------------------------------------------------+
|     octocode-api                       octocode-mcp             |
|     * 17 プロバイダ                    * MCP クライアント + SSE |
|     * BuiltinProvider enum:            * fork / transport ブリッジ |
|       Stub | OpenAiCompatible |                                 |
|       Anthropic | Fallback                                      |
+-----------------------------------------------------------------+
                |
                v
+-----------------------------------------------------------------+
|                     octocode-core                               |
|   安定した契約のみ:                                             |
|   trait ModelProvider { health(); send(); ... }                 |
|   ProviderHealth, ProviderCircuitState, ProviderDescriptor      |
|   ToolCatalog, PermissionPolicy, SessionId, WorkspaceId         |
+-----------------------------------------------------------------+
```

補助 crate:

| Crate                    | 役割                                    |
|---|---|
| `octocode-commands`      | 29 個の組み込みスラッシュコマンド        |
| `octocode-skills`        | ローカル skills インデックス             |
| `octocode-plugins`       | 動的プラグインローダー + サンドボックス  |
| `octocode-gateway`       | LB / パススルー HTTP ゲートウェイ        |
| `octocode-mock-provider` | テスト用の決定論的スタブ                 |

## 不変条件（インバリアント）

1. **階層化**: `core` ← `api` ← `runtime` ← `cli`。Shell（CLI / WebUI /
   デスクトップ / 外部 IDE ブリッジ）はランタイムスナップショットと
   SSE イベントフィードのみを消費し、ビジネスルールを再実装しない。
2. **唯一の真実**: ランタイムは `UiSnapshot`（sessions, providers,
   providerHealths, eventFeed など）を発行し、Shell はそれをレンダリ
   ングする。ローカルの可変状態に依存しない。
3. **プロバイダルーティング**:
   - `BuiltinProvider::Fallback` は `health()` で **親** descriptor id
     を返す。内部候補の identity は `health_catalog()`（内部利用）
     および detail 文字列の `via <inner>:` プレフィックスで露出する。
   - ルーターは `thread::scope` で全トップレベルプロバイダを並列に
     プローブし、リモート端点への過剰アクセスを防ぐため 15 秒の
     キャッシュを持つ。
4. **権限モデル**: 2 モード（`read-only`, `workspace-write`）と
   ツールごとの拒否リスト。shell-command や書き込み系ツールは必ず
   `PermissionPolicy::evaluate` を経由する。
5. **Windows 優先検証**: PowerShell 7 → Windows PowerShell 5.1 → `cmd`
   の順で探す。`\\?\` 長パス、`OneDrive\Documents` リダイレクト、
   非 ASCII プロファイル名を扱う。
6. **ローカルファースト transport**: WebUI HTTP サーバは `127.0.0.1`
   のみにバインドし、ポート範囲は `990–999`、`window.__OCTOCODE_AUTH_TOKEN__`
   経由でプロセスごとの bearer トークンを `index.html` に注入する。

## プロバイダ一覧（17）

`anthropic`, `local-openai`, `remote-openai`, `ollama`, `linkmind`,
`gemini`, `azure-openai`, `nvidia-free`, `xai`, `openrouter`, `qwen`,
`glm`, `kimi`, `xiaomi`, `minimax`, `openai-completion`, `stub`.

## ツール分類（81）

ファイルシステム · shell-command · http(s) · workspace 検索 · session ·
provider 制御 · permission · skills · MCP ブリッジ · エージェント制御。

## 永続化された状態

| パス（Windows: `%APPDATA%\octocode\` / POSIX: `~/.config/octocode/`） | 用途 |
|---|---|
| `octocode.conf`     | マシンごとの設定（provider id、既定モデル、権限モード） |
| `sessions.sqlite`   | 追記専用 session/turn ストア                  |
| `skills/`           | ユーザー作成の skill                          |
| `logs/`             | 回転式 CLI ログ                               |

ランタイムは、ツール経由でオペレータが明示的に書き込まない限り、
ワークスペースツリー内に何も永続化しない。

## 新しいプロバイダの追加（チートシート）

1. `crates/octocode-api/src/lib.rs::descriptors` に descriptor を追加。
2. `ModelProvider` を実装する（冗長化が必要なら `Fallback` で合成）。
3. `create_by_id_with_config` に組み込む。
4. ランタイムの smoke test を追加（`cargo test -p octocode-runtime`）。
5. `docs/modules/octocode-modules.{en,ja}.md` を更新。

これだけ。WebUI 設定 → Providers パネルは新しい descriptor を自動描画する。
