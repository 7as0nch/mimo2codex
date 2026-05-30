# 快速启用教程

适用场景：你已经把 mimo2codex 接入 Codex，MiMo / DeepSeek 已经能正常聊天和调用普通工具，现在只想启用 `mimo-computer-use` 的电脑控制能力。

## 1. 启用插件

推荐方式：打开 mimo2codex 管理台：

```text
http://127.0.0.1:8788/admin/
```

进入左侧 **插件**，打开 **MiMo Computer Use** 开关。mimo2codex 会热写
`~/.codex/config.toml`，但 Codex CLI / Desktop 需要重启后才会加载新的 MCP
server。

部署环境也可以用统一环境变量锁定：

```bash
MIMO2CODEX_PLUGIN=mimo-computer-use
```

可用值：

- `mimo-computer-use` / `computer-use` / `1` / `on`：启用当前内置 computer use 插件
- `0` / `off` / `none`：禁用所有内置插件

只要设置了 `MIMO2CODEX_PLUGIN`，后台插件页开关会变成只读；不设置时，后台开关可热更新。

## 2. 手动方式：给 Codex 加 MCP server

编辑 `~/.codex/config.toml`，追加：

```toml
[mcp_servers.mimo-computer-use]
command = "node"
args = ["<mimo2codex-install-root>/plugins/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO_COMPUTER_USE_BACKEND = "auto"
```

保存后重启 Codex Desktop。

这不会修改 mimo2codex 的 provider 配置；它只是让 Codex 多启动一个本地 MCP 工具服务。新版 mimo2codex 切模型时会保留 `[mcp_servers.*]` 配置。

## 3. 检测并安装系统 adapter

插件首次使用会先检测第三方 adapter。缺失时会给出清晰诊断；如果你同意安装，
可以直接运行插件内置安装命令，过程会打印进度。

macOS：

```bash
cd <mimo2codex-install-root>/plugins/mimo-computer-use
npm run doctor
npm run install-adapter
```

安装器会调用：

```bash
brew install steipete/tap/peekaboo
```

安装完成后，仍需要在系统设置里授权 Screen Recording 和 Accessibility。

Windows：

```powershell
cd <mimo2codex-install-root>\plugins\mimo-computer-use
npm run doctor
npm run install-adapter
```

安装器优先调用：

```powershell
uv tool install windows-mcp
```

如果只有 `uvx` 可用，会先解析 / 缓存 Windows-MCP，并在运行时使用
`uvx windows-mcp serve`。

可选跨平台后端 Trope CUA：

```toml
[mcp_servers.mimo-computer-use.env]
MIMO_COMPUTER_USE_BACKEND = "trope"
```

## 4. 本地诊断

在仓库里运行：

```bash
cd <mimo2codex-install-root>/plugins/mimo-computer-use
npm run doctor
```

如果 adapter 没装好，会看到类似：

```json
{
  "ok": false,
  "code": "adapter_missing",
  "message": "Peekaboo is not available..."
}
```

这说明插件服务本身是好的，只差系统 adapter 或权限。

也可以直接让 Codex/MiMo 通过 MCP 工具 `computer_install_adapter` 发起安装。
模型应先说明会下载哪个第三方 adapter，再调用安装工具。

## 5. 在 Codex 里测试

新开一个 Codex 对话，说：

```text
Use the mimo-computer-use computer_state tool to inspect the current desktop.
```

或者中文：

```text
调用 mimo-computer-use 的 computer_state 看一下当前桌面状态。
```

成功后，模型会拿到一个文本 JSON 摘要。后续可以继续让它小步操作：

```text
根据 computer_state 的结果，点击搜索框，然后输入 hello。
```

## 注意

- 这个插件不是 OpenAI 服务端的 `computer_use_preview`，而是 Codex 本地 MCP 工具。
- 第一版只暴露 `computer_state`、`computer_click`、`computer_type`、`computer_key`、`computer_scroll`、`computer_wait`。
- `computer_install_adapter` 只用于首次缺 adapter 时下载/安装第三方底座。
- 工具结果只返回文本 JSON 和截图路径，不把图片直接放进 tool output，避免 MiMo / DeepSeek 历史不兼容。
