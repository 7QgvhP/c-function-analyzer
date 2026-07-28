/*
 * 階層2: センサー制御のハードウェア抽象層
 *
 * platform/types.h を相対パス（../platform/）で参照します。
 * このインクルードは「インクルード元ファイルのディレクトリ」を起点に解決されるため、
 * includePaths の設定なしで辿れます。
 */
#ifndef HAL_SENSOR_HAL_H
#define HAL_SENSOR_HAL_H

#include "../platform/types.h"

/* センサーの状態しきい値 */
#define SENSOR_ERROR_LIMIT 3

/* 1つのセンサーが保持する測定値 */
struct SensorReading {
    U8  channel;
    S16 raw_value;
    U32 measured_at;
};

/* 全センサーの測定値テーブル（グローバル変数） */
extern struct SensorReading g_readings[MAX_SENSOR_COUNT];

/* 連続エラー回数（グローバル変数） */
extern U8 g_error_count;

/* ハードウェアから生値を読み出す */
S16 hal_read_raw(U8 channel);

#endif /* HAL_SENSOR_HAL_H */
