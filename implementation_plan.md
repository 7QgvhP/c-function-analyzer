# VS Code 拡張機能「function_analyzer」実装計画 (確定版)

本計画は、`web-tree-sitter` を用いてC言語のソースコードから正確にAST（抽象構文木）を解析し、確定した要件（関数名がある行でのみトリガー、ポインタ引数の書き込み判定、グローバル変数の抽出、関数ポインタ呼び出しの除外）に基づいて、選択された関数の入出力変数や呼び出し関数を抽出して Webview に表示する VS Code 拡張機能の開発手順を定義します。

## ユーザー確認事項

> [!IMPORTANT]
> - **開発用・実行時 npm パッケージのインストール承認**:
>   拡張機能の実装にあたり、以下のパッケージをプロジェクトローカル（`C:\Users\cxti2\Documents\My_App\function_analyzer`）にインストールします。
>   - **dependencies**（実行時）:
>     - `web-tree-sitter` (Tree-sitter WASM 実行環境)
>   - **devDependencies**（開発時・ビルド用）:
>     - `typescript` (TypeScript コンパイラ)
>     - `@types/vscode` (VS Code API の型定義)
>     - `@types/node` (Node.js の型定義)
>     - `esbuild` (高速ビルド・バンドルツール)
>     - `tree-sitter-wasms` (C言語用の `.wasm` パーサーファイルを同梱したパッケージ)
>   
>   これらのインストールおよび本計画の実行についてご承認をお願いいたします。

---

## 提案する変更内容

プロジェクトディレクトリに必要なファイルを新規作成します。

### 1. プロジェクト構成

#### [NEW] [package.json](file:///C:/Users/cxti2/Documents/My_App/function_analyzer/package.json)
拡張機能の定義（マニフェスト）です。
* コンテキストメニュー（エディタ右クリック）に「関数を解析 (Analyze C Function)」を追加します。
* コマンド `function-analyzer.analyze` を登録します。
* `esbuild` を使用したビルドスクリプトと、WASM コピースクリプトを実行するビルド手順を定義します。

#### [NEW] [tsconfig.json](file:///C:/Users/cxti2/Documents/My_App/function_analyzer/tsconfig.json)
TypeScript のコンパイル設定です。

#### [NEW] [scripts/copy-wasm.js](file:///C:/Users/cxti2/Documents/My_App/function_analyzer/scripts/copy-wasm.js)
ビルド時に `node_modules` から必要な `.wasm` ファイル（`tree-sitter.wasm`, `tree-sitter-c.wasm`）を拡張機能の配布フォルダ `dist/` にコピーするクロスプラットフォームスクリプトです。

#### [NEW] [src/extension.ts](file:///C:/Users/cxti2/Documents/My_App/function_analyzer/src/extension.ts)
拡張機能のエントリポイントです。
* アクティベート時に `web-tree-sitter` を `dist/` 配下の WASM ファイルを用いて初期化します。
* コマンド実行時に、アクティブなエディタのカーソル行が「関数定義の関数名がある行（シグネチャ部）」であるかを判定します。
* 条件を満たしている場合のみ、解析ロジックを呼び出して Webview に結果を送信します。条件を満たさない場合は「関数名がある行で実行してください」とメッセージを表示します。
* Webview は常に1つのインスタンスを使い回し、アクティブな結果で表示を更新します。

#### [NEW] [src/analyzer.ts](file:///C:/Users/cxti2/Documents/My_App/function_analyzer/src/analyzer.ts)
`web-tree-sitter` の AST を走査し、確定した仕様に基づいて情報を抽出します。
* **関数の特定とカーソル位置判定**:
  - カーソル行が `function_definition` 内の関数名や引数宣言（`declarator`）の行範囲に含まれるかを判定。
* **戻り値の抽出**: 戻り値の型と、`return` 文で返されている式・変数を抽出します。
* **引数（入力・出力ポインタ）の抽出**:
  - `parameter_list` 内の各引数を解析。
  - ポインタ型ではない引数は「入力変数」と判定。
  - ポインタ型の引数は、関数内の `assignment_expression` の左辺（LHS）でデリファレンス等（`*ptr` や `ptr->member`）されていれば「出力変数」、そうでなければ「入力変数」と判定。
* **グローバル変数（入力・出力）の抽出**:
  - 関数内で参照されている変数のうち、ローカル変数でも引数でもない識別子を抽出（ブラックリストによる `NULL` や `TRUE` の除外を適用）。
  - 代入式の左辺であれば「グローバル変数（出力）」、右辺や条件式で使用されていれば「グローバル変数（入力）」と判定。
* **呼び出し関数の抽出**:
  - 関数内の `call_expression` を走査し、直接の関数呼び出し名（マクロ呼び出し含む）を重複なく抽出。関数ポインタ呼び出しは除外。

#### [NEW] [src/webview.ts](file:///C:/Users/cxti2/Documents/My_App/function_analyzer/src/webview.ts)
解析結果を VS Code 内の別ウィンドウ（Webview パネル）に表示します。
* VS Code の配色テーマ（CSS変数）に対応した、モダンで美しいグリッドレイアウトの HTML/CSS を生成します。

#### [NEW] [.vscode/launch.json](file:///C:/Users/cxti2/Documents/My_App/function_analyzer/.vscode/launch.json)
デバッグ用の設定ファイルです。

---

## 検証計画

### 自動ビルドテスト
1. `npm run compile` がエラーなく実行され、`dist/extension.js`, `dist/tree-sitter.wasm`, `dist/tree-sitter-c.wasm` が正しく出力されることを確認します。

### 手動検証（動作確認）
1. F5キーで「拡張機能開発ホスト」ウィンドウを起動します。
2. テスト用C言語ファイルで、グローバル変数やポインタ引数の書き込み、直接関数呼び出しを含む関数を作成します。
3. **正常系**: 関数名がある行にカーソルを置いて右クリックし、「関数を解析」を実行。Webview が開き、ポインタの書き込み/読み込みが正しく分類され、グローバル変数や直接関数呼び出しが抽出されていることを確認。
4. **警告表示系**: 関数のボディ部分（例: `result = 0;` の行など）にカーソルを置いて実行し、「関数名がある行で実行してください」という通知が表示され、解析が行われないことを確認。
