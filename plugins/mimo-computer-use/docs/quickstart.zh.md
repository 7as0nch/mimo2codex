# 快速启用教程

适用场景：你已经把 mimo2codex 接入 Codex，MiMo / DeepSeek 已经能正常聊天和调用普通工具，现在只想启用 `mimo-computer-use` 的电脑控制能力。

## 1. 启用插件并安装依赖

打开 mimo2codex 管理台：

```text
http://127.0.0.1:8788/admin/
```

进入左侧 **插件**，打开 **MiMo Computer Use** 开关（mimo2codex 会热写
`~/.codex/config.toml`），再点 **安装依赖**（安装 nut.js）。想要真实桌面发光光标，
就勾选 **「同时下载发光光标运行时（Electron）」**。装完重启 Codex CLI / Desktop。

部署环境也可以用统一环境变量锁定：

```bash
MIMO2CODEX_PLUGIN=mimo-computer-use
```

可用值：`mimo-computer-use` / `computer-use` / `1` / `on` 启用；`0` / `off` / `none` 禁用。

## 2. 手动方式：给 Codex 加 MCP server

编辑 `~/.codex/config.toml`，追加：

```toml
[mcp_servers.mimo-computer-use]
command = "node"
args = ["<mimo2codex-install-root>/plugins/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO2CODEX_ADMIN_URL = "http://127.0.0.1:8788"
```

`MIMO2CODEX_ADMIN_URL` 让插件把操作推送到管理台的 **Computer Use 监看** 页。保存后重启 Codex Desktop。这不会修改 mimo2codex 的 provider 配置。

## 3. 纯 Node，无需编译工具链

桌面控制用 [nut.js](https://nutjs.dev/)（自带预编译原生插件），安装就是一句
`npm install`——**不再需要 Trope CUA、git clone、Xcode 或 .NET 编译**。

```bash
cd <mimo2codex-install-root>/plugins/mimo-computer-use
npm run install-adapter   # npm install → nut.js
npm run doctor            # 检测 nut.js / Electron / 平台 / 权限
```

Electron（可选，用于真实桌面发光光标）体积大，只在你要求时才装——在插件页勾选，或：

```bash
node ./server/index.mjs --install-adapter --with-electron
```

macOS：装完到「系统设置 → 隐私与安全性」给宿主应用（终端 / Codex）授予
「辅助功能」与「屏幕录制」权限。

## 4. 在 Codex 里测试

新开一个 Codex 对话：

```text
调用 mimo-computer-use 的 computer_state 看一下当前屏幕，然后帮我点击某处。
```

- 视觉模型：`computer_state` 直接回传截图图像。
- 纯文本模型：调用时带 `ocr: true`，结果里会有 `targets`（屏幕文字 + 点击坐标），
  再让模型「点击写着 XXX 的目标」。

可在 **Computer Use 监看** 页实时看到 AI 的截图、光标轨迹与操作日志。

## 注意

- 这是 Codex 本地 MCP 工具，不是 OpenAI 服务端的 `computer_use_preview`。
- 暴露 `computer_state`、`computer_click`、`computer_type`、`computer_key`、`computer_scroll`、`computer_wait`、`computer_install_adapter`。
- AI 运行时会接管你的真实鼠标；装了 Electron 时可用悬浮的「停止 AI 控制」按钮或热键 `Ctrl/Cmd+Alt+Esc` 立即停手。
