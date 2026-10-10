# c-function-analyzer

共通ルール（コミットの書式、バージョン、タグ、CHANGELOG）は、ここには書きません。このファイルは、このリポジトリ固有の事実だけを書きます。

## 概要
C言語の関数にカーソルを置いて実行すると、入出力変数・内部変数・呼び出し関数の一覧を Webview で表示する VS Code 拡張機能です。tree-sitter による構文解析（AST）を使います。

## 構成と技術
- TypeScript / VS Code 拡張機能 / web-tree-sitter。ビルドは esbuild。
- `src/`: 拡張機能の本体と解析ロジック
- `test/`: Node 標準の `node:test` によるテスト（`test/support/` は共通の補助）
- `scripts/copy-wasm.js`: ビルド時に WASM をコピーする
- `samples/`、`test.c`: 動作確認用のサンプル
- `docs/analysis_spec.md`: 解析ロジックの仕様書
- 出力先の `dist/`、`dist-test/` は Git 管理外

## ビルド・テストの手順
```bash
npm install        # 依存関係のインストール（初回）
npm test           # 型チェック + テストのビルド + node:test
npm run compile    # ビルド（dist/extension.js を生成）
```
- テストは VS Code を起動せずに実行できます。
- テストファイルを追加したときは、`package.json` の `build-test` のファイル一覧にも追加します。
- ※ 自動対応でこれらを実行するには、dev-hub の `tools\claude-auto\config.ps1` の `$ExtraTools` で許可が必要です。

## バージョンの記録場所
リリースのときに、次をすべて同じコミットで更新します。
- `package.json` の `version`
- `package-lock.json` の `version`（先頭と `packages[""]` の2か所）
- `CHANGELOG.md` の見出し（`## [X.Y.Z] - YYYY-MM-DD`）

`README.md` には、現在のバージョンを書いていません。

## 注意事項
- **GitHub Releases を作るリポジトリです。** `v` で始まるタグを push すると、`.github/workflows/release.yml` が、テストの実行、タグと `package.json` のバージョンの一致確認、vsix の作成、Releases への添付を行います。バージョンが一致しないと、リリースは失敗します。
- `CHANGELOG.md` の箇条書きは `*` で、文体は「です・ます」です。
