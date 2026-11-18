# 開発者向けガイド

## 開発環境の構築

- Node.js と npm。GitHub Actions では Node 24 を使っている（`node --test` のグロブ指定を使うため、v22 以降が必要）。
- 依存関係を取得する。

```bash
npm install
```

## ビルド

```bash
npm run compile    # dist/extension.js を生成（WASM のコピーと esbuild）
npm run watch      # 変更を監視して自動ビルド
```

vsix は GitHub Actions が作る（下記「リリース手順」）。手元で作る場合は `npx --yes @vscode/vsce package`（ワークフローと同じコマンド）。

## テスト

```bash
npm test           # 型チェック + テストのビルド（dist-test/）+ node:test
npm run typecheck  # 型チェックのみ
```

- テストは Node 標準の `node:test` で書いており、追加のパッケージは不要。
- 解析ロジックは VS Code API に依存しない構成のため、拡張機能を起動せずに検証できる。
- テストファイルを追加したときは、`package.json` の `build-test` のファイル一覧にも追加する。

## lint / フォーマット

なし。

## ブランチ運用とコミット

全プロジェクト共通の Git 運用ルールに従う。このリポジトリ固有の事情はない。

## リリース手順

1. 更新するファイルは、[CLAUDE.md](../CLAUDE.md) の「バージョンの記録場所」を参照する。
2. `v` で始まるタグを push すると、GitHub Actions（`.github/workflows/release.yml`）が次を行う。
   1. `npm ci`
   2. タグと `package.json` のバージョンが一致することを確認する
   3. テストを実行する（失敗した場合はリリースしない）
   4. `npx --yes @vscode/vsce package` で vsix を作り、GitHub Releases に添付する（説明文は空。変更内容は CHANGELOG を参照。既にリリースがある場合は vsix の差し替えのみ）
3. 過去のタグをリリースする場合は、GitHub の Actions → release → Run workflow でタグを指定する。
