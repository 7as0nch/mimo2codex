# Windows：只让 Codex CLI 使用 mimo2codex，不改 Codex 桌面应用

<p>
  <a href="./codex-cli-isolated-windows.md">English</a> ·
  <a href="./codex-cli-isolated-windows.zh.md"><strong>简体中文</strong></a>
</p>

这个文档介绍一种 Windows-only 的隔离启动方式：通过 `scripts/codex-mimo-isolated.ps1` 启动 mimo2codex 代理，并让当前 Codex CLI 会话使用独立的 `CODEX_HOME`。

## 适用场景

适合你想要：

- Codex CLI 使用 MiMo/mimo2codex。
- Codex 桌面应用继续使用原来的 OpenAI/ChatGPT 配置。
- 不写入、不覆盖 `%USERPROFILE%\.codex`。
- 不每次手动启动 `mimo2codex`。
- 不每次手动输入 API key。

如果你希望 Codex CLI 和 Codex 桌面应用都全局使用 mimo2codex，请优先使用 Admin Web UI 里的 “Codex 启用”。

## 工作原理

脚本做四件事：

1. 把当前进程的 `CODEX_HOME` 指向 `%USERPROFILE%\.codex-mimo`。
2. 如果隔离目录还没有 `auth.json` / `config.toml`，自动写入最小配置。
3. 检查 `127.0.0.1:8788` 是否已有 mimo2codex 代理监听；没有就后台启动。
4. 启动 Codex CLI，并把参数原样透传给 `codex`。

由于 `CODEX_HOME` 只在脚本进程内设置，默认 `%USERPROFILE%\.codex` 不会被修改，Codex 桌面应用不受影响。

## 前置条件

安装 mimo2codex：

```powershell
npm install -g mimo2codex
```

安装 Codex CLI，并确认 `codex` 在 PATH 中：

```powershell
codex --version
```

准备 API key。推荐使用 mimo2codex 内置 `.env` loader：

```powershell
mimo2codex init
notepad "$env:USERPROFILE\.mimo2codex\.env"
```

在 `.env` 中填入：

```text
MIMO_API_KEY=你的key
MIMO_BASE_URL=https://token-plan-ams.xiaomimimo.com/v1
```

说明：

- `tp-` Token Plan key 通常使用 `token-plan-ams` 这类 Token Plan host。
- `sk-` pay-as-you-go key 按 MiMo 控制台或 mimo2codex 文档说明配置。
- 不要把真实 key 写进 `scripts/codex-mimo-isolated.ps1`。

## 使用方式

在任意项目目录运行：

```powershell
.\scripts\codex-mimo-isolated.ps1
```

脚本会输出类似：

```text
[*] CODEX_HOME:        C:\Users\you\.codex-mimo
[*] mimo2codex API:   http://127.0.0.1:8788/v1
[*] mimo2codex admin: http://127.0.0.1:8788/admin/
```

然后进入 Codex CLI。

## 非交互测试

可以把参数透传给 Codex：

```powershell
.\scripts\codex-mimo-isolated.ps1 exec --json --ephemeral "Reply with exactly: MIMO_OK"
```

如果返回正常，说明：

- Codex CLI 读取的是 `%USERPROFILE%\.codex-mimo`。
- mimo2codex 代理已经监听。
- MiMo key 和 upstream 路由可用。

## 只启动代理和准备配置，不进入 Codex

```powershell
.\scripts\codex-mimo-isolated.ps1 -NoLaunchCodex
```

这个模式适合调试代理启动、查看 admin 页面或验证隔离配置。

## 默认隔离配置

脚本会在 `%USERPROFILE%\.codex-mimo\auth.json` 写入：

```json
{
  "OPENAI_API_KEY": "mimo2codex-local"
}
```

这个值只用于通过 Codex 的本地认证检查。mimo2codex 不校验这个 inbound key，真正的上游 MiMo key 仍来自 `MIMO_API_KEY` 或 `%USERPROFILE%\.mimo2codex\.env`。

脚本会在 `%USERPROFILE%\.codex-mimo\config.toml` 写入：

```toml
model = "mimo-v2.5-pro"
model_provider = "mimo"
model_context_window = 1000000
model_max_output_tokens = 131072

[model_providers.mimo]
name = "MiMo (via mimo2codex)"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 1
```

## 和 Codex Enable 的区别

Admin Web UI 的 “Codex 启用” 会写入默认 Codex 目录：

```text
%USERPROFILE%\.codex\auth.json
%USERPROFILE%\.codex\config.toml
```

这个脚本使用隔离目录：

```text
%USERPROFILE%\.codex-mimo\auth.json
%USERPROFILE%\.codex-mimo\config.toml
```

因此它只影响通过这个脚本启动的 Codex CLI，不影响 Codex 桌面应用。

### 为什么不直接设置 Windows 用户级环境变量？

用户级环境变量会影响所有新终端。这个脚本只影响当前 Codex CLI 会话，更适合“CLI 用 MiMo，桌面版保持原样”的个人工作流。

