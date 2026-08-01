/**
 * 修飾子マクロ（GLOBAL / LOCAL など）によるパース崩れの修復テストです。
 *
 * `GLOBAL BYTE hoge;` のような記法は tree-sitter がプリプロセッサを展開しないため
 * 型名を誤って解釈します。修復後に本来の型が取れること、および正常なコードや
 * 本当に壊れたコードへ影響しないことを確認します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Parser = require('web-tree-sitter');
import { getParser } from './support/parse';
import { parseWithModifierMacroRepair } from '../src/macroRepair';

/**
 * ソースを修復付きでパースし、最初の宣言・関数定義の型指定子テキストを返します。
 *
 * @param parser 言語設定済みのパーサー
 * @param source 解析対象のCソースコード
 * @returns 型指定子のテキスト。宣言が見つからない場合は null
 */
function firstDeclaredType(parser: Parser, source: string): string | null {
    const tree = parseWithModifierMacroRepair(parser, source);
    let found: string | null = null;

    const visit = (node: Parser.SyntaxNode): void => {
        if (found !== null) {
            return;
        }
        if (node.type === 'declaration' || node.type === 'function_definition') {
            const typeNode = node.childForFieldName('type') || node.child(0);
            found = typeNode ? typeNode.text.trim() : null;
            return;
        }
        for (let i = 0; i < node.childCount; i++) {
            visit(node.child(i)!);
        }
    };

    visit(tree.rootNode);
    return found;
}

/**
 * ソースを修復付きでパースし、パースエラーが残っているかを返します。
 *
 * @param parser 言語設定済みのパーサー
 * @param source 解析対象のCソースコード
 * @returns エラーが残っていれば true
 */
function hasError(parser: Parser, source: string): boolean {
    return parseWithModifierMacroRepair(parser, source).rootNode.hasError();
}

describe('parseWithModifierMacroRepair: 修飾子マクロ付き宣言', () => {
    /** 記法ごとの期待する型名（すべて先頭の GLOBAL は型名に含まれない） */
    const CASES: { source: string; expected: string; label: string }[] = [
        { label: '基本形', source: 'GLOBAL BYTE hoge;', expected: 'BYTE' },
        { label: 'ポインタ', source: 'GLOBAL BYTE *phoge;', expected: 'BYTE' },
        { label: '配列', source: 'GLOBAL BYTE arr[10];', expected: 'BYTE' },
        { label: '多次元配列', source: 'GLOBAL BYTE arr[2][3];', expected: 'BYTE' },
        { label: '初期化子付き', source: 'GLOBAL BYTE hoge = 0;', expected: 'BYTE' },
        { label: 'サイズ指定子', source: 'GLOBAL unsigned char uc;', expected: 'unsigned char' },
        { label: '型修飾子付き', source: 'GLOBAL const BYTE cb;', expected: 'BYTE' },
        { label: '構造体', source: 'GLOBAL struct Foo st;', expected: 'struct Foo' },
        { label: 'カンマ区切り', source: 'GLOBAL BYTE a, b;', expected: 'BYTE' },
        { label: '関数プロトタイプ', source: 'GLOBAL void func(void);', expected: 'void' },
        { label: 'ポインタを返す関数', source: 'GLOBAL BYTE *fetch(void);', expected: 'BYTE' }
    ];

    for (const c of CASES) {
        test(`${c.label}: ${c.source} の型は ${c.expected}`, async () => {
            const parser = await getParser();
            assert.equal(firstDeclaredType(parser, c.source), c.expected);
            assert.equal(hasError(parser, c.source), false, 'パースエラーが解消されること');
        });
    }

    test('関数定義とボディ内の宣言の双方を修復する', async () => {
        const parser = await getParser();
        const source = 'GLOBAL void func(void)\n{\n    LOCAL BYTE tmp;\n    tmp = 1;\n}\n';
        const tree = parseWithModifierMacroRepair(parser, source);

        assert.equal(tree.rootNode.hasError(), false);
        const types: string[] = [];
        const visit = (node: Parser.SyntaxNode): void => {
            if (node.type === 'declaration' || node.type === 'function_definition') {
                const typeNode = node.childForFieldName('type') || node.child(0);
                types.push(typeNode ? typeNode.text.trim() : '');
            }
            for (let i = 0; i < node.childCount; i++) {
                visit(node.child(i)!);
            }
        };
        visit(tree.rootNode);

        assert.deepEqual(types, ['void', 'BYTE']);
    });

    test('#define の記述自体は空白化しない', async () => {
        const parser = await getParser();
        const source = '#define GLOBAL extern\nGLOBAL BYTE hoge;\n';
        const tree = parseWithModifierMacroRepair(parser, source);

        const defs: string[] = [];
        const visit = (node: Parser.SyntaxNode): void => {
            if (node.type === 'preproc_def') {
                defs.push(node.text.trim());
            }
            for (let i = 0; i < node.childCount; i++) {
                visit(node.child(i)!);
            }
        };
        visit(tree.rootNode);

        assert.deepEqual(defs, ['#define GLOBAL extern'], 'マクロ定義はそのまま残ること');
    });

    test('位置情報が元のソースと一致する', async () => {
        const parser = await getParser();
        const source = 'int dummy;\nGLOBAL BYTE hoge;\n';
        const tree = parseWithModifierMacroRepair(parser, source);

        const positions: { row: number; column: number }[] = [];
        const visit = (node: Parser.SyntaxNode): void => {
            if (node.type === 'identifier' && node.text === 'hoge') {
                positions.push({ row: node.startPosition.row, column: node.startPosition.column });
            }
            for (let i = 0; i < node.childCount; i++) {
                visit(node.child(i)!);
            }
        };
        visit(tree.rootNode);

        assert.equal(positions.length, 1, 'hoge が識別子として見つかること');
        // 空白化は同じ長さで行うため、行・列は元のソースのまま
        assert.deepEqual(positions[0], {
            row: 1,
            column: source.split('\n')[1].indexOf('hoge')
        });
    });
});

describe('parseWithModifierMacroRepair: 型名へ吸収されたマクロ', () => {
    // VOLATILE unsigned long x; はエラーにならず sized_type_specifier へ吸収される
    const CASES: { source: string; expected: string; label: string }[] = [
        { label: 'unsigned long', source: 'VOLATILE unsigned long status;', expected: 'unsigned long' },
        { label: 'unsigned', source: 'VOLATILE unsigned counter;', expected: 'unsigned' },
        { label: 'signed short', source: 'GLOBAL signed short delta;', expected: 'signed short' },
        { label: 'long long', source: 'GLOBAL long long total;', expected: 'long long' }
    ];

    for (const c of CASES) {
        test(`${c.label}: ${c.source} の型は ${c.expected}`, async () => {
            const parser = await getParser();
            assert.equal(firstDeclaredType(parser, c.source), c.expected);
        });
    }

    test('パースエラーがなくても修復する', async () => {
        const parser = await getParser();
        const source = 'VOLATILE unsigned long status;';
        // 元のソースはエラーなくパースされるため、エラー数では判定できない
        assert.equal(parser.parse(source).rootNode.hasError(), false, '前提: エラーは出ていない');
        assert.equal(firstDeclaredType(parser, source), 'unsigned long');
    });

    test('構造体メンバでも修復する', async () => {
        const parser = await getParser();
        const source = 'struct S { VOLATILE unsigned long status; };';
        const tree = parseWithModifierMacroRepair(parser, source);

        const types: string[] = [];
        const visit = (node: Parser.SyntaxNode): void => {
            if (node.type === 'field_declaration') {
                const typeNode = node.childForFieldName('type') || node.child(0);
                types.push(typeNode ? typeNode.text.trim() : '');
            }
            for (let i = 0; i < node.childCount; i++) {
                visit(node.child(i)!);
            }
        };
        visit(tree.rootNode);

        assert.deepEqual(types, ['unsigned long']);
    });

    test('正常な sized_type_specifier は変更しない', async () => {
        const parser = await getParser();
        assert.equal(firstDeclaredType(parser, 'unsigned long total;'), 'unsigned long');
        assert.equal(firstDeclaredType(parser, 'unsigned char raw;'), 'unsigned char');
    });
});

describe('parseWithModifierMacroRepair: 修復対象外', () => {
    /** 修復してはならないコード（型名がそのまま残ること） */
    const UNTOUCHED: { source: string; expected: string; label: string }[] = [
        { label: 'extern 付き', source: 'extern BYTE plain;', expected: 'BYTE' },
        { label: 'typedef 型', source: 'Foo bar;', expected: 'Foo' },
        { label: '組み込み型', source: 'unsigned char raw;', expected: 'unsigned char' },
        { label: 'static 付き', source: 'static int counter;', expected: 'int' }
    ];

    for (const c of UNTOUCHED) {
        test(`${c.label}: ${c.source} は変更されない`, async () => {
            const parser = await getParser();
            assert.equal(firstDeclaredType(parser, c.source), c.expected);
        });
    }

    test('ボディだけが壊れた関数の戻り値型は除去しない', async () => {
        const parser = await getParser();
        // MyType は正当な型名。ボディのエラーに引きずられて除去してはならない
        const source = 'MyType func(void) { this is broken ((( }\n';
        assert.equal(firstDeclaredType(parser, source), 'MyType');
    });

    test('修復できないソースでもエラーで落ちない', async () => {
        const parser = await getParser();
        const source = 'int 1bad;\n';
        assert.doesNotThrow(() => parseWithModifierMacroRepair(parser, source));
    });
});
