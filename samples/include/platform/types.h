/*
 * 階層3: 基盤となる型定義とシステム共通の定数
 *
 * このファイルは sensor_main.c から見て 3 階層目のインクルードにあたります。
 *   sensor_main.c -> app_config.h -> hal/sensor_hal.h -> platform/types.h
 */
#ifndef PLATFORM_TYPES_H
#define PLATFORM_TYPES_H

/* システム全体で共有する定数 */
#define SYSTEM_TICK_MS   10
#define MAX_SENSOR_COUNT 8      // コメント

/* 基本型のエイリアス */
typedef unsigned char  U8;
typedef signed short   S16;
typedef unsigned long  U32;

/* 各階層で参照されるグローバルな稼働時間カウンタ */
extern U32 g_system_uptime;

#endif /* PLATFORM_TYPES_H */
