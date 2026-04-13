# ghcopilot2api

将 GitHub Copilot 封装为 OpenAI 兼容和 Anthropic 兼容接口的本地代理服务，可用于接入现有 AI 客户端、脚本或 Claude Code。

> [!WARNING]
> 这是一个基于逆向分析实现的非官方项目，不代表 GitHub。Copilot 接口、鉴权方式、模型列表和限制策略都可能随时变化。

> [!WARNING]
> 请谨慎、适度使用，避免高频批量请求触发风控、限流或账号异常。
>
> 使用前建议阅读：
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)

> [!IMPORTANT]
> 当前维护仓库为：[https://github.com/yidasanqian/ghcopilot2api](https://github.com/yidasanqian/ghcopilot2api)

如果你已经在使用 [opencode](https://github.com/sst/opencode)，通常不需要这个项目，因为 opencode 已经原生支持 GitHub Copilot provider。

## 为什么使用它

这个项目的目标不是替代官方 SDK，而是把 GitHub Copilot 暴露成更常见的接口协议，方便接入现有生态：

- OpenAI Chat Completions
- OpenAI Models
- OpenAI Embeddings
- Anthropic Messages
- Anthropic Count Tokens

适合以下场景：

- 你已有只支持 OpenAI 或 Anthropic 协议的客户端。
- 你想让 Claude Code 走本地代理。
- 你需要一个可本地运行、可加限速、可手动审批的 Copilot 转发层。
- 你想查看 Copilot 使用量、可用模型和当前 token 状态。

## 功能概览

| 能力               | 说明                                                              |
| ------------------ | ----------------------------------------------------------------- |
| OpenAI 兼容接口    | 支持 `/v1/chat/completions`、`/v1/models`、`/v1/embeddings` |
| Anthropic 兼容接口 | 支持 `/v1/messages`、`/v1/messages/count_tokens`              |
| Claude Code 集成   | 支持 `--claude-code` 生成启动环境变量命令                       |
| 用量查看           | 支持 `/usage` 接口和独立 Usage Viewer 页面                      |
| 风控缓冲           | 支持 `--manual`、`--rate-limit`、`--wait`                   |
| 多账户类型         | 支持 `individual`、`business`、`enterprise`                 |
| 鉴权方式           | 支持设备码登录，也支持直接注入 GitHub token                       |
| 调试辅助           | 支持 `auth`、`check-usage`、`debug` 子命令                  |

## Demo

https://github.com/user-attachments/assets/7654b383-669d-4eb9-b23c-06d7aefee8c5

## 快速开始

### 前置要求

- 一个已开通 GitHub Copilot 的 GitHub 账号
- 本地开发建议使用 Bun 1.2+

### 方式一：直接运行已发布 CLI

首次启动时，如果本地没有 GitHub token，程序会自动进入设备码登录流程。

```sh
npx ghcopilot2api@latest start
```

自定义端口：

```sh
npx ghcopilot2api@latest start --port 8080
```

只执行认证，不启动服务：

```sh
npx ghcopilot2api@latest auth
```

### 方式二：从源码运行

```sh
bun install
bun run dev
```

生产模式：

```sh
bun run build
bun run start
```

Windows 下也可以直接运行 [start.bat](start.bat)，它会自动打开 Usage Viewer 页面。

## 启动后如何验证

服务默认监听 `http://127.0.0.1:4141`。

先看模型列表：

```sh
curl http://127.0.0.1:4141/v1/models
```

再发一个最小 OpenAI 兼容请求。这个代理默认不校验客户端传入的 Bearer Token，所以示例里用 `dummy` 即可；很多客户端只要求字段存在，不要求服务端校验。

```sh
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy" \
  -d '{
    "model": "替换为 /v1/models 返回的模型 ID",
    "messages": [
      { "role": "user", "content": "你好，简单介绍一下你自己。" }
    ]
  }'
```

Anthropic 兼容请求示例：

```sh
curl http://127.0.0.1:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "替换为 /v1/models 返回的模型 ID",
    "max_tokens": 256,
    "messages": [
      { "role": "user", "content": "用一句话解释 Bun 是什么。" }
    ]
  }'
```

## 兼容接口

### OpenAI 兼容

| 方法 | 路径                     | 说明               |
| ---- | ------------------------ | ------------------ |
| POST | `/v1/chat/completions` | 聊天补全           |
| GET  | `/v1/models`           | 获取可用模型       |
| POST | `/v1/embeddings`       | 获取文本 embedding |

同时还提供不带 `v1` 前缀的兼容路径：

- `/chat/completions`
- `/models`
- `/embeddings`

### Anthropic 兼容

| 方法 | 路径                          | 说明          |
| ---- | ----------------------------- | ------------- |
| POST | `/v1/messages`              | Messages API  |
| POST | `/v1/messages/count_tokens` | 计算 token 数 |

### 扩展接口

| 方法 | 路径       | 说明                              |
| ---- | ---------- | --------------------------------- |
| GET  | `/usage` | 返回 Copilot 用量与配额快照       |
| GET  | `/token` | 返回当前 Copilot token            |
| GET  | `/`      | 健康检查，返回 `Server running` |

## 常用命令

### start

```sh
npx ghcopilot2api@latest start [options]
```

| 参数                       | 说明                                                   | 默认值         |
| -------------------------- | ------------------------------------------------------ | -------------- |
| `--port`, `-p`         | 监听端口                                               | `4141`       |
| `--verbose`, `-v`      | 输出详细日志                                           | `false`      |
| `--account-type`, `-a` | 账户类型：`individual`、`business`、`enterprise` | `individual` |
| `--manual`               | 每次请求前手动确认                                     | `false`      |
| `--rate-limit`, `-r`   | 请求间隔限速，单位秒                                   | 无             |
| `--wait`, `-w`         | 命中限速后等待而不是报错                               | `false`      |
| `--github-token`, `-g` | 直接传入 GitHub token                                  | 无             |
| `--claude-code`, `-c`  | 生成 Claude Code 配置命令                              | `false`      |
| `--show-token`           | 输出 GitHub/Copilot token，便于排障                    | `false`      |
| `--proxy-env`            | 按环境变量初始化代理，主要用于 Node/undici 场景        | `false`      |

### 其它子命令

```sh
npx ghcopilot2api@latest auth
npx ghcopilot2api@latest check-usage
npx ghcopilot2api@latest debug
npx ghcopilot2api@latest debug --json
```

## 认证与数据目录

默认会把 GitHub token 持久化到本机目录：

```text
~/.local/share/copilot-api/github_token
```

认证方式为 GitHub 设备码登录：

1. 启动 `start` 或单独运行 `auth`
2. 终端会提示设备码和验证地址
3. 浏览器完成授权
4. token 写入本地目录，后续启动可复用

如果你已经有可用 token，也可以直接通过 `--github-token` 或 Docker 中的 `GH_TOKEN` 注入。

## Docker 与部署

### 构建镜像

```sh
docker build -t ghcopilot2api .
```

### 快速试跑

如果你已经有可用的 GitHub token，可以直接注入环境变量启动容器：

```sh
docker run -p 127.0.0.1:4141:4141 \
  -e GH_TOKEN=your_github_token \
  -v ${PWD}/copilot-data:/root/.local/share/copilot-api \
  ghcopilot2api
```

需要日志落盘时：

```sh
docker run -p 127.0.0.1:4141:4141 \
  -e GH_TOKEN=your_github_token \
  -e LOG_FILE=/var/log/copilot-api/copilot-api.log \
  -e LOG_FILE_MAX_SIZE=100m \
  -e LOG_FILE_MAX_FILES=5 \
  -v ${PWD}/copilot-data:/root/.local/share/copilot-api \
  -v ${PWD}/logs:/var/log/copilot-api \
  ghcopilot2api
```

这里把端口绑定到 `127.0.0.1`，避免容器服务被宿主机外部直接访问；如果你确实要对外暴露，再通过反向代理或防火墙规则单独放开。

### 推荐目录

长期运行时建议至少持久化这两个目录：

- `./copilot-data`：保存 GitHub 登录状态和 token 文件
- `./logs`：保存容器标准输出镜像日志

```sh
mkdir -p ./copilot-data ./logs
```

### 一次性认证容器

如果你不想把 `GH_TOKEN` 放进环境变量，可以先跑一次认证流程，把登录状态写入挂载卷：

```sh
docker run --rm -it \
  -v ${PWD}/copilot-data:/root/.local/share/copilot-api \
  ghcopilot2api --auth
```

认证完成后，后续启动容器时即使不传 `GH_TOKEN`，也能复用卷里的本地状态。

### Docker Compose

仓库提供了 [docker-compose.example.yml](docker-compose.example.yml) 示例，适合长期运行。推荐流程如下：

1. 复制 [docker-compose.example.yml](docker-compose.example.yml) 为本地的 `docker-compose.yml`，或直接使用仓库中的本地 Compose 文件
2. 复制 [.env.example](.env.example) 为 `.env`
3. 在 `.env` 中填写 `GH_TOKEN`，或者留空后改用一次性认证容器
4. 执行 `docker compose up -d --build`
5. 用 `docker compose logs -f copilot-api` 跟踪启动日志

Docker Compose 会自动读取项目根目录下的 `.env`。你可以直接从示例生成：

```sh
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

推荐的 `.env` 内容如下：

```dotenv
GH_TOKEN=
LOG_FILE=/var/log/copilot-api/copilot-api.log
LOG_FILE_MAX_SIZE=100m
LOG_FILE_MAX_FILES=5
HTTP_PROXY=
HTTPS_PROXY=
ALL_PROXY=
NO_PROXY=localhost,127.0.0.1,::1
```

变量说明：

- `GH_TOKEN`：可选，直接注入 GitHub token；如果使用一次性认证容器并持久化 `copilot-data`，可以留空。
- `LOG_FILE`：容器内日志落盘路径，需配合 `./logs` 挂载目录。
- `LOG_FILE_MAX_SIZE`：单个日志文件最大大小，支持纯字节数或 `k`/`m`/`g` 后缀，默认 `100m`；设置为 `0` 可关闭自动轮转。
- `LOG_FILE_MAX_FILES`：日志轮转时最多保留的历史文件数量，默认 `5`。
- `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`：出站代理配置，按需填写。

推荐配置如下：

```yaml
services:
  copilot-api:
    build:
      context: .
    container_name: ghcopilot2api
    ports:
      - "127.0.0.1:4141:4141"
    environment:
      GH_TOKEN: ${GH_TOKEN:-}
      LOG_FILE: /var/log/copilot-api/copilot-api.log
      LOG_FILE_MAX_SIZE: ${LOG_FILE_MAX_SIZE:-100m}
      LOG_FILE_MAX_FILES: ${LOG_FILE_MAX_FILES:-5}
      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      ALL_PROXY: ${ALL_PROXY:-}
      NO_PROXY: ${NO_PROXY:-localhost,127.0.0.1,::1}
    volumes:
      - ./copilot-data:/root/.local/share/copilot-api
      - ./logs:/var/log/copilot-api
    restart: unless-stopped
```

启用后会在 `./logs` 下保留当前文件 `copilot-api.log`，并滚动生成 `copilot-api.log.1`、`copilot-api.log.2` 这类历史文件，便于直接在宿主机查看。

### 两种部署鉴权方式

#### 方式一：环境变量注入

适合已有可控 secret 管理系统的环境，比如 CI/CD、PaaS、容器编排平台。

- 优点：启动简单，部署自动化方便
- 注意：不要把 `GH_TOKEN` 明文写进仓库里的 Compose 文件

#### 方式二：挂载卷持久化登录状态

适合个人服务器、NAS 或长期运行的单机服务。

- 优点：不需要把 token 明文放进 Compose
- 注意：`copilot-data` 目录需要妥善备份并限制权限

### 生产部署建议

- 默认只绑定到 `127.0.0.1` 或内网地址，把公网入口交给 Nginx、Caddy 或云负载均衡。
- 把鉴权、HTTPS、访问控制放在反向代理层，不要把当前服务直接裸露到公网。
- 不要把 `GH_TOKEN` 提交进 `docker-compose.yml`、日志或截图。
- 为 `copilot-data` 和 `logs` 做持久化，避免容器重建后丢失认证状态与运行记录。
- 用 `/` 做容器健康探针，用 `/usage` 做运行状态观察。
- 升级时优先执行 `docker compose up -d --build`，确认日志无异常后再切流。

## Claude Code 集成

### 方式一：让程序生成配置命令

```sh
npx ghcopilot2api@latest start --claude-code
```

程序会让你选择主模型和小模型，并将 Claude Code 需要的环境变量命令复制到剪贴板。

### 方式二：手动配置

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_MODEL": "claude-sonnet-4.6",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "DISABLE_TELEMETRY": "1"
  },
  "includeCoAuthoredBy": false,
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

更多说明可参考：

- [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)
- [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Usage Viewer

服务启动后，终端会打印一个可视化面板地址，例如：

```text
https://yidasanqian.github.io/ghcopilot2api?endpoint=http://localhost:4141/usage
```

它会读取 `/usage` 接口，展示：

- Chat / Completions / Premium 等配额使用情况
- Copilot 套餐类型
- 配额重置时间
- 原始 JSON 数据

## 运行建议

- 如果你担心触发风控，优先使用 `--manual`、`--rate-limit` 和 `--wait`。
- 如果你使用的是 Business 或 Enterprise 账户，记得显式设置 `--account-type`。
- 先通过 `/v1/models` 获取模型列表，不要在客户端里硬编码模型名。
- 对 Anthropic `count_tokens` 的结果要按“兼容估算”理解，不要把它当作官方精确计费值。

## 安全说明

这个项目默认更适合本机开发或受信任内网，不适合直接裸露到公网。原因包括：

- 服务端默认不校验客户端传入的 API Key 或 Bearer Token。
- `/token` 会直接返回当前 Copilot token。
- 服务默认启用 CORS。

如果你必须对外提供服务，至少应额外加上：

- 反向代理层鉴权
- IP 白名单或内网隔离
- HTTPS
- 日志与访问审计
- 关闭或限制 `/token` 的访问

## 开发

```sh
bun install
bun run build
bun run lint
bun run test
```

单测示例：

```sh
bun test tests/anthropic-request.test.ts
```

## 排障

### 看本地状态

```sh
npx ghcopilot2api@latest debug
```

JSON 输出：

```sh
npx ghcopilot2api@latest debug --json
```

### 常见问题

- 启动后要求登录：说明本地还没有持久化 GitHub token，按设备码流程完成一次授权即可。
- 请求被限速或失败：尝试降低并发，配合 `--rate-limit` 与 `--wait`。
- 模型不可用：先访问 `/v1/models`，确认当前账号下真正可用的模型。
- 容器重启后丢登录：确认是否挂载了 `copilot-data` 目录。

## License

[MIT](LICENSE)
