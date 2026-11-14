# C Function Analyzer

C言語の関数にカーソルを置いて実行すると、その関数の入出力変数・内部変数・呼び出し関数の一覧を Webview に表示する VS Code 拡張機能。

## 概要

関数がどの変数を読み、どの変数に書き込み、どの関数を呼んでいるかを、一覧で把握するためのもの。
正規表現ではなく tree-sitter による構文解析（AST）を使うため、多重ポインタ・多次元配列・構造体メンバ・関数ポインタといった記述も判別する。
型名・コメント・定義値は、VS Code の定義プロバイダ（F12 と同じもの）で見つけた定義位置から読み取る。

## 主な機能

- 入力変数・出力変数・内部変数・呼び出し関数・マクロへの分類（引数へのアドレス渡しの検出を含む）
- 定義位置からの型名・コメント・定義値の表示と、「定義へ」ボタン
- 定義へのジャンプがうまくいかない原因の診断
- 関数の構造の、Mermaid 記法のフローチャートとしての出力
- エディタ上のハイライトと、変数名のコピー（表計算ソフト向けの形式あり）

## クイックスタート

前提：VS Code 1.74.0 以降と、C/C++ 拡張（IntelliSense）。

[GitHub Releases](https://github.com/7QgvhP/c-function-analyzer/releases) から vsix をダウンロードしてインストールし、C ソースの関数名がある行にカーソルを置いて `Ctrl + Alt + A` を押す。

```bash
code --install-extension c-function-analyzer-X.Y.Z.vsix
```

詳しくは [docs/usage.md](docs/usage.md) を参照。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/spec.md](docs/spec.md) | 仕様（何をするか。分類、各機能、表示の見かた） |
| [docs/usage.md](docs/usage.md) | 使用方法 |
| [docs/architecture.md](docs/architecture.md) | 設計（どう作っているか。解析処理の詳細を含む） |
| [docs/development.md](docs/development.md) | 開発者向けガイド（ビルド、テスト、リリース） |
| [docs/configuration.md](docs/configuration.md) | 設定リファレンス |
| [docs/adr/](docs/adr/README.md) | 設計判断記録（ADR） |
| [CHANGELOG.md](CHANGELOG.md) | 変更履歴 |

## ライセンス

TODO(要確認): LICENSE ファイルがなく、`package.json` にも `license` の指定がない。
