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
  └─ app_config.h                （階層1: src/ と include/ が別ディレクトリ）
       ├─ hal/sensor_hal.h       （階層2: app_config.h からの相対パス）
       │    └─ platform/types.h  （階層3: sensor_hal.h からの相対パス）
       └─ ../platform/types.h    （重複インクルード。二重展開されない）
```

1段目は `src/` と `include/` が別ディレクトリなので、インクルード元からの相対パスでは解決できません。**ファイル名検索**（既定で有効）で解決されます。2段目以降はインクルード元ファイルからの相対パスで解決されます。

## 使い方

1. **`samples` フォルダを VS Code で開きます**。
2. `src/sensor_main.c` を開きます。
3. `update_sensor_status` の**関数名がある行**にカーソルを置きます。
4. `Ctrl + Alt + A` を押します。

探索パスの設定は不要です。ファイル名検索（既定で有効）により、`include/` 以下のヘッダが自動的に解決されます。

> プロジェクト全体をワークスペースとして開いている場合も、ファイル名検索により解決されます。

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

| 型 | 名前 | 定義値 | 定義元 |
|---|---|---|---|
| `macro` | `SYSTEM_TICK_MS` | `10` | **階層3** |
| `macro` | `MAX_SENSOR_COUNT` | `8` | **階層3** |
| `macro` | `SENSOR_ERROR_LIMIT` | `3` | **階層2** |
| `macro` | `WARN_THRESHOLD` | `1000` | **階層1** |
| `macro` | `ALERT_THRESHOLD` | `2000` | **階層1** |
| `macro` | `LOCAL_RETRY_MAX` | `5` | 自ファイル |
| `enum` | `SENSOR_STATE_BUSY` | `1` | **階層2**（値が省略された列挙子） |
| `enum` | `SENSOR_STATE_FATAL` | `17` | **階層2**（`0x10` の次。10進で表示） |

### 呼び出し関数

| 型名（戻り値） | 名前 | 定義元 |
|---|---|---|
| `S16` | `hal_read_raw` | **階層2** のプロトタイプ宣言 |
| `void` | `app_log` | **階層1** のプロトタイプ宣言 |

## 確認のポイント

- **型が `(推定)` になっていないこと** — インクルードを辿れていれば実際の型・定義値が出ます
- **「定義へ」ボタンで各ヘッダの該当行へジャンプできること** — 3階層目の `platform/types.h` まで飛べます
- **構造体メンバの型がメンバ自身の型になっていること** — `g_app_config.mode` が `struct AppConfig` ではなく `U8` と表示されます
- **呼び出し関数に戻り値の型が表示されること** — インクルード先のプロトタイプ宣言から取得します（`app_log` は `void`）
- **`enum` の列挙子が定義値付きで表示されること** — 型名欄が `enum` になり、値の省略や16進からの加算も反映されます
- **`#include <stdio.h>` が探索されないこと** — システムインクルードは対象外です

## 解決経路の確認

ファイル名検索を無効にすると、`app_config.h` が見つからなくなり**すべての階層が解決できなくなります**。型がすべて `(推定)` に戻ることで、探索の効果を確認できます。

```json
{
  "c-function-analyzer.searchWorkspaceByFileName": false
}
```

`true` に戻すと、設定なしで解決されることが確認できます。
