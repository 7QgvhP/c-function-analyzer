import Parser from 'web-tree-sitter';

// 解析結果を保持するインターフェース定義
export interface VariableInfo {
    name: string;
    type: string;
    details?: string; // 補足情報（例：「値渡し引数」「ポインタ書き込み（出力）」「グローバル変数」など）
}

export interface AnalysisResult {
    functionName: string;
    returnType: string;
    inputs: VariableInfo[];
    outputs: VariableInfo[];
    internalVariables: VariableInfo[];
    calledFunctions: string[];
}

// 標準的なマクロや予約語など、グローバル変数判定から除外するブラックリスト
const EXCLUDE_LIST = new Set([
    'NULL', 'TRUE', 'FALSE', 'true', 'false',
    'stdin', 'stdout', 'stderr',
    'sizeof', 'countof',
    'int', 'char', 'float', 'double', 'void', 'short', 'long', 'signed', 'unsigned',
    'struct', 'union', 'enum'
]);

/**
 * ASTノードを再帰的に走査するヘルパー関数
 */
function walk(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void) {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, callback);
    }
}

/**
 * C言語コードを解析し、カーソル行にある関数情報を抽出します。
 * @param tree 解析対象のASTツリー
 * @param cursorLine ユーザーがカーソルを置いている行（0始まり）
 * @returns 解析結果、またはカーソルが関数名部分にない場合は null
 */
export function analyzeCFunction(tree: Parser.Tree, cursorLine: number): AnalysisResult | null {
    const rootNode = tree.rootNode;
    let targetFunctionNode: Parser.SyntaxNode | null = null;
    let isCursorOnSignature = false;

    // 1. カーソルがある関数定義 (function_definition) を探索
    walk(rootNode, (node) => {
        if (node.type === 'function_definition') {
            // 関数全体の行範囲
            const startRow = node.startPosition.row;
            const endRow = node.endPosition.row;

            if (cursorLine >= startRow && cursorLine <= endRow) {
                // 関数宣言・シグネチャ部分（関数名や引数宣言があるノード）を特定
                // C言語のASTでは、戻り値の型 (型宣言部) や declarator (関数名と引数リスト) になります
                const declaratorNode = node.childForFieldName('declarator');
                if (declaratorNode) {
                    const sigStartRow = node.startPosition.row; // 戻り値の型から開始
                    const sigEndRow = declaratorNode.endPosition.row; // 引数リストの閉じ括弧で終了

                    if (cursorLine >= sigStartRow && cursorLine <= sigEndRow) {
                        targetFunctionNode = node;
                        isCursorOnSignature = true;
                    }
                }
            }
        }
    });

    // カーソルが関数名や引数リストの行にない場合は解析をスキップ
    if (!targetFunctionNode || !isCursorOnSignature) {
        return null;
    }

    const funcNode = targetFunctionNode as Parser.SyntaxNode;

    // 2. 関数名と戻り値の型を抽出
    let functionName = 'unknown';
    let returnType = 'void';

    const declaratorNode = funcNode.childForFieldName('declarator');
    if (declaratorNode) {
        // 関数名を取得（関数宣言ノードから名前を表す識別子を見つける）
        let nameNode = declaratorNode;
        while (nameNode && nameNode.type !== 'identifier') {
            // pointer_declarator や function_declarator の中を探索
            const childDeclarator = nameNode.childForFieldName('declarator') || nameNode.child(0);
            if (childDeclarator) {
                nameNode = childDeclarator;
            } else {
                break;
            }
        }
        if (nameNode && nameNode.type === 'identifier') {
            functionName = nameNode.text;
        }
    }

    // 戻り値の型は、declarator以外の部分（最初のいくつかの型指定子ノード）から取得
    const typeNode = funcNode.childForFieldName('type') || funcNode.child(0);
    if (typeNode) {
        // 例: "int", "static void", "struct Data*" など
        // declaratorの手前までのテキストを結合して戻り値とする
        const declStart = declaratorNode ? declaratorNode.startIndex : funcNode.endIndex;
        returnType = funcNode.text.substring(0, declStart - funcNode.startIndex).trim();
        // 改行や余分な空白を除去
        returnType = returnType.replace(/\s+/g, ' ');
    }

    // 3. 引数の抽出
    const params: { name: string; type: string; isPointer: boolean }[] = [];
    if (declaratorNode) {
        // parameter_list ノードを探す
        let paramListNode: Parser.SyntaxNode | null = null;
        walk(declaratorNode, (n) => {
            if (n.type === 'parameter_list') {
                paramListNode = n;
            }
        });

        if (paramListNode) {
            const list = paramListNode as Parser.SyntaxNode;
            for (let i = 0; i < list.childCount; i++) {
                const child = list.child(i)!;
                if (child.type === 'parameter_declaration') {
                    // 各引数の型と名前を抽出
                    const typeDeclNode = child.childForFieldName('type') || child.child(0);
                    const declNode = child.childForFieldName('declarator');

                    if (typeDeclNode && declNode) {
                        let paramName = '';
                        let isPointer = false;

                        // ポインタ宣言 (pointer_declarator) か判定しつつ名前を取得
                        let n = declNode;
                        while (n) {
                            if (n.type === 'pointer_declarator') {
                                isPointer = true;
                            }
                            if (n.type === 'identifier') {
                                paramName = n.text;
                                break;
                            }
                            n = n.childForFieldName('declarator') || n.child(0)!;
                        }

                        // 型テキストの抽出
                        const typeText = child.text.substring(0, child.text.indexOf(paramName)).trim();
                        params.push({
                            name: paramName,
                            type: typeText || 'int', // フォールバック
                            isPointer
                        });
                    }
                }
            }
        }
    }

    // 4. 関数内部（ボディ）の解析（変数、グローバル変数、関数呼び出し、書き込み判定）
    const bodyNode = funcNode.childForFieldName('body');
    
    // 解析中に見つかったローカル変数、グローバル変数、呼び出し関数を格納するセット
    const localVars = new Map<string, string>(); // name -> type
    const calledFunctionsSet = new Set<string>();
    
    // グローバル変数の出現箇所を記録する
    const globalVarReads = new Set<string>();
    const globalVarWrites = new Set<string>();
    
    // ポインタ引数の書き込み状況を追跡する
    const pointerWrites = new Set<string>();

    if (bodyNode) {
        // ボディ内のノードをトラバース
        walk(bodyNode, (node) => {
            // A. ローカル変数宣言の抽出 (declaration)
            if (node.type === 'declaration') {
                const typeNode = node.childForFieldName('type') || node.child(0);
                if (typeNode) {
                    const typeText = typeNode.text;
                    
                    // 宣言されている識別子（変数名）をすべて取り出す（カンマ区切りの複数宣言に対応）
                    walk(node, (n) => {
                        // init_declarator や氏名などから identifier を探す
                        if (n.type === 'init_declarator' || n.type === 'identifier') {
                            let varName = '';
                            let isPtr = false;
                            
                            let temp = n;
                            while (temp) {
                                if (temp.type === 'pointer_declarator') {
                                    isPtr = true;
                                }
                                if (temp.type === 'identifier') {
                                    varName = temp.text;
                                    break;
                                }
                                temp = temp.childForFieldName('declarator') || temp.child(0)!;
                            }
                            
                            if (varName && !localVars.has(varName)) {
                                const fullType = typeText + (isPtr ? '*' : '');
                                localVars.set(varName, fullType);
                            }
                        }
                    });
                }
            }

            // B. 関数呼び出しの抽出 (call_expression)
            if (node.type === 'call_expression') {
                const funcNameNode = node.childForFieldName('function') || node.child(0);
                // 直接の識別子呼び出し（関数ポインタ経由でないもの）
                if (funcNameNode && funcNameNode.type === 'identifier') {
                    calledFunctionsSet.add(funcNameNode.text);
                }
            }

            // C. ポインタ書き込みおよびグローバル変数書き込みの判定 (assignment_expression / update_expressionなど)
            // 代入式: result = value など
            if (node.type === 'assignment_expression') {
                const leftNode = node.childForFieldName('left') || node.child(0)!;
                checkLhsWrites(leftNode, params, localVars, pointerWrites, globalVarWrites);
            }
            // インクリメント・デクリメント式: i++ や --p など
            if (node.type === 'update_expression') {
                const argumentNode = node.childForFieldName('argument') || node.child(0)!;
                checkLhsWrites(argumentNode, params, localVars, pointerWrites, globalVarWrites);
            }

            // D. 識別子 (identifier) が出現した際の、入力（読み取り）グローバル変数の候補判定
            if (node.type === 'identifier') {
                const name = node.text;
                
                // 親ノードがメンバアクセスの右側（例: data.member の member）や、関数宣言名、変数宣言の場合はスキップ
                const parent = node.parent;
                let isFieldOrDeclaration = false;
                if (parent) {
                    if (parent.type === 'field_expression' && parent.childForFieldName('field') === node) {
                        isFieldOrDeclaration = true;
                    }
                    if (parent.type === 'parameter_declaration' || parent.type === 'declaration' || parent.type === 'function_declarator') {
                        isFieldOrDeclaration = true;
                    }
                }

                if (!isFieldOrDeclaration) {
                    // 引数、ローカル変数、呼び出し関数、ブラックリストのいずれにも属さない場合
                    const isParam = params.some(p => p.name === name);
                    const isLocal = localVars.has(name);
                    const isCall = calledFunctionsSet.has(name);
                    
                    if (!isParam && !isLocal && !isCall && !EXCLUDE_LIST.has(name)) {
                        // 読み取り（右辺等）で出現しているかチェック
                        // 代入式の左辺として既に書き込み判定されていなければ、読み取り（入力）とみなす
                        if (!isLhsNode(node)) {
                            globalVarReads.add(name);
                        }
                    }
                }
            }
        });
    }

    // 5. 解析結果を inputs / outputs / internalVariables に分類・統合
    const inputs: VariableInfo[] = [];
    const outputs: VariableInfo[] = [];

    // 値渡しの引数、および書き込みが行われていないポインタ引数は「入力変数」
    // 書き込みが行われているポインタ引数は「出力変数」
    params.forEach(p => {
        const fullType = p.type + (p.isPointer ? '*' : '');
        if (p.isPointer && pointerWrites.has(p.name)) {
            outputs.push({
                name: p.name,
                type: fullType,
                details: '出力引数（ポインタ書き込みあり）'
            });
        } else {
            inputs.push({
                name: p.name,
                type: fullType,
                details: p.isPointer ? '入力引数（読み取り専用ポインタ）' : '入力引数（値渡し）'
            });
        }
    });

    // 戻り値がある場合は、出力変数リストに追加
    if (returnType !== 'void') {
        outputs.push({
            name: '戻り値 (return)',
            type: returnType,
            details: '関数の戻り値'
        });
    }

    // グローバル変数の分類
    // 書き込みが行われているものは「グローバル変数（出力）」
    // 読み取りが行われているものは「グローバル変数（入力）」
    globalVarWrites.forEach(name => {
        outputs.push({
            name,
            type: 'extern/global (推定)',
            details: 'グローバル変数への書き込み'
        });
    });

    globalVarReads.forEach(name => {
        // 書き込み対象になっていないもののみを入力とする（両方の場合は両方に出すか、要件に合わせて今回はシンプルに分ける）
        if (!globalVarWrites.has(name)) {
            inputs.push({
                name,
                type: 'extern/global (推定)',
                details: 'グローバル変数からの読み取り'
            });
        }
    });

    // 内部（ローカル）変数のリスト化
    const internalVariables: VariableInfo[] = [];
    localVars.forEach((type, name) => {
        internalVariables.push({ name, type });
    });

    return {
        functionName,
        returnType,
        inputs,
        outputs,
        internalVariables,
        calledFunctions: Array.from(calledFunctionsSet)
    };
}

/**
 * 代入式の左辺（LHS）のノードをチェックし、ポインタ引数またはグローバル変数への書き込みを判定します。
 */
function checkLhsWrites(
    node: Parser.SyntaxNode,
    params: { name: string; type: string; isPointer: boolean }[],
    localVars: Map<string, string>,
    pointerWrites: Set<string>,
    globalVarWrites: Set<string>
) {
    // 1. デリファレンスによる書き込み (*ptr = ...)
    if (node.type === 'pointer_expression') {
        const operand = node.child(1) || node.childForFieldName('argument');
        if (operand && operand.type === 'identifier') {
            const name = operand.text;
            const param = params.find(p => p.name === name);
            if (param && param.isPointer) {
                pointerWrites.add(name);
            }
        }
    }
    // 2. 構造体/共用体アローアクセスによるポインタ書き込み (ptr->member = ...)
    else if (node.type === 'field_expression') {
        const argument = node.child(0) || node.childForFieldName('argument');
        const operator = node.child(1);
        if (argument && argument.type === 'identifier') {
            const name = argument.text;
            // アロー演算子（->）によるアクセスの場合はポインタ書き込み
            if (operator && operator.text === '->') {
                const param = params.find(p => p.name === name);
                if (param && param.isPointer) {
                    pointerWrites.add(name);
                }
            } else if (operator && operator.text === '.') {
                // 直接ドットアクセス (data.member = ...) で、それがグローバル変数である場合
                const isParam = params.some(p => p.name === name);
                const isLocal = localVars.has(name);
                if (!isParam && !isLocal && !EXCLUDE_LIST.has(name)) {
                    globalVarWrites.add(name);
                }
            }
        }
    }
    // 3. 単純な変数代入 (var = ...)
    else if (node.type === 'identifier') {
        const name = node.text;
        const isParam = params.some(p => p.name === name);
        const isLocal = localVars.has(name);
        
        // 引数でもローカル変数でもない場合はグローバル変数への書き込み
        if (!isParam && !isLocal && !EXCLUDE_LIST.has(name)) {
            globalVarWrites.add(name);
        }
    }
}

/**
 * ノードが代入式の左辺（書き込み先）に含まれるかどうかを判定します。
 */
function isLhsNode(node: Parser.SyntaxNode): boolean {
    let current = node;
    while (current.parent) {
        const parent = current.parent;
        if (parent.type === 'assignment_expression') {
            const left = parent.childForFieldName('left') || parent.child(0);
            // 代入式の左辺ツリーの下にあるノードであれば Lhs
            if (left && (left === current || isAncestor(left, current))) {
                return true;
            }
        }
        if (parent.type === 'update_expression') {
            return true;
        }
        current = parent;
    }
    return false;
}

/**
 * ancestor が descendant の先祖ノードであるか判定します。
 */
function isAncestor(ancestor: Parser.SyntaxNode, descendant: Parser.SyntaxNode): boolean {
    let curr: Parser.SyntaxNode | null = descendant;
    while (curr) {
        if (curr === ancestor) {
            return true;
        }
        curr = curr.parent;
    }
    return false;
}
