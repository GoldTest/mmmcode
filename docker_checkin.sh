#!/usr/bin/env bash
#
# Docker 模式下的每日自动签到。
#
# ## 为什么不再直接跑 `mmcode checkin`
# 旧脚本（auto_checkin.sh）在**宿主机**上跑 `mmcode checkin` —— 那会**另起一个进程**
# 去刷新令牌、写回 credential.json。而容器里的服务进程**也在内存里缓存着同一份凭证**。
# MiniMax 的 refresh token 是**一次性**的：
#
#   宿主机刷新 → 写回新的 refresh_token → 容器内存里那份立刻作废
#   → 容器下次刷新拿到 invalid_grant → 该账号被标记 unauthorized → 白白触发一次换号
#
# 所以：**容器是凭证的唯一持有者**，宿主机只负责「到点敲一下容器的 API」。
# 签到逻辑跑在容器进程里，令牌的生命周期始终由**同一个进程**维护 —— 没有竞态。
#
# 依赖：容器在 127.0.0.1:8789 运行；管理密钥在 ~/.waygate/mmcode/admin.json。

set -uo pipefail

STATE_DIR="${WAYGATE_STATE:-$HOME/.waygate}"
ADMIN_FILE="${STATE_DIR}/mmcode/admin.json"
LOG_FILE="${STATE_DIR}/mmcode/checkin.log"
BASE_URL="${MMCODE_BASE_URL:-http://127.0.0.1:8789}"

mkdir -p "$(dirname "${LOG_FILE}")"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"${LOG_FILE}"
}

log "=== Docker 模式自动签到开始 ==="

if [ ! -f "${ADMIN_FILE}" ]; then
  log "找不到管理密钥文件（${ADMIN_FILE}）—— 容器还没起来？跳过。"
  exit 0
fi

ADMIN_KEY=$(python3 -c "
import json,sys
try:
    print(json.load(open('${ADMIN_FILE}')).get('key',''))
except Exception:
    print('')
")

if [ -z "${ADMIN_KEY}" ]; then
  log "管理密钥读取失败 —— 跳过。"
  exit 0
fi

# 容器在不在？探活（不鉴权）。
if ! curl -sf --max-time 5 "${BASE_URL}/healthz" >/dev/null 2>&1; then
  log "容器未响应（${BASE_URL}/healthz）—— 跳过本次签到。"
  exit 0
fi

# 取账号列表。
ACCOUNTS=$(curl -sf --max-time 10 \
  -H "X-Admin-Key: ${ADMIN_KEY}" \
  "${BASE_URL}/admin/api/accounts" 2>/dev/null)

if [ -z "${ACCOUNTS}" ]; then
  log "读取账号列表失败 —— 跳过。"
  exit 0
fi

# 逐个已登录账号签到。
echo "${ACCOUNTS}" | python3 -c "
import json,sys
data = json.load(sys.stdin)
for a in data.get('accounts', []):
    if a.get('loggedIn'):
        print(a['name'])
" | while read -r name; do
  [ -z "${name}" ] && continue
  result=$(curl -sf --max-time 30 -X POST \
    -H "X-Admin-Key: ${ADMIN_KEY}" \
    "${BASE_URL}/admin/api/accounts/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "${name}")/checkin" 2>&1)
  if [ -n "${result}" ]; then
    msg=$(echo "${result}" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('message') or d.get('error') or json.dumps(d,ensure_ascii=False))
except Exception:
    print(sys.stdin.read()[:200])
")
    log "[${name}] ${msg}"
  else
    log "[${name}] 签到请求失败"
  fi
done

log "=== Docker 模式自动签到结束 ==="
