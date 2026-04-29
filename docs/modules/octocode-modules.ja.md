# Octocode モジュールリファレンス（日本語）

本書は Octocode ワークスペース内の全モジュールについて、所有範囲・
非所有範囲・動作確認手順を一括でまとめた参照資料です。パスはすべて
リポジトリのルートからの相対表記です。

## レイヤリング

Octocode は厳密な単方向の依存グラフを採用しています。下位レイヤは上位
レイヤを取り込みません。これは `Cargo.toml` のメンバー構成と
`CLAUDE.md` のレイヤリング規則によって維持されます。

```
octocode-core   ── 安定したドメイン型／契約／ケイパビリティ表面
   ▲
octocode-api    ── プロバイダー通信仕様（HTTP・認証・ストリーム）
   ▲
octocode-runtime── セッション・権限・ルーティングの統括
   ▲
octocode-cli    ── 引数解析・レンダラー・WebUI 起動
   ▲
ui-shell, デスクトップ, VS Code, Cline, Cursor — ランタイムの
                                                  イベントとスナップショットのみ消費
```

---

## クレート: `octocode-core`

パス: `crates/octocode-core`

**安定したドメイン型と契約**を所有します:

- プロバイダーケイパビリティ表面とプロバイダーファクトリ契約
- 権限ポリシー契約（`read-only` / `workspace-write` /
  `danger-full-access`）
- ツールカタログ契約
- セッション・ワークスペース・メッセージ型
- `/api/state` で公開する `UiSnapshot` 構造体（v2026.4.29 で追加された
  `stub_fallback_active` フィールドを含む）

**所有しない**もの: HTTP、ファイル IO、プロバイダー固有のペイロード形式、
権限の実行強制。

ビルド: `cargo check -p octocode-core`

---

## クレート: `octocode-api`

パス: `crates/octocode-api`

**プロバイダーの通信仕様**を所有します。ベース URL の解決、認証
ヘッダー組み立て、リクエストペイロード生成、SSE ストリーム解析、
サーキットを意識したアダプタ合成までを含みます。プロバイダーごとに
1 モジュール（`anthropic`, `openai`, `gemini`, `xai`, `openrouter`,
`glm`, `kimi`, `qwen`, `minimax`, `nvidia`, `xiaomi`）が存在します。

Anthropic アダプタ（v2026.4.29 以降）は次の順でキーを読み取ります:

1. `ANTHROPIC_API_KEY`
2. `OCTOCODE_ANTHROPIC_API_KEY`
3. `ANTHROPIC_AUTH_TOKEN`

サードパーティゲートウェイとの互換性を最大化するため、
`x-api-key` と `Authorization: Bearer` の両方を同一リクエストに付与
します。

**所有しない**もの: セッション保存、権限実行、デフォルトモデルの選択。

確認: `cargo check -p octocode-api`

---

## クレート: `octocode-runtime`

パス: `crates/octocode-runtime`

オーケストレーション層を所有します:

- セッション永続化（`rusqlite`、Windows 既定パスは
  `%APPDATA%\octocode\sessions.db`）
- ツール境界での権限実行
- プロバイダールーティング: 設定済みプロバイダーを選択し、すべての
  プロバイダーが不健全な場合はローカルスタブにフォールバックし、その
  状態を `UiSnapshot.stub_fallback_active` で公開
- ツールレジストリの利用（レジストリ自体は `octocode-core`）
- 設定パスの確定: `config.json` の所在解決と読み書き
- プラットフォームシェル実行: Windows では PowerShell 7 → Windows
  PowerShell 5.1 → `cmd` の順、macOS / Linux では `bash` / `zsh`

**所有しない**もの: HTTP 転送、CLI 解析、UI 描画。

確認: `cargo check -p octocode-runtime`

---

## クレート: `octocode-cli`

パス: `crates/octocode-cli`

CLI のエントリポイントと WebUI HTTP サーバーの起動を所有します:

- `octocode-cli serve <port> <session>` — 指定ポート・既定セッション ID
  で WebUI を起動
- `octocode-cli chat`, `octocode-cli ask`, `octocode-cli doctor`,
  および `manage` 系サブコマンド
- `ui-shell/` および `help/` の静的アセット配信
- `clap` による引数解析
- コンソールレンダラー（Markdown / JSON / プレーン）

**所有しない**もの: プロバイダー挙動、セッション保存、ツール実行。

クイックスタート:

```powershell
$env:CARGO_HOME='C:\Users\<ユーザー>\vscode-workspace\.cargo'
$env:PATH = "C:\Users\<ユーザー>\vscode-workspace\.cargo\bin;$env:PATH"
.\scripts\octocode-up.ps1 -Port 999 -SessionId main
# WebUI: http://127.0.0.1:999/ui-shell/?session=main
```

---

## クレート: `octocode-commands`

パス: `crates/octocode-commands`

WebUI コンポーザと CLI チャットで利用するスラッシュコマンド
カタログを所有します。各コマンドは小さな宣言エントリ（名前・スコープ・
必要権限・ヘルプ・展開テンプレート）です。

`commands.toml`（または同等の JSON カタログ）に追記するだけで追加
できます。新しいツールが必要な場合のみランタイム変更が要ります。

---

## クレート: `octocode-mcp`

パス: `crates/octocode-mcp`

Model Context Protocol ブリッジを所有します。ワークスペースおよび
ユーザー設定で宣言された MCP サーバーを発見し、トランスポート（stdio
／streamable-http）をネゴシエートしてランタイムのツールレジストリと
WebUI の Manage → MCP パネルに公開します。

---

## クレート: `octocode-skills`

パス: `crates/octocode-skills`

スキルカタログを所有します。`skills/` 配下の `SKILL.md` を発見し、
フロントマターを検証し、ランタイムへ公開してセッション開始時に
プロンプトを補強します。スキルは**指示オーバーレイ**であり、
実行可能プラグインではありません。

---

## クレート: `octocode-plugins`

パス: `crates/octocode-plugins`

外部ツールがコア改変なしにランタイムのツールレジストリへ登録できる
オプションのプラグインローダーを所有します。プラグイン契約は
`octocode-core` が公開する `tool catalog contract` と同じです。

---

## クレート: `octocode-gateway`

パス: `crates/octocode-gateway`

Octocode を単一エンドポイント（小規模チームの共有開発機など）で
ホスティングするためのオプションのリバースプロキシ／ファンアウト
ゲートウェイを所有します。単機利用には**不要**で、既定で無効です。

---

## クレート: `octocode-mock-provider`

パス: `crates/octocode-mock-provider`

ランタイムのスタブフォールバックと統合テストで使用する、オフラインで
決定論的なプロバイダーを所有します。すべての実プロバイダーが不健全な
ときは、このクレートを通してセッションを処理し、UI が動作し続けると
同時に明示ラベル付きのスタブエコーをユーザーへ返します
（`UiSnapshot.stub_fallback_active` を参照）。

---

## サーフェス: WebUI シェル（`ui-shell/`）

純粋なブラウザ側コードです。HTTP 経由でランタイムを利用する単一ページの
バニラ JavaScript です:

- `GET /api/state?session=<id>` — 完全なスナップショット
  （`stub_fallback_active`、`providerHealths` を含む）
- `POST /api/chat` — 非ストリーム送信
- `GET /api/stream?session=<id>&text=<urlencoded>`（複数台運用時は
  Bearer 認証）— SSE トークンストリーム
- `POST /api/settings` — プロバイダー、ベース URL、既定モデル、
  権限、履歴制限
- `GET /api/manage/catalog` — プロバイダー、モデル、MCP、スキル、
  フック、ツール、コマンド

Markdown は `marked` 12、コードハイライトは `highlight.js` 11、数式は
`KaTeX` 0.16（`$...$` / `$$...$$`）でレンダリングします。既定ロケールは
**英語**で、`View → Language` から `ja-JP` / `ko-KR` / `zh-CN` に
即時切り替え可能です。

ヘルプメニューは右パネルの専用セクションへ導線します:

- License — Apache License 2.0 の全文
- Release Notes — `docs/release-notes-2026-04-29.md`
- Privacy Statement — `docs/PRIVACY.md`
- Check for Updates — `sievepub-2000/octocode` の GitHub Releases API
- Contact Author — `sievepub@outlook.com`、`3925447879@qq.com`
- About — モジュール一覧、サードパーティ謝辞、`docs/modules/index.md`
  へのリンク

---

## サーフェス: デスクトップパッケージング

スクリプト: `scripts/package-desktop.ps1`,
`scripts/package-desktop.sh`, `scripts/package-windows-installer.ps1`,
`scripts/package-linux-installer.sh`,
`scripts/package-macos-installer.sh`。

各スクリプトは `cargo build --release -p octocode-cli` をラップし、
`ui-shell/` と `help/` をバイナリの隣にコピーしてプラットフォーム
成果物を生成します。本リリースでは Windows パスのみアクティブに
検証済みです。

---

## 運用: クイックスタート

```powershell
git clone https://github.com/sievepub-2000/octocode.git
cd octocode
$env:CARGO_HOME='C:\Users\<ユーザー>\vscode-workspace\.cargo'
$env:PATH="C:\Users\<ユーザー>\vscode-workspace\.cargo\bin;$env:PATH"
cargo build --release -p octocode-cli
.\scripts\octocode-up.ps1 -Port 999 -SessionId main -NoBuild
# http://127.0.0.1:999/ui-shell/?session=main を開く
```

停止:

```powershell
.\scripts\octocode-down.ps1 -All
```

## 運用: プロバイダー設定

プロバイダー ID・ベース URL・既定モデル・権限モード・履歴制限は
Manage → Settings、もしくは `POST /api/settings` で設定します。代表的な
プロバイダー ID:

| プロバイダー ID | 既定ベース URL | 備考 |
| --- | --- | --- |
| `anthropic` | `https://api.anthropic.com/` | `ANTHROPIC_BASE_URL` で上書き |
| `openai` | `https://api.openai.com/v1/` | `OPENAI_BASE_URL` で上書き |
| `gemini` | `https://generativelanguage.googleapis.com/` | |
| `openrouter` | `https://openrouter.ai/api/v1/` | |
| `local-openai` | ユーザー指定 | OpenAI 互換のローカルサーバー |
| `stub` | （なし） | オフラインエコー |

## 運用: 権限とサンドボックス

`read-only` はワークスペースを変更するすべてのツールをブロックします。
`workspace-write` は設定済みワークスペースルート配下のファイル変更のみ
許可します。`danger-full-access` は任意のシェルコマンドを許可し、
ローカル信頼コンテキストでの利用を想定します。

選択モードは `octocode-runtime` 内のツール境界で実行強制されます。
CLI 引数と `/api/settings` のみが信頼源です。

## 運用: トラブルシューティング

| 症状 | 想定原因 | 対処 |
| --- | --- | --- |
| WebUI にスタブフォールバック警告が出る | 全プロバイダー不健全 | API キー・ベース URL と `/api/events` を確認 |
| Windows で `cargo build` が `os error 5` で失敗 | 旧 WebUI が `octocode-cli.exe` を保持 | `.\scripts\octocode-down.ps1 -All` 後に再ビルド |
| サードパーティゲートウェイで Anthropic が 401 | ゲートウェイが `Authorization: Bearer` を要求 | v2026.4.29 は両ヘッダーを送付。古ければ更新 |
| 数式が `$...$` のまま表示される | 旧 WebUI（KaTeX 未搭載） | ハードリロード。v2026.4.29 から同梱 |
