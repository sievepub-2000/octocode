# リリースノート — Octocode v2026.4.29

リリース日: 2026-04-29
ライセンス: Apache License 2.0
リポジトリ: https://github.com/sievepub-2000/octocode

## 概要

Octocode v2026.4.29 は、Apache License Version 2.0 のもとで初めて公開
配布されるビルドです。2026-04-24 から 2026-04-29 にかけて行われた
ランタイム・プロバイダー・WebUI の改善をリリース品質のスナップショット
としてまとめています。

このリリースは Windows / macOS / Linux 上で GitHub のソースツリーから
インストール・実行・検証可能であることを目標としています。

## ハイライト

### ランタイム

- ターン単位の `session.model` 解決: 各会話は、別箇所で既定モデルを
  切り替えても、セッションに記録された厳密なモデルを保持します。
- 新フィールド `stub_fallback_active` をランタイムスナップショットに
  追加し、すべてのプロバイダーが失敗してローカルスタブが応答エコーを
  返している状態を WebUI が明確に表示できるようにしました。CLI と
  Canvas シェルも同フラグを利用します。
- ワンキーで起動・停止できるスクリプト
  （`scripts/octocode-up.ps1` / `scripts/octocode-down.ps1`）。
  起動前にゾンビ化した `octocode-cli` および `msedge` デバッグ
  プロセスを掃除します。

### プロバイダー

- Anthropic 転送が `ANTHROPIC_AUTH_TOKEN` を 3 番目のフォールバックと
  して読み込むようになりました（順序: `ANTHROPIC_API_KEY` →
  `OCTOCODE_ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN`）。Claude
  Code / claw-code 系の利用者は auth-token 形式のみを設定し、独自の
  `ANTHROPIC_BASE_URL` を併用するケースが多く、従来はこれらの
  ゲートウェイへ接続できませんでしたが、本リリースで対応しました。
- Anthropic リクエストは同一呼び出しで `x-api-key` と
  `Authorization: Bearer` の両方を送付します。本家 Anthropic は
  `Authorization` を無視しますが、`ai.jiexi6.cn` などのサードパーティ
  プロキシは Bearer 形式を必須とするためです。

### WebUI

- LaTeX/KaTeX 数式描画。`$...$`、`$$...$$`、`\(...\)`、`\[...\]` を
  含む応答が適切な数式として描画されます。コードフェンスはそのまま
  維持されます。
- ローカライズされたヘルプメニュー: License、Release Notes、Privacy
  Statement、Check for Updates、Contact Us、About。各エントリは右
  パネルに完全な内容を表示します。
- Help → Check for Updates が GitHub Releases API へ実際に問い合わせ、
  実行中ビルドが最新かどうかを報告するようになりました。
- Help → Contact Us が公式メールアドレス（`sievepub@outlook.com`）と公開リポジトリ URL を表示します。
- 既定 UI 言語は英語です。日本語・韓国語・中国語（簡体）も完全に
  サポートされ、View → Language から実行時に切替可能です。

### ドキュメント

- `LICENSE`（Apache 2.0）と `NOTICE` をリポジトリのルートに追加。
- `docs/PRIVACY.md`、`docs/release-notes-2026-04-29.md`、
  `docs/THIRD_PARTY_NOTICES.md`、`docs/modules/index.md`、および
  英語＋日本語のモジュール別ガイドを追加。
- `CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md` をリポジトリ
  ルートに追加。`.github/` に Issue / PR テンプレートを配置。

## 既知の制限

- `ai.jiexi6.cn` プロキシ経由のスループットは上流チェーンに律速され、
  実測で約 4 トークン/秒です。Octocode のボトルネックではありません。
- `scripts/package-*` の各デスクトップインストーラスクリプトは、本
  リリースでは Windows のみアクティブに検証済みです。

## 更新方法

旧開発ビルドで稼働中の場合は、アップグレード前に WebUI を停止して
ください:

```powershell
.\scripts\octocode-down.ps1 -All
git pull
cargo build --release -p octocode-cli
.\scripts\octocode-up.ps1 -Port 999 -SessionId main -NoBuild
```

## ライセンス

Octocode は Apache License Version 2.0 のもとで配布されます。全文は
リポジトリのルート `LICENSE` に同梱されており、WebUI 内では
Help → License から閲覧できます。
