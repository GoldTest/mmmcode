#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/god/.local/bin:/usr/local/bin:/usr/bin:$PATH"

LOG_DIR="/home/god/.waygate/mmcode"
LOG_FILE="${LOG_DIR}/checkin.log"
mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "=== [${TIMESTAMP}] 开始执行 MiniMax Code 自动签到任务 ===" >> "${LOG_FILE}"

# 1. 如果配置了多账户，遍历执行全部多账户签到
ACCOUNTS_ROOT="${HOME}/.waygate/accounts"
HAS_MULTI=0

if [ -d "${ACCOUNTS_ROOT}" ]; then
    for dir in "${ACCOUNTS_ROOT}"/*; do
        if [ -d "${dir}/mmcode" ] && [ -f "${dir}/mmcode/credential.json" ]; then
            HAS_MULTI=1
            acc_name=$(basename "${dir}")
            echo "[${TIMESTAMP}] 正在为多账户 [${acc_name}] 签到..." >> "${LOG_FILE}"
            if OUT=$(WAYGATE_HOME="${dir}" mmcode checkin --json 2>&1); then
                echo "[${TIMESTAMP}] [${acc_name}] 签到结果: ${OUT}" >> "${LOG_FILE}"
            else
                echo "[${TIMESTAMP}] [${acc_name}] 签到失败: ${OUT}" >> "${LOG_FILE}"
            fi
        fi
    done
fi

# 2. 如果存在默认单账户，执行默认单账户签到
DEFAULT_CRED="${HOME}/.waygate/mmcode/credential.json"
if [ -f "${DEFAULT_CRED}" ]; then
    echo "[${TIMESTAMP}] 正在为默认账户签到..." >> "${LOG_FILE}"
    if OUT=$(mmcode checkin --json 2>&1); then
        echo "[${TIMESTAMP}] [默认账户] 签到结果: ${OUT}" >> "${LOG_FILE}"
    else
        echo "[${TIMESTAMP}] [默认账户] 签到失败: ${OUT}" >> "${LOG_FILE}"
    fi
fi

if [ "$HAS_MULTI" -eq 0 ] && [ ! -f "${DEFAULT_CRED}" ]; then
    echo "[${TIMESTAMP}] 暂未找到任何已登录的凭证，跳过签到。" >> "${LOG_FILE}"
fi
