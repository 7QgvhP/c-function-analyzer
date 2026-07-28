/*
 * C Function Analyzer の動作確認用サンプル
 *
 * 3階層のインクルードを経由した定義が解決されることを確認できます。
 *
 *   sensor_main.c
 *     └─ app_config.h            （階層1: includePaths 設定が必要）
 *          ├─ hal/sensor_hal.h   （階層2: app_config.h からの相対）
 *          │    └─ platform/types.h （階層3: sensor_hal.h からの相対）
 *          └─ ../platform/types.h   （重複インクルード。二重展開されない）
 *
 * 使い方:
 *   下の update_sensor_status() の関数名がある行にカーソルを置き、
 *   Ctrl + Alt + A を押してください。
 */
#include <stdio.h>          /* システムインクルードは探索対象外 */
#include "app_config.h"

/* このファイル自身で定義するグローバル変数（インクルード側より優先される） */
U8 g_local_retry = 0;

/* このファイル自身のマクロ */
#define LOCAL_RETRY_MAX 5

/**
 * センサーの状態を更新し、警告レベルを判定します。
 *
 * ここにカーソルを置いて解析してください。
 */
S16 update_sensor_status(U8 channel, S16 *out_corrected, struct SensorReading *reading)
{
    /* 内部変数 */
    S16 raw = 0;
    U32 elapsed = 0;
    U8  retry = 0;
    S16 history[MAX_SENSOR_COUNT];

    /* 階層2のプロトタイプ宣言から解決される関数呼び出し */
    raw = hal_read_raw(channel);

    /* 階層1の構造体メンバへの書き込み（型は U8 に解決される） */
    g_app_config.mode = 1;

    /* 階層1の構造体の配列メンバ（型は U8、名前は enabled_channels[MAX_SENSOR_COUNT]） */
    g_app_config.enabled_channels[0] = channel;

    /* 階層2のグローバル構造体配列への書き込み（型は S16 に解決される） */
    g_readings[0].raw_value = raw;

    /* ポインタ引数のメンバアクセス（型は U32 に解決される） */
    reading->measured_at = g_system_uptime;

    /* 階層3のグローバル変数の読み取り（型は U32） */
    elapsed = g_system_uptime;

    /* 階層3のマクロ（macro (10) と表示される） */
    if (elapsed > SYSTEM_TICK_MS) {
        /* 階層1のマクロ（macro (1000)） */
        if (raw > WARN_THRESHOLD) {
            g_warn_level = 1;
        }
        /* 階層1のマクロ（macro (2000)） */
        if (raw > ALERT_THRESHOLD) {
            g_warn_level = 2;
            app_log("alert");
        }
    }

    /* 階層2のマクロとグローバル変数 */
    if (g_error_count > SENSOR_ERROR_LIMIT) {
        retry = g_local_retry;      /* 自ファイルのグローバル変数 */
        if (retry < LOCAL_RETRY_MAX) {
            g_local_retry = retry + 1;
        }
    }

    history[0] = raw;

    /* ポインタ引数への書き込み（出力引数） */
    *out_corrected = raw + g_app_config.offset;

    return raw;
}
