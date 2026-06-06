const fs = require('fs');
const path = require('path');

// コピー先ディレクトリ (dist)
const destDir = path.join(__dirname, '..', 'dist');

// 必要なWASMファイルのパス定義
const wasmFiles = [
    {
        src: path.join(__dirname, '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
        dest: path.join(destDir, 'tree-sitter.wasm')
    },
    {
        src: path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-c.wasm'),
        dest: path.join(destDir, 'tree-sitter-c.wasm')
    }
];

// 出力先ディレクトリが存在しない場合は作成する
if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

// 各WASMファイルをコピーする
wasmFiles.forEach(file => {
    try {
        if (fs.existsSync(file.src)) {
            fs.copyFileSync(file.src, file.dest);
            console.log(`Successfully copied: ${path.basename(file.src)} -> dist/`);
        } else {
            console.error(`Source file not found: ${file.src}`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`Error copying file ${file.src}:`, err);
        process.exit(1);
    }
});
