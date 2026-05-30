# mimo-computer-use 插件详解

`mimo-computer-use` 是 mimo2codex 自带的本地 Codex MCP 插件，用来让 MiMo、
DeepSeek 以及其它兼容 OpenAI function calling 的模型，通过 Codex 的本地工具
机制控制 Windows / macOS 桌面。

它不是 OpenAI 服务端 `computer_use_preview` 协议，也不会改变 mimo2codex 的
Responses API 到 Chat Completions 翻译逻辑。它只是新增一个本地 MCP server，
Codex 启动后会把这些工具作为普通 function tools 暴露给模型。

## 能力范围

第一版暴露的工具保持保守：

- `computer_state`：读取当前桌面 / App / 窗口状态，返回文本 JSON 摘要和可用时的本地截图路径。
- `computer_click`：点击坐标或 adapter 返回的元素目标。
- `computer_type`：输入纯文本。
- `computer_key`：按键或组合键，例如 `Enter`、`Cmd+L`、`Ctrl+C`。
- `computer_scroll`：滚动当前视图或指定坐标附近区域。
- `computer_wait`：等待 UI 稳定。
- `computer_install_adapter`：首次缺少平台 adapter 时，下载 / 安装第三方底座。

MVP 不暴露 shell、文件、注册表、系统设置、进程管理等高风险能力。

## 启用方式

### Admin UI

打开：

```text
http://127.0.0.1:8788/admin/
```

进入左侧 **插件**，打开 **MiMo Computer Use**。mimo2codex 会热写
`~/.codex/config.toml`：

```toml
[mcp_servers.mimo-computer-use]
command = "node"
args = ["<mimo2codex-install-root>/plugins/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO_COMPUTER_USE_BACKEND = "auto"
```

写入后需要重启 Codex CLI / Desktop，新的 MCP server 才会被 Codex 加载。

### 环境变量

部署时可以用统一环境变量锁定插件状态：

```bash
MIMO2CODEX_PLUGIN=mimo-computer-use
```

当前支持值：

- `mimo-computer-use` / `computer-use` / `1` / `on`：启用 computer use 插件
- `0` / `off` / `none`：禁用内置插件

只要设置了 `MIMO2CODEX_PLUGIN`，Admin UI 的插件开关会变成只读。未设置时，
Admin UI 开关可热更新。

## 首次 adapter 检测与安装

插件目录会随 npm 包、桌面端 sidecar、Docker 镜像一起分发；但真正控制桌面的
底层 adapter 来自第三方项目：

- macOS：Peekaboo
- Windows：Windows-MCP
- Trope CUA：预留 experimental shared adapter

检测：

```bash
cd plugins/mimo-computer-use
npm run doctor
```

安装：

```bash
npm run install-adapter
```

安装器行为：

- macOS：执行 `brew install steipete/tap/peekaboo`。安装完成后仍需在系统设置中授予 Screen Recording 和 Accessibility。
- Windows：优先执行 `uv tool install windows-mcp`。如果只有 `uvx`，会解析 / 缓存 Windows-MCP，并在运行时使用 `uvx windows-mcp serve`。
- Linux：第一版不支持。

模型也可以调用 MCP 工具 `computer_install_adapter`。工具要求模型先向用户说明会下载哪个第三方 adapter，再带 `confirm_install=true` 调用。

## mimoskill 集成

`mimoskill/scripts/computer_use_setup.py` 是一个 stdlib-only 包装脚本：

```bash
python3 mimoskill/scripts/computer_use_setup.py
python3 mimoskill/scripts/computer_use_setup.py --install
```

当用户要求 MiMo / Codex 操作电脑时，`mimoskill` 的流程是：

1. 先运行 `computer_use_setup.py` 检测插件和 adapter。
2. 如果返回 `adapter_missing`，说明将安装 Peekaboo 或 Windows-MCP。
3. 运行 `computer_use_setup.py --install`，把安装进度回显给用户。
4. 安装完成后继续调用 `computer_state`，再小步点击 / 输入 / 滚动。

## 命令行、桌面端、Docker

- 命令行 / npm 全局安装：`package.json` 的 `files` 已包含 `plugins/`。
- 桌面端：`scripts/build-sidecar.mjs` 会把 `plugins/` 复制到 sidecar bundle。
- Docker：`Dockerfile` 会复制 `plugins/` 到镜像。

注意：Docker 容器内启用插件，只表示容器里的 Codex 配置可以写入 MCP server。
真实桌面控制仍取决于 MCP server 运行在哪台机器上。常规桌面自动化建议在宿主机
Codex CLI / Desktop 中加载插件。

## 故障排查

- `adapter_missing`：运行 `npm run install-adapter`。
- macOS 权限错误：重新授予 Screen Recording / Accessibility，并重启 Codex。
- Windows 找不到命令：确认 `windows-mcp`、`uv` 或 `uvx` 在 PATH 中；安装后重启终端 / Codex。
- Codex 看不到工具：确认 Admin UI 已启用插件、`~/.codex/config.toml` 有 `[mcp_servers.mimo-computer-use]`，并完全重启 Codex。
- MiMo / DeepSeek tool output 不兼容图片：这是预期设计。插件返回文本 JSON 和本地截图路径，不直接把图片塞进 tool result。
