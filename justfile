# Chatgroup MCP Server 常用命令
# 使用 `just` 或 `just --list` 查看全部配方

default:
    @just --list

# 安装依赖
install:
    npm install

# 编译到 dist/
build:
    npm run build

# 开发模式（tsx 热重启）
dev:
    npm run dev

# 类型检查（不产出文件）
typecheck:
    npm run typecheck

# e2e 测试（真实 HTTP + MCP SDK 客户端）
test:
    npm test

# e2e 测试（watch 模式）
test-watch:
    npm run test:watch

# 本地完整校验：类型检查 + 测试
check: typecheck test

# 需已 npm login；工作区须干净（改动已提交）。预演：just release --dry-run
# 发布到 npm 官方仓库：完整校验 + 构建后执行 npm publish
release *args: check build
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "$(git status --porcelain)" ]; then
        echo "工作区不干净，请先提交改动再发布" >&2
        exit 1
    fi
    if ! npm whoami >/dev/null 2>&1; then
        echo "未登录 npm，请先执行 npm login" >&2
        exit 1
    fi
    npm publish {{args}}

# 启动服务（前台运行，直接读取 .env 提供 CHATGROUP_TOKEN 等配置）
start: ensure-env
    node --env-file=.env dist/main.js

# 若 .env 不存在则从模板生成，并提示先修改令牌
[private]
ensure-env:
    #!/usr/bin/env bash
    if [ ! -f .env ]; then
        cp .env.example .env
        echo "已生成 .env，请先编辑 CHATGROUP_TOKEN 再启动" >&2
        exit 1
    fi

# 健康检查（需服务已启动；端口取 .env 的 CHATGROUP_PORT，默认 3000）
health: ensure-env
    #!/usr/bin/env bash
    set -euo pipefail
    set -a; . ./.env; set +a
    curl --max-time 5 -fsS "http://127.0.0.1:${CHATGROUP_PORT:-3000}/healthz" && echo

# 冒烟测试：MCP initialize 握手（需服务已启动；令牌与端口取自 .env）
smoke: ensure-env
    #!/usr/bin/env bash
    set -euo pipefail
    set -a; . ./.env; set +a
    curl --max-time 5 -fsS -X POST "http://127.0.0.1:${CHATGROUP_PORT:-3000}/mcp" \
        -H "Authorization: Bearer ${CHATGROUP_TOKEN}" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"just-smoke","version":"0.0.0"}}}'
    echo

# 清理构建产物与测试覆盖率
clean:
    rm -rf dist coverage

# 删除 SQLite 数据文件（数据全部丢失、需先停止服务；仅清理默认 CHATGROUP_DB_PATH）
reset-db:
    rm -f data/chatgroup.db data/chatgroup.db-wal data/chatgroup.db-shm
