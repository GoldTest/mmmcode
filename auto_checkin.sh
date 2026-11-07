#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/god/.local/bin:/usr/local/bin:/usr/bin:$PATH"

LOG_DIR="${MMCODE_STATE:-$HOME/.waygate}/mmcode"
LOG_FILE="${LOG_DIR}/checkin.log"
mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "=== [${TIMESTAMP}] 开始执行 MiniMax Code 自动签到任务 ===" >> "${LOG_FILE}"

# ⚠️ **Docker 模式下不能用本脚本**。
#
# 本脚本在**宿主机**上跑 `mmcode checkin` —— 那是另一个进程，会去刷新令牌、
# 写回 credential.json。而容器里的服务进程**也在内存里缓存着同一份凭证**。
# MiniMax 的 refresh token 是一次性的：
#
#   宿主机刷新 → 写回新的 refresh_token → 容器内存里那份立刻作废
#   → 容器下次刷新拿到 invalid_grant → 该账号被误判失效 → 白白触发一次换号
#
# 所以：**容器是凭证的唯一持有者**。检测到容器在跑就拒绝执行，
# 改用 docker_checkin.sh（它只通过容器 API 触发签到，凭证生命周期由容器独占维护）。
DOCKER_BASE_URL="${MMCODE_BASE_URL:-http://127.0.0.1:8789}"
if curl -sf --max-time 3 "${DOCKER_BASE_URL}/healthz" >/dev/null 2>&1; then
    echo "[${TIMESTAMP}] 检测到容器服务在跑（${DOCKER_BASE_URL}）—— 本脚本不执行。" >> "${LOG_FILE}"
    echo "[${TIMESTAMP}] 请改用 docker_checkin.sh（只通过容器 API 签到，无令牌竞态）。" >> "${LOG_FILE}"
    exit 0
fi

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
DEFAULT_CRED="${MMCODE_STATE:-$HOME/.waygate}/mmcode/credential.json"
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
