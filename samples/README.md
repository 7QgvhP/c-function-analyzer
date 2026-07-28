# 動作確認用サンプル

複数階層のインクルードを経由した定義が解決されることを確認するためのサンプルです。

## 構成

```
samples/
├─ src/sensor_main.c            解析対象
└─ include/
   ├─ app_config.h              階層1
   ├─ hal/sensor_hal.h          階層2
   └─ platform/types.h          階層3
```

インクルードの連鎖は次のようになっています。

```
sensor_main.c
  └─ app_config.h                （階層1: includePaths 設定が必要）
       ├─ hal/sensor_hal.h       （階層2: app_config.h からの相対パス）
       │    └─ platform/types.h  （階層3: sensor_hal.h からの相対パス）
       └─ ../platform/types.h    （重複インクルード。二重展開されない）
```

`src/` と `include/` が別ディレクトリのため、**1段目だけ `includePaths` 設定が必要**です。2段目以降はインクルード元ファイルからの相対パスで解決されます。

## 使い方

1. **`samples` フォルダを VS Code で開きます**（`.vscode/settings.json` に `includePaths` 設定が入っています）。
2. `src/sensor_main.c` を開きます。
3. `update_sensor_status` の**関数名がある行**にカーソルを置きます。
4. `Ctrl + Alt + A` を押します。

> プロジェクト全体をワークスペースとして開いている場合は、設定を `["samples/include"]` にしてください。

## 期待される解析結果

### 入力変数

| 型 | 名前 | 定義元 |
|---|---|---|
| `U8` | `channel` | 引数 |
| `U32` | `g_system_uptime` | **階層3** `platform/types.h` |
| `U8` | `g_error_count` | **階層2** `hal/sensor_hal.h` |
| `S16` | `g_app_config.offset` | **階層1** `app_config.h`（メンバ型に解決） |
| `U8` | `g_local_retry` | 自ファイル |

### 出力変数

| 型 | 名前 | 定義元 |
|---|---|---|
| `S16` | `戻り値 (return)` | — |
| `S16*` | `out_corrected` | 引数 |
| `U32` | `reading->measured_at` | **階層2** の構造体メンバ型に解決 |
| `U8` | `g_app_config.mode` | **階層1** の構造体メンバ型に解決 |
| `U8` | `g_app_config.enabled_channels[MAX_SENSOR_COUNT]` | 配列メンバの次元が反映される |
| `S16` | `g_readings[MAX_SENSOR_COUNT].raw_value` | **階層2** のグローバル配列＋メンバ型 |
| `U8` | `g_warn_level` | **階層1** |
| `U8` | `g_local_retry` | 自ファイル（読み書き両方のため入力にも出る） |

> `reading` はメンバへの書き込みのみで使われるため、引数そのものではなく `reading->measured_at` というアクセスパスとして表示されます。ポインタ引数は読み書きされたメンバ単位で分類されます。

### マクロ変数

| 型 | 名前 | 定義元 |
|---|---|---|
| `macro (10)` | `SYSTEM_TICK_MS` | **階層3** |
| `macro (8)` | `MAX_SENSOR_COUNT` | **階層3** |
| `macro (3)` | `SENSOR_ERROR_LIMIT` | **階層2** |
| `macro (1000)` | `WARN_THRESHOLD` | **階層1** |
| `macro (2000)` | `ALERT_THRESHOLD` | **階層1** |
| `macro (5)` | `LOCAL_RETRY_MAX` | 自ファイル |

### 呼び出し関数

| 名前 | 定義元 |
|---|---|
| `hal_read_raw` | **階層2** のプロトタイプ宣言 |
| `app_log` | **階層1** のプロトタイプ宣言 |

## 確認のポイント

- **型が `global (推定)` や `macro (推定)` になっていないこと** — インクルードを辿れていれば実際の型・定義値が出ます
- **「定義へ」ボタンで各ヘッダの該当行へジャンプできること** — 3階層目の `platform/types.h` まで飛べます
- **構造体メンバの型がメンバ自身の型になっていること** — `g_app_config.mode` が `struct AppConfig` ではなく `U8` と表示されます
- **`#include <stdio.h>` が探索されないこと** — システムインクルードは対象外です

## 設定を外した場合

`includePaths` を空にすると、`app_config.h` が見つからなくなり**すべての階層が解決できなくなります**。`global (推定)` / `macro (推定)` に戻ることで、設定の効果を確認できます。
