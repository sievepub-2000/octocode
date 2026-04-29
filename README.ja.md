# Octocode（日本語）

[![CI](https://github.com/sievepub-2000/octocode/actions/workflows/ci.yml/badge.svg)](https://github.com/sievepub-2000/octocode/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Latest release](https://img.shields.io/github/v/release/sievepub-2000/octocode?label=release)](https://github.com/sievepub-2000/octocode/releases)
[![Rust](https://img.shields.io/badge/rust-stable-orange.svg)](https://www.rust-lang.org)

> **マルチエージェント対応のオープンソース・プログラミング & タスク実行ツールキット**

🇬🇧 English version → [README.md](README.md)

## 概要

Octocode は **Rust ワークスペース（10 crate）** として実装された、
ローカルファースト・マルチプロバイダ対応の AI コーディングアシスタント
ランタイムです。同一バックエンドで以下のフロントエンドを提供します。

- `octocode-cli` — ターミナル CLI（チャット・ツール実行・セッション管理）
- ゼロビルドの **WebUI**（バニラ JS、`127.0.0.1` バインド）
- `wry` ベースのデスクトップシェル（Windows: WebView2 / macOS・Linux: WebKit）

## 主な特徴

- **権限を意識したランタイム** — `read-only` / `workspace-write` / `escalated`
  の 3 段階。シェル・ファイル書き込みは承認ゲート付き。
- **プラガブルなプロバイダルーティング** — OpenAI, Gemini, DeepSeek,
  Tongyi Qwen, Moonshot Kimi, Zhipu GLM, Xiaomi MiMo, Ollama,
  および任意の OpenAI 互換ゲートウェイ。
- **組み込みツールカタログ** — シェル実行 / Web 取得 / ファイル
  読み書き / スキル登録 / メモリ参照 / MCP 連携。
- **セッション永続化** — 会話・ツール呼出履歴を SQLite に保存し、
  `resume` で完全復元。
- **可観測性** — Prometheus 形式の `/metrics` と JSON 形式の
  `/api/metrics`。
- **セキュリティ** — Bearer トークン認証、127.0.0.1 限定バインド、
  CSP/X-Frame-Options/Referrer-Policy 等を全レスポンスに付与。
  ワークスペーストークンは 256bit `getrandom`。

## クイックスタート

```bash
# 1. ワークスペースをビルド
cargo build --release -p octocode-cli

# 2. 初回チャット
cargo run -p octocode-cli -- chat demo "このプロジェクトの概要を説明してください"

# 3. WebUI を起動
cargo run -p octocode-cli -- serve 999 demo
# → ブラウザで http://127.0.0.1:999/ui-shell/?session=demo を開く

# 4. デスクトップアプリとして起動
cargo run -p octocode-cli -- desktop 999 demo
```

WebUI/デスクトップ用ポートは `990–999` の範囲に制限されています。

## ワンライン・インストール

**Windows (PowerShell 5.1+ / 7+):**

```powershell
iex (iwr -UseBasicParsing https://raw.githubusercontent.com/sievepub-2000/octocode/master/install.ps1).Content
```

**macOS / Linux (bash / zsh):**

```bash
curl -fsSL https://raw.githubusercontent.com/sievepub-2000/octocode/master/install.sh | bash
```

**Cargo がインストール済みの環境で直接:**

```bash
cargo install --git https://github.com/sievepub-2000/octocode \
  --tag v2026.4.30 --locked octocode-cli
```

インストール後の確認:

```bash
octocode-cli doctor                 # 環境診断
octocode-cli serve 999 demo         # WebUI 起動
octocode-cli chat demo "hello"      # CLI ワンショット
```

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────────────┐
│                     octocode-cli                        │
│         （CLI ・ サーバ ・ デスクトップ）                │
├──────────┬──────────────┬──────────────┬────────────────┤
│ commands │   runtime    │     api      │    plugins     │
│ （構文   │ （セッション、│ （プロバイダ、│ （プラグイン     │
│   解析） │   ツール、   │   サーキット │   トレイト）    │
│          │   権限制御） │   ブレーカ） │                │
├──────────┴──────┬───────┴──────────────┴────────────────┤
│      core       │        mcp       │      skills       │
│ （ドメイン型、 │ （MCP 検出 ・ │ （スキル定義、    │
│   契約）        │   トランスポート）│   フレームワーク） │
└─────────────────┴──────────────────┴───────────────────┘
```

**10 crate**：`core` → `api` / `mcp` / `skills` → `runtime` → `commands`
→ `cli`、加えて `gateway` / `mock-provider` / `plugins`。

詳細は [docs/architecture.ja.md](docs/architecture.ja.md) を参照してください。

## ライセンス

Apache License 2.0 — [LICENSE](LICENSE) を参照してください。

## コントリビュート

[CONTRIBUTING.md](CONTRIBUTING.md)（Conventional Commits 採用）と
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) をご確認ください。
セキュリティ報告は [SECURITY.md](SECURITY.md) を参照してください。
