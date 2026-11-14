# c-function-analyzer

コミットの書式、バージョン、タグ、CHANGELOG の規約（全プロジェクト共通）は、ここには書かない。このファイルは、このリポジトリ固有の事実だけを書く。

## 概要
C言語の関数にカーソルを置いて実行すると、その関数の入出力変数・内部変数・呼び出し関数の一覧を Webview に表示する VS Code 拡張機能。tree-sitter による構文解析（AST）を使う。

## 技術スタックと主要ディレクトリ
- TypeScript / VS Code 拡張機能 / web-tree-sitter。バンドルは esbuild（`dist/extension.js`）、型チェックは `tsc --noEmit`。
- `src/`: 本体（`analyzer.ts` 解析と分類、`definitionResolver.ts` 定義位置の解決、`macroRepair.ts`、`flowModel.ts`・`flowMermaid.ts` フローチャート、`webview*.ts` 画面 など）
- `test/`: `node:test` によるテスト、`samples/`・`test.c`: 動作確認用のサンプル
- `scripts/copy-wasm.js`: ビルド時に WASM をコピーする
- 詳細は [docs/architecture.md](docs/architecture.md)。出力先の `dist/`、`dist-test/` は Git 管理外。

## コマンド
```bash
npm install        # 依存関係のインストール（初回）
npm test           # 型チェック + テストのビルド + node:test
npm run typecheck  # 型チェックのみ
npm run compile    # ビルド（dist/extension.js を生成）
```
- lint: なし。
- テストは VS Code を起動せずに実行できる。テストファイルを追加したときは、`package.json` の `build-test` のファイル一覧にも追加する。
- ※ 自動対応でこれらを実行するには、dev-hub の `tools\claude-auto\config.ps1` の `$ExtraTools` で許可が必要。

## コーディング規約
- コメントは日本語。UI の文言・メッセージも日本語。
- 解析ロジックと Webview の HTML 生成は VS Code API に依存させず、テストできるようにする。
- 解析の振る舞いを変えたときは、`docs/spec.md` と、`docs/architecture.md` の「解析処理の詳細」を同じ作業で更新する。
- `CHANGELOG.md` の箇条書きは `*` で、文体は「です・ます」。

## バージョンの記録場所
リリースのときに、次をすべて同じコミットで更新する。
- `package.json` の `version`
- `package-lock.json` の `version`（先頭と `packages[""]` の2か所）
- `CHANGELOG.md` の見出し（`## [X.Y.Z] - YYYY-MM-DD`）

`README.md` には、現在のバージョンを書いていない（インストール手順の `X.Y.Z` は例示）。
**GitHub Releases を作るリポジトリ。** 手順は [docs/development.md](docs/development.md#リリース手順)。

## ドキュメント更新ルール
今後の開発で、次の変更を行う際は、同じ作業の中で該当ドキュメントも更新すること。
- 機能の追加・変更・削除 → `docs/spec.md`、`docs/usage.md`、`CHANGELOG.md`
- 構成や設計の変更 → `docs/architecture.md`
- 設定項目の追加・変更 → `docs/configuration.md`
- 技術選定や設計方針を変える判断 → 新しい ADR を `docs/adr/` に追加する（既存の ADR は書き換えず、ステータスを Superseded にして、新しい ADR から参照する）
- バージョンを上げるとき → `CHANGELOG.md` に新しいバージョンの節（`## [X.Y.Z] - YYYY-MM-DD`）を追加し、「バージョンの記録場所」のファイルをすべて同じコミットで更新する

## 注意事項
- `package.json` の `publisher` は `antigravity`。拡張機能 ID を変えると、インストール済みのものと別の拡張機能として扱われる。
- `.vscodeignore` で、`CLAUDE.md`、`docs/**`、`.github/**`、`src/**`、`test/**`、`samples/**` などの配布物に不要なファイルを除外している。
