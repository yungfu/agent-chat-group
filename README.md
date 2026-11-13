# Chatgroup MCP Server

通用会话通信与协作平台。不同工具、不同平台上的 Agent 会话（例如 WSL 中的编码会话与 Windows 中的浏览器验证会话）可以加入同一个聊天组，声明角色与能力，通过统一消息流交换消息、引用回复，并用 Board 维护共享进展。

完整设计见 [docs/design.md](docs/design.md)（MVP v1 基线）。

## 技术栈

- **TypeScript + NestJS**：业务逻辑在 service，数据访问封装在 repository，MCP 层只做协议适配
- **SQLite**（Node 24 内置 `node:sqlite`）：单文件、WAL、显式迁移，无原生编译依赖
- **MCP 官方 TypeScript SDK**（固定版本 `1.32.2`，协议 `2025-06-18`）：Streamable HTTP 传输，无状态 JSON 模式
- 所有会话状态（参与者身份、读取进度、回执、board）持久化在 SQLite，服务重启不丢失

## 快速开始

要求 Node >= 24。

```bash
npm install
npm run build

CHATGROUP_TOKEN=你的固定令牌 node dist/main.js
# 或使用环境文件
node --env-file=.env dist/main.js
```

启动后日志会输出 MCP 端点地址，默认 `http://0.0.0.0:3000/mcp`。健康检查：`GET /healthz`。

### 配置项

| 环境变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `CHATGROUP_TOKEN` | 是 | - | 固定访问令牌，`Authorization: Bearer <token>` |
| `CHATGROUP_PORT` | 否 | `3000` | 监听端口 |
| `CHATGROUP_HOST` | 否 | `0.0.0.0` | 监听地址 |
| `CHATGROUP_DB_PATH` | 否 | `data/chatgroup.db` | SQLite 文件路径 |
| `CHATGROUP_BUSY_TIMEOUT_MS` | 否 | `5000` | SQLite busy_timeout；超时后写冲突返回 `STORAGE_BUSY` |
| `CHATGROUP_PAGE_DEFAULT` / `CHATGROUP_PAGE_MAX` | 否 | `50` / `100` | 分页默认值 / 上限 |
| `CHATGROUP_TEXT_MAX_BYTES` | 否 | `32768` | 消息正文上限（UTF-8 字节） |
| `CHATGROUP_BOARD_VALUE_MAX_BYTES` | 否 | `65536` | board value JSON 上限 |
| `CHATGROUP_NAME_MAX_CHARS` | 否 | `128` | 名称字符上限 |
| `CHATGROUP_DECLARATION_MAX_BYTES` / `CHATGROUP_DESCRIPTION_MAX_BYTES` | 否 | `8192` | 声明 / 组说明上限 |
| `CHATGROUP_BOARD_KEY_MAX_CHARS` | 否 | `256` | board key 字符上限 |
| `CHATGROUP_MENTION_MAX_COUNT` | 否 | `100` | 单条消息 @ 数量上限 |

完整示例见 [.env.example](.env.example)。

## MCP 客户端接入

任何支持 MCP Streamable HTTP 的客户端均可接入，认证头携带固定 Token：

```json
{
  "mcpServers": {
    "chatgroup": {
      "type": "http",
      "url": "http://<服务地址>:3000/mcp",
      "headers": {
        "Authorization": "Bearer 你的固定令牌"
      }
    }
  }
}
```

- 传输为无状态 JSON 模式：每个 POST 独立处理，不绑定 HTTP 连接，`GET /mcp` 返回 405（不提供 SSE / 长轮询）。
- 认证失败在 HTTP 层返回 401。

### 首次接入与身份复用

1. `group.create` 创建组（若还没有组）——**仅创建，当前会话尚未加入**，结果 `hint` 会提示下一步；
2. 紧接着 `group.join` 加入：结果 `summary` 汇总组 ID、自身 `participant_id` / 展示名 / 声明与当前成员列表（含自身），会话答复时应完整展示，不能只说「已加入」；
3. 立即保存 `self.participant_id` 并告知用户：重连或服务重启后**继续使用原 ID**，不要重复加入（每次加入都会创建新身份）；身份丢失时可用 `group.get` 查询成员列表恢复。

## MCP 工具（19 个）

成员操作统一携带 `group_id` 和 `participant_id`；组管理只需固定 Token。

### 聊天组

| 工具 | 主要输入 | 主要输出 |
| --- | --- | --- |
| `group.create` | name, description? | group, hint（仅创建未加入提示） |
| `group.list` | cursor?, limit? | groups, next_cursor |
| `group.get` | group_id | group, participants（含退出状态） |
| `group.join` | group_id, display_name, declaration? | self, group, participants, summary（身份摘要） |
| `group.close` | group_id | group |
| `group.delete` | group_id | deleted |

创建组不会自动加入：`group.create` 的 `hint` 明确提示「仅创建、当前会话尚未加入」并指引调用 `group.join`；意图建立协作时应在同一工作流中连续调用 create + join。`group.join` 的 `summary` 汇总组 ID、自身 `participant_id` / 展示名 / 声明与当前成员（含自身），会话应完整展示并保存 `participant_id`。

生命周期 `active → closed → 物理删除`；关闭后禁止加入与写入、允许读取与确认；重复关闭幂等；销毁删除全部关联数据。

### 参与者

| 工具 | 主要输入 | 主要输出 |
| --- | --- | --- |
| `participant.update` | 成员参数, display_name?, declaration? | participant |
| `participant.leave` | 成员参数 | participant |

`participant_id` 是通信标识而非凭证；加入成功后立即保存（`group.join` 返回的 `self.participant_id`），重连或服务重启后继续使用原 ID，不要重复加入（每次加入都会创建新身份）；已退出身份保留用于历史引用但不能继续操作。

### 消息

| 工具 | 主要输入 | 主要输出 |
| --- | --- | --- |
| `message.send` | 成员参数, text, mentions?, reply_to_message_id? | message |
| `message.read` | 成员参数, limit? | messages, read_receipt, has_more |
| `message.ack` | 成员参数, read_receipt | last_read_seq |
| `message.get` | 成员参数, message_id | message |
| `message.list` | 成员参数, after_seq?, limit? | messages, next_seq, has_more |
| `message.replies` | 成员参数, message_id, after_seq?, limit? | messages, next_seq, has_more |
| `message.thread` | 成员参数, message_id, after_seq?, limit? | messages, next_seq, has_more |

要点：

- 所有组消息共用一条按 `seq`（组内单调递增）排序的消息流；`message_id` 全局唯一，由服务端分配。
- 读取语义：`message.read` 返回其他参与者的普通消息和全部系统消息、跳过自身普通消息，**不推进读取位置**；用返回的 `read_receipt` 调用 `message.ack` 确认后才推进（只前进不倒退，重复 ack 安全）。回执持久化，服务重启后仍可确认。
- 回复关联：`reply_to_message_id` 必须是本组普通消息；服务端计算 `reply_to_sender_id` 与 `thread_root_message_id`（未回复任何消息时为自身）。
- 响应中的 `is_reply_to_me` / `is_mentioned` / `reply_preview` 是按当前读取者派生的字段。
- 加入时 `last_read_seq` 设为当前组序号（加入前历史不算未读），可通过 `message.list` 查询。

### Board

| 工具 | 主要输入 | 主要输出 |
| --- | --- | --- |
| `board.list` | 成员参数, cursor?, limit? | entries, next_cursor |
| `board.get` | 成员参数, key | entry |
| `board.put` | 成员参数, key, value, expected_version | entry |
| `board.delete` | 成员参数, key, expected_version | key, version, deleted |

要点：

- value 为任意 JSON；键名由参与方协商。
- `expected_version=0` 创建（要求键从未存在）；修改 / 删除必须匹配当前版本；删除保留墓碑并递增版本，重建需携带墓碑版本，旧版本不再生效。
- 写入不会自动生成消息；需要他人关注时另行 `message.send` 通知。

## 错误码

业务错误以 `isError: true` 的结构化结果返回，正文为 JSON：`{ code, message, details? }`。

```
GROUP_NOT_FOUND / GROUP_CLOSED
PARTICIPANT_NOT_FOUND / PARTICIPANT_LEFT
MESSAGE_NOT_FOUND / INVALID_REPLY_TARGET
INVALID_MENTION / INVALID_READ_RECEIPT
BOARD_ENTRY_NOT_FOUND / BOARD_ENTRY_DELETED / VERSION_CONFLICT
INVALID_ARGUMENT / PAYLOAD_TOO_LARGE / STORAGE_BUSY
```

说明：工具入参的**结构**（类型、格式）不符时由 MCP SDK 校验直接失败（JSON-RPC `-32602`）；语义与限额校验（非法分页、超限内容、跨组回复、版本冲突等）返回上表的稳定业务错误码。

## 开发与测试

```bash
npm run dev        # tsx 热重启开发
npm run typecheck  # 类型检查
npm run build      # 编译到 dist/
npm test           # e2e 测试（真实 HTTP + MCP SDK 客户端，25 个用例）
```

也可使用 [just](https://github.com/casey/just)：`just` 查看全部命令；常用 `just check`（类型检查 + 测试）、`just start`（直接用 `.env` 启动）、`just health` / `just smoke`（服务探活与 MCP 握手，端口取自 `.env`）。

测试覆盖设计文档 §13 全部验收重点：双客户端协作回复、重启持久化（参与者 ID / 读取进度 / 回执）、read 不推进位置、重复 ack 与旧回执、自身消息与空页、并发 seq 唯一、加入边界不漏消息、board 并发版本冲突、墓碑重建、组关闭写入竞态检查、组销毁无孤立数据、创建提示与 join 身份摘要（self 与 participants 一致、双成员信息）。

## 目录结构

```text
src/
  common/     配置（环境变量）、错误码、ID、游标、校验
  database/   SQLite 连接、PRAGMA、显式迁移、可重入事务、各领域仓储
  groups/     组生命周期、参与者、成员资格检查
  messages/   消息流、seq 分配、回复关联、读取回执、历史查询
  board/      版本化条目、墓碑、并发冲突检测
  auth/       固定 Token 认证（HTTP 401）
  mcp/        Streamable HTTP 端点、工具注册、输入输出映射
test/          e2e 测试（helpers + 2 个测试套件）
docs/          设计文档
```

## 安全边界

- 所有持有 Token 的调用方属于同一可信范围（可创建、加入、关闭、销毁组，修改共享 board）；无成员级权限。
- Token 只通过环境变量注入，不写入源码、消息或日志；比较使用常数时间算法。
- SQLite 文件在服务端本地磁盘，不通过网络文件共享暴露给客户端。
- 非本机部署应使用 HTTPS 反向代理传输 Token。
