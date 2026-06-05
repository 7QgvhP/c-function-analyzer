#include <stdio.h>
#include <stdlib.h>

// テスト用のダミーグローバル変数
int global_status = 0;
int global_config_threshold = 100;

// テスト用のダミー関数
void log_message(const char *msg) {
    printf("[LOG] %s\n", msg);
}

int do_calculation(int base, float multiplier) {
    return (int)(base * multiplier);
}

/**
 * 解析対象となるテスト関数
 * 関数名がある行にカーソルを置いて解析を実行します
 */
int process_sensor_data(int sensor_id, const char *sensor_name, int *out_status, float *out_value) {
    // 内部（ローカル）変数の宣言
    int local_temp = 10;
    float calculated_val = 0.0;
    
    // 関数ポインタの定義と呼び出し（これは呼び出し関数リストから除外されるべき）
    int (*math_func)(int, float) = do_calculation;
    
    if (sensor_name == NULL) { // NULLは除外リストにあるため、グローバル変数として検出されないはず
        log_message("Error: Sensor name is NULL"); // log_message は直接呼び出しとして検出されるべき
        *out_status = -1; // out_status への書き込み（出力変数）
        global_status = 5; // グローバル変数への書き込み（出力変数）
        return -1; // 戻り値
    }

    // グローバル変数からの読み取り（入力変数）
    if (sensor_id > global_config_threshold) {
        local_temp = 50;
    }

    // 関数ポインタによる呼び出し（関数ポインタ経由のため、呼び出し関数リストから除外されるべき）
    calculated_val = math_func(local_temp, 1.5);
    
    // ポインタ引数への書き込み（出力変数）
    *out_value = calculated_val;
    *out_status = 0;

    return 0; // 戻り値
}
