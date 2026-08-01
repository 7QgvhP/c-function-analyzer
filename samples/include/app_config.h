/*
 * 階層1: アプリケーション設定
 *
 * このファイルは src/sensor_main.c から参照されます。
 * src/ と include/ が別ディレクトリのため、この1段目だけは
 * インクルード元からの相対パスでは解決できず、ファイル名検索で解決されます。
 */
#ifndef APP_CONFIG_H
#define APP_CONFIG_H

#include "hal/sensor_hal.h"
#include "../platform/types.h"   /* 既に hal 経由で読み込み済み（重複展開されないことの確認用） */

/* 判定に用いるしきい値 */
#define WARN_THRESHOLD  1000
#define ALERT_THRESHOLD 2000

/* 動作モード */
struct AppConfig {
    U8  mode;
    S16 offset;
    U8  enabled_channels[MAX_SENSOR_COUNT];
};

/* アプリケーション設定（グローバル変数） */
extern struct AppConfig g_app_config;

/* 直近の警告レベル（グローバル変数） */
extern U8 g_warn_level;

/* ログ出力 */
void app_log(const char *message);

#endif /* APP_CONFIG_H */
