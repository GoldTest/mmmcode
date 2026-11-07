#!/usr/bin/env bash
set -euo pipefail

# 基础目录设置
ACCOUNTS_ROOT="${HOME}/.waygate/accounts"
mkdir -p "${ACCOUNTS_ROOT}"
export PATH="/home/god/.local/bin:/usr/local/bin:/usr/bin:$PATH"

function show_help() {
    cat <<EOF
mmmcode - MiniMax Code 多账户管理与批量签到工具

⚠️  已过时：请优先用 \`mmcode web\` —— 它起一个统一服务（反代 + 管理页 + 管理 API），
   多账号的登录/签到/密钥管理都在网页上做，状态统一持久化。本脚本只留给
   「纯命令行、不起服务」的场景。

用法:
  mmmcode login <账户名> [--region global|cn]   登录/授权指定账户（可指定海外 global 或国内 cn，默认 cn）
  mmmcode login-poll <账户名>                  续跑轮询授权（若登录等待超时）
  mmmcode checkin [账户名]                     签到指定账户（不带参数则自动签到全部账户）
  mmmcode credits [账户名]                     查询指定账户积分（不带参数则查看全部账户）
  mmmcode serve <账户名> [参数...]             启动指定账户的反代服务（如: mmmcode serve user_a --port 8788）
  mmmcode doctor [账户名]                      自检指定账户（不带参数检查全部多账户）
  mmmcode list                                 列出所有已配置的账户及其所属区域
  mmmcode help                                 显示此帮助
EOF
}

function list_accounts() {
    local count=0
    for dir in "${ACCOUNTS_ROOT}"/*; do
        if [ -d "${dir}/mmcode" ] && [ -f "${dir}/mmcode/credential.json" ]; then
            local name
            name=$(basename "${dir}")
            local cred_file="${dir}/mmcode/credential.json"
            local region="cn"
            if grep -q '"region": *"global"' "${cred_file}" 2>/dev/null; then
                region="global"
            fi
            local region_label="[国内 China]"
            if [ "$region" = "global" ]; then
                region_label="[海外 Global]"
            fi
            local acc_id
            acc_id=$(grep -o '"account": *"[^"]*"' "${cred_file}" 2>/dev/null | cut -d'"' -f4 || echo "")
            if [ -n "$acc_id" ]; then
                echo " - 账户名: ${name} ${region_label} (ID: ${acc_id}…) (配置路径: ${dir}/mmcode)"
            else
                echo " - 账户名: ${name} ${region_label} (配置路径: ${dir}/mmcode)"
            fi
            count=$((count + 1))
        fi
    done
    if [ "$count" -eq 0 ]; then
        echo "暂未配置任何多账户。请使用 mmmcode login <账户名> [--region global|cn] 添加。"
    fi
}

function run_login() {
    local name=""
    local region="${MINIMAX_REGION:-cn}"

    while [ $# -gt 0 ]; do
        case "$1" in
            --region|-r)
                shift
                region="${1:-cn}"
                ;;
            --region=*)
                region="${1#*=}"
                ;;
            global|en|intl|io)
                region="global"
                ;;
            cn|china)
                region="cn"
                ;;
            -*)
                echo "未知选项: $1"
                exit 1
                ;;
            *)
                if [ -z "$name" ]; then
                    name="$1"
                else
                    if [ "$1" = "global" ] || [ "$1" = "cn" ]; then
                        region="$1"
                    else
                        echo "多余的参数: $1"
                        exit 1
                    fi
                fi
                ;;
        esac
        shift || true
    done

    if [ -z "$name" ]; then
        echo "错误: 请指定账户名，例如: mmmcode login my_account [--region global|cn]"
        exit 1
    fi

    case "$region" in
        global|en|intl|io)
            region="global"
            ;;
        *)
            region="cn"
            ;;
    esac

    local acc_home="${ACCOUNTS_ROOT}/${name}"
    mkdir -p "${acc_home}"
    local region_label="[国内 China]"
    if [ "$region" = "global" ]; then
        region_label="[海外 Global]"
    fi
    echo "=== 开始为账户 [${name}] ${region_label} 登录授权 ==="
    MINIMAX_REGION="${region}" WAYGATE_HOME="${acc_home}" mmcode login
}

function run_login_poll() {
    local name="${1:-}"
    if [ -z "$name" ]; then
        echo "错误: 请指定账户名，例如: mmmcode login-poll my_account"
        exit 1
    fi
    local acc_home="${ACCOUNTS_ROOT}/${name}"
    if [ ! -d "${acc_home}/mmcode" ]; then
        echo "错误: 账户 [${name}] 不存在或未初始化登录！"
        exit 1
    fi
    echo "=== 开始为账户 [${name}] 续跑轮询授权 ==="
    WAYGATE_HOME="${acc_home}" mmcode login-poll
}

function run_checkin() {
    local target="${1:-}"
    if [ -n "$target" ]; then
        local acc_home="${ACCOUNTS_ROOT}/${target}"
        if [ ! -f "${acc_home}/mmcode/credential.json" ]; then
            echo "错误: 账户 [${target}] 尚未登录或不存在！"
            exit 1
        fi
        echo "=== [${target}] 签到 ==="
        WAYGATE_HOME="${acc_home}" mmcode checkin
    else
        echo "=== 开始批量执行全部多账户签到 ==="
        local found=0
        for dir in "${ACCOUNTS_ROOT}"/*; do
            if [ -d "${dir}/mmcode" ] && [ -f "${dir}/mmcode/credential.json" ]; then
                local name
                name=$(basename "${dir}")
                found=1
                echo "--- 正在签到账户: [${name}] ---"
                WAYGATE_HOME="${dir}" mmcode checkin || echo "账户 [${name}] 签到失败"
            fi
        done
        if [ "$found" -eq 0 ]; then
            echo "未找到任何已登录的多账户。如果使用了默认单账户，执行默认签到："
            mmcode checkin || true
        fi
    fi
}

function run_credits() {
    local target="${1:-}"
    if [ -n "$target" ]; then
        local acc_home="${ACCOUNTS_ROOT}/${target}"
        echo "=== [${target}] 积分账本 ==="
        WAYGATE_HOME="${acc_home}" mmcode credits
    else
        echo "=== 全部账户积分账本 ==="
        for dir in "${ACCOUNTS_ROOT}"/*; do
            if [ -d "${dir}/mmcode" ] && [ -f "${dir}/mmcode/credential.json" ]; then
                local name
                name=$(basename "${dir}")
                echo "----------------------------------------"
                echo "账户: [${name}]"
                WAYGATE_HOME="${dir}" mmcode credits || true
            fi
        done
    fi
}

function run_serve() {
    local name="${1:-}"
    if [ -z "$name" ]; then
        echo "错误: 请指定账户名，例如: mmmcode serve my_account [参数...]"
        exit 1
    fi
    shift || true
    local acc_home="${ACCOUNTS_ROOT}/${name}"
    if [ ! -f "${acc_home}/mmcode/credential.json" ]; then
        echo "错误: 账户 [${name}] 尚未登录或不存在！"
        exit 1
    fi
    echo "=== 启动账户 [${name}] 的反代服务 ==="
    WAYGATE_HOME="${acc_home}" mmcode serve "$@"
}

function run_doctor() {
    local target="${1:-}"
    if [ -n "$target" ]; then
        local acc_home="${ACCOUNTS_ROOT}/${target}"
        if [ ! -f "${acc_home}/mmcode/credential.json" ]; then
            echo "错误: 账户 [${target}] 尚未登录或不存在！"
            exit 1
        fi
        echo "=== [${target}] 自检 ==="
        WAYGATE_HOME="${acc_home}" mmcode doctor
    else
        echo "=== 全部账户自检 ==="
        local found=0
        for dir in "${ACCOUNTS_ROOT}"/*; do
            if [ -d "${dir}/mmcode" ] && [ -f "${dir}/mmcode/credential.json" ]; then
                local name
                name=$(basename "${dir}")
                found=1
                echo "----------------------------------------"
                echo "账户: [${name}]"
                WAYGATE_HOME="${dir}" mmcode doctor || true
            fi
        done
        if [ "$found" -eq 0 ]; then
            echo "未找到任何已登录的多账户。如果使用了默认单账户，执行默认自检："
            mmcode doctor || true
        fi
    fi
}

CMD="${1:-help}"
shift || true

case "$CMD" in
    login)
        run_login "$@"
        ;;
    login-poll)
        run_login_poll "$@"
        ;;
    checkin)
        run_checkin "${1:-}"
        ;;
    credits)
        run_credits "${1:-}"
        ;;
    serve)
        run_serve "$@"
        ;;
    doctor)
        run_doctor "${1:-}"
        ;;
    list)
        list_accounts
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo "未知命令: $CMD"
        show_help
        exit 1
        ;;
esac
