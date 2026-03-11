# Copilot API Proxy

> [!WARNING]
> 这是一个基于逆向分析实现的 GitHub Copilot API 代理，并非 GitHub 官方项目。接口、鉴权方式或行为都可能随时变化，请自行承担使用风险。

> [!WARNING]
> GitHub 可能会对高频、批量或自动化程度过高的 Copilot 请求触发风控。
> 过度使用可能导致告警、限流，严重时甚至造成 Copilot 权限临时受限。
>
> 使用前请务必阅读：
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> 请谨慎、适度使用，避免对 GitHub 基础设施造成异常压力。

> [!IMPORTANT]
> 当前维护仓库：<https://github.com/yidasanqian/ghcopilot2api>
>
> 原上游仓库已不再维护，本仓库文档与元数据已切换为当前维护地址。

---

如果你正在使用 [opencode](https://github.com/sst/opencode)，通常不需要这个项目，因为 opencode 已经原生支持 GitHub Copilot provider。

## 项目简介

这是一个将 GitHub Copilot 封装为 OpenAI 兼容接口与 Anthropic 兼容接口的代理服务。你可以把它接到支持以下协议的工具中：

- OpenAI Chat Completions API
- OpenAI Models API
- OpenAI Embeddings API
- Anthropic Messages API

因此它也可以作为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 的后端使用。

## 功能特性

- OpenAI 兼容接口：支持 /v1/chat/completions、/v1/models、/v1/embeddings。
- Anthropic 兼容接口：支持 /v1/messages 与 /v1/messages/count_tokens。
- Claude Code 集成：可通过 --claude-code 快速生成启动命令。
- 用量面板：支持查看 Copilot 配额、使用情况与原始统计数据。
- 速率控制：支持 --rate-limit 与 --wait，降低触发风控和报错的概率。
- 手动审批：支持 --manual，对每次请求进行确认。
- 调试辅助：支持 --show-token 输出令牌刷新信息，便于排障。
- 灵活鉴权：既支持交互式登录，也支持直接传入 GitHub Token。
- 多账户类型：支持 individual、business、enterprise 三类 Copilot 账户。

## 演示

https://github.com/user-attachments/assets/7654b383-669d-4eb9-b23c-06d7aefee8c5

## 环境要求

- Bun 1.2.x 或更高版本
- 一个已开通 GitHub Copilot 的 GitHub 账号

## 安装

```sh
bun install
```

## Docker 使用方式

构建镜像：

```sh
docker build -t copilot-api .
```

运行容器：

```sh
# 在宿主机创建目录，用于持久化 GitHub Token 及相关状态
mkdir -p ./copilot-data

# 挂载到容器内，避免容器重启后重新登录
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

说明：宿主机上的 copilot-data 会映射到容器中的 /root/.local/share/copilot-api，用于持久化认证信息。

### 通过环境变量传入 Token

```sh
# 构建时传入 GitHub Token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# 运行时传入 GitHub Token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# 运行并附加额外参数
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api start --verbose --port 4141
```

### Docker Compose 示例

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

当前 Docker 镜像包含以下特性：

- 多阶段构建，减小镜像体积
- 非 root 用户运行，增强安全性
- 健康检查，便于容器编排系统监控
- 固定基础镜像版本，提高可复现性

## 使用 npx 运行

直接启动：

```sh
npx copilot-api@latest start
```

指定端口：

```sh
npx copilot-api@latest start --port 8080
```

仅执行认证：

```sh
npx copilot-api@latest auth
```

## 命令结构

项目提供以下子命令：

- start：启动 API 服务；如有需要，也会自动执行认证流程。
- auth：仅执行 GitHub 登录认证，不启动服务。
- check-usage：在终端中直接查看 Copilot 配额与用量。
- debug：输出版本、运行时、路径、认证状态等调试信息。

## 命令行参数

### start

| 参数 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --port | 监听端口 | 4141 | -p |
| --verbose | 启用详细日志 | false | -v |
| --account-type | 账户类型，可选 individual、business、enterprise | individual | -a |
| --manual | 启用手动审批 | false | 无 |
| --rate-limit | 请求间隔限速，单位秒 | 无 | -r |
| --wait | 限速命中时等待，而不是直接报错 | false | -w |
| --github-token | 直接传入 GitHub Token，通常需先通过 auth 生成 | 无 | -g |
| --claude-code | 生成 Claude Code 启动配置命令 | false | -c |
| --show-token | 登录、刷新时输出 GitHub/Copilot Token | false | 无 |
| --proxy-env | 从环境变量初始化代理 | false | 无 |

### auth

| 参数 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --verbose | 启用详细日志 | false | -v |
| --show-token | 登录时显示 GitHub Token | false | 无 |

### debug

| 参数 | 说明 | 默认值 | 别名 |
| --- | --- | --- | --- |
| --json | 以 JSON 格式输出调试信息 | false | 无 |

## API 接口

服务同时暴露 OpenAI 兼容接口与 Anthropic 兼容接口。

### OpenAI 兼容接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| /v1/chat/completions | POST | 根据聊天上下文生成回复 |
| /v1/models | GET | 获取当前可用模型列表 |
| /v1/embeddings | POST | 为输入文本生成向量嵌入 |

### Anthropic 兼容接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| /v1/messages | POST | 根据消息上下文生成回复 |
| /v1/messages/count_tokens | POST | 计算消息对应的 token 数 |

### 用量监控接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| /usage | GET | 获取 Copilot 用量、配额与统计信息 |
| /token | GET | 获取当前服务使用的 Copilot Token |

## 常用示例

```sh
# 基础启动
npx copilot-api@latest start

# 自定义端口并启用详细日志
npx copilot-api@latest start --port 8080 --verbose

# 使用 business 账户
npx copilot-api@latest start --account-type business

# 使用 enterprise 账户
npx copilot-api@latest start --account-type enterprise

# 每次请求都手动确认
npx copilot-api@latest start --manual

# 两次请求之间至少间隔 30 秒
npx copilot-api@latest start --rate-limit 30

# 触发限速时等待，而不是报错
npx copilot-api@latest start --rate-limit 30 --wait

# 直接传入 GitHub Token
npx copilot-api@latest start --github-token ghp_YOUR_TOKEN_HERE

# 仅认证
npx copilot-api@latest auth

# 认证时输出详细日志
npx copilot-api@latest auth --verbose

# 在终端查看用量
npx copilot-api@latest check-usage

# 输出调试信息
npx copilot-api@latest debug

# 以 JSON 输出调试信息
npx copilot-api@latest debug --json

# 从 HTTP_PROXY / HTTPS_PROXY 等环境变量初始化代理
npx copilot-api@latest start --proxy-env
```

## 用量面板

服务启动后，控制台会打印 Copilot Usage Dashboard 的访问地址。

1. 启动服务：

```sh
npx copilot-api@latest start
```

2. 控制台会输出类似下面的地址：

```text
https://yidasanqian.github.io/ghcopilot2api?endpoint=http://localhost:4141/usage
```

如果你使用 Windows 下的 start.bat，这个页面会自动打开。

面板支持：

- 通过 URL 参数预填 /usage 接口地址。
- 点击 Fetch 拉取或刷新数据。
- 以进度条形式展示 Chat、Completions 等配额使用情况。
- 查看完整原始 JSON，便于进一步排查。
- 切换到任意兼容接口地址，例如：

```text
https://yidasanqian.github.io/ghcopilot2api?endpoint=http://your-api-server/usage
```

## 与 Claude Code 配合使用

这个代理可以作为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的后端。

### 方式一：通过 --claude-code 交互生成配置

```sh
npx copilot-api@latest start --claude-code
```

执行后会提示你选择主模型与一个用于后台任务的小模型。完成后，程序会把 Claude Code 所需的环境变量命令复制到剪贴板。

### 方式二：手动写入 .claude/settings.json

你也可以在项目根目录创建 .claude/settings.json，固定 Claude Code 的运行配置。例如：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

更多配置说明可参考：

- [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)
- [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## 从源码运行

开发模式：

```sh
bun run dev
```

生产模式：

```sh
bun run start
```

## 使用建议

- 如果你担心触发 GitHub Copilot 风控，优先考虑 --manual、--rate-limit 和 --wait。
- 如果客户端本身没有自动重试能力，建议将 --rate-limit 与 --wait 配合使用。
- 如果你使用的是 GitHub Copilot Business 或 Enterprise，记得显式指定 --account-type。
- 如需了解企业网络路由相关配置，可参考 GitHub 官方文档：
  [Copilot subscription-based network routing](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization)
