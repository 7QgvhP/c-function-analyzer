# 設計判断記録（ADR）

重要な設計判断を、1判断1ファイルで記録する。

## ファイル命名規則

`NNNN-短い題名.md`（`NNNN` は4桁の連番。題名は英小文字とハイフン）

## ステータス

| ステータス | 意味 |
|---|---|
| Proposed | 提案中 |
| Accepted | 採用済み |
| Deprecated | 廃止（後継なし） |
| Superseded | 別の ADR で置き換えられた（置き換えた ADR へのリンクを書く） |

## 運用

- 既存の ADR は書き換えない。判断を変えるときは新しい ADR を追加し、古い ADR のステータスを Superseded にする。

## 一覧

| 番号 | 題名 | ステータス | 日付 |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | ADR で設計判断を記録する | Accepted | 2026-11-15 |
| [0002](0002-use-tree-sitter.md) | 正規表現ではなく tree-sitter で構文解析する | Accepted | 2026-06-05 |
| [0003](0003-definition-via-vscode-provider.md) | 定義位置を VS Code の定義プロバイダで求める | Accepted | 2026-08-04 |
| [0004](0004-address-passing-without-prototype.md) | アドレス渡しは、呼び出し先の宣言を見ずに入出力の両方にする | Accepted | 2026-09-29 |
| [0005](0005-flowchart-as-mermaid-text.md) | フローチャートは Mermaid のテキストとして出力する | Accepted | 2026-10-09 |
| [0006](0006-macro-detection-by-definitions.md) | マクロかどうかを、収集した定義だけで判定する | Accepted | 2026-10-06 |

日付は、その判断を含むリリースの日付。
