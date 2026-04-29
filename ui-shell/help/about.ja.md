# Octocode について

Octocode はオープンソースのローカル・コーディング・エージェントです。
Rust ランタイム、シングルページの WebUI、デスクトップシェルから構成
され、ユーザーが選択した LLM プロバイダー（Anthropic, OpenAI, Gemini,
xAI, OpenRouter, GLM, Kimi, Qwen, MiniMax, NVIDIA, Xiaomi、または
OpenAI 互換のローカルサーバー）との対話を仲介します。本プロジェクトは
**Apache License, Version 2.0** の下で配布されています。

- バージョン: **2026.4.29**
- リポジトリ: <https://github.com/sievepub-2000/octocode>
- ライセンス: Apache 2.0（全文は Help → License）
- 既定言語: 英語。View → Language から 日本語 / 한국어 / 中文 に切替
  可能。

## アーキテクチャ概要

`octocode-core` は安定したドメイン型を所有します。`octocode-api` は
プロバイダーの通信仕様を所有します。`octocode-runtime` はセッション・
権限・ルーティングを統括します。`octocode-cli` は WebUI HTTP サーバー
と CLI を起動します。ブラウザシェルおよびデスクトップシェルは
ランタイムのイベントとスナップショットのみを消費します。

モジュールの詳細リファレンス:

- [`docs/modules/index.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/index.md)
  （入口、EN + JA リンク）
- [`docs/modules/octocode-modules.en.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/octocode-modules.en.md)
  （英語の統合リファレンス）
- [`docs/modules/octocode-modules.ja.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/octocode-modules.ja.md)
  （日本語の統合リファレンス）

## 謝辞（サードパーティプロジェクト）

Octocode は以下の上流プロジェクトに支えられています。著者・維持者・
コントリビューターの皆さまに感謝いたします。

**ブラウザ / WebUI**: marked (MIT) · highlight.js (BSD-3-Clause) ·
KaTeX (MIT) · IBM Plex Mono (SIL OFL 1.1) · Zen Kaku Gothic New
(SIL OFL 1.1)

**Rust ランタイム**: tokio · reqwest · serde · serde_json · axum ·
clap · anyhow · thiserror · tracing · tracing-subscriber · rusqlite ·
tokio-stream · futures

**プロバイダープロトコル**（公開 API として利用、商標は各社所有）:
Anthropic Claude · OpenAI / Azure OpenAI · Google Gemini · xAI Grok ·
OpenRouter · Zhipu GLM · Moonshot Kimi · Alibaba Qwen · MiniMax ·
NVIDIA build · Xiaomi MiAI

**メソッドスキル**（`skills/` 配下の指示オーバーレイ）: spec-kit ·
vibecoding-guide · get-shit-down · autoresearch · agent-customization ·
agent-skills · find-skill · canvas-design · naive-ui · pentagi ·
penpot · andrej-karpathy-skills ほか — 各フォルダの `SKILL.md` に
上流クレジットを記載。

サードパーティの全一覧およびライセンスは
[`docs/THIRD_PARTY_NOTICES.md`](https://github.com/sievepub-2000/octocode/blob/master/docs/THIRD_PARTY_NOTICES.md)
にて管理しています。

## ドキュメント

| 項目 | リンク |
| --- | --- |
| モジュールリファレンス | [docs/modules/index.md](https://github.com/sievepub-2000/octocode/blob/master/docs/modules/index.md) |
| リリースノート | [docs/release-notes-2026-04-29.md](https://github.com/sievepub-2000/octocode/blob/master/docs/release-notes-2026-04-29.md) |
| プライバシー方針 | [docs/PRIVACY.md](https://github.com/sievepub-2000/octocode/blob/master/docs/PRIVACY.md) |
| コントリビュート | [CONTRIBUTING.md](https://github.com/sievepub-2000/octocode/blob/master/CONTRIBUTING.md) |
| セキュリティポリシー | [SECURITY.md](https://github.com/sievepub-2000/octocode/blob/master/SECURITY.md) |
| 行動規範 | [CODE_OF_CONDUCT.md](https://github.com/sievepub-2000/octocode/blob/master/CODE_OF_CONDUCT.md) |
| アーキテクチャ | [docs/architecture.md](https://github.com/sievepub-2000/octocode/blob/master/docs/architecture.md) |

## 作者へ連絡

`sievepub@outlook.com` · `3925447879@qq.com` または Issue Tracker
へ。詳細は Help → 作者へ連絡。
