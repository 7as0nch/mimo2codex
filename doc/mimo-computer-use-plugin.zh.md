# mimo-computer-use 插件详解

`mimo-computer-use` 是 mimo2codex 自带的本地 Codex MCP 插件，用来让 MiMo、
DeepSeek 以及其它兼容 OpenAI function calling 的模型，通过 Codex 的本地工具
机制控制桌面（macOS / Windows）。

它是**纯 Node** 实现：桌面控制由 [nut.js](https://nutjs.dev/) 驱动（鼠标、键盘、
截图），nut.js 自带预编译原生插件，安装就是一句 `npm install`——**不再需要
Trope CUA、git clone、Xcode 或 .NET 编译工具链**。

它不是 OpenAI 服务端 `computer_use_preview` 协议，也不会改变 mimo2codex 的
Responses → Chat Completions 翻译逻辑。它只新增一个本地 MCP server，Codex
启动后把这些工具作为普通 function tools 暴露给模型，因此任何会函数调用的模型都能用。

## 能力范围

- `computer_state`：截图 + 屏幕尺寸 + `scale`；带 `ocr:true` 时附带可点击的文字 `targets`（文字 + 坐标）。
- `computer_click`：把光标平滑移到 `x/y`（或 `target` 文字，经 OCR 匹配）再点击。
- `computer_type`：输入纯文本。
- `computer_key`：按键 / 组合键，例如 `Enter`、`Cmd+L`、`Ctrl+C`、`Alt+Tab`。
- `computer_scroll`：滚动视图。
- `computer_wait`：等待 UI 稳定（内部处理）。
- `computer_install_adapter`：安装纯 Node 依赖（nut.js；可选 Electron 发光光标）。

不暴露 shell、文件、注册表、系统设置、进程管理等高风险能力。

## 两种感知方式（A+C）

- **视觉模型**：`computer_state` 把截图作为 MCP 图像块回传，模型看图选坐标。
- **纯文本模型**：调用时带 `ocr: true`，结果里附带 `targets`——屏幕文字 + 点击坐标
  （经 `mimoskill/scripts/ocr.py --boxes`，tesseract，本地离线）。模型「点击写着
  XXX 的目标」，`computer_click` 自动映射到坐标。

## 启用方式

### Admin UI

打开 `http://127.0.0.1:8788/admin/` → 左侧 **插件**，打开 **MiMo Computer Use**，
再点 **安装依赖**（安装 nut.js）。mimo2codex 会热写 `~/.codex/config.toml`：

```toml
[mcp_servers.mimo-computer-use]
command = "node"
args = ["<mimo2codex-install-root>/plugins/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO2CODEX_ADMIN_URL = "http://127.0.0.1:8788"
```

`MIMO2CODEX_ADMIN_URL` 让插件把操作推送到 Admin 的 **Computer Use 监看** 页。
写入后需重启 Codex CLI / Desktop。

### 环境变量

部署时可用 `MIMO2CODEX_PLUGIN=mimo-computer-use` 锁定（值同前：`computer-use`/`1`/`on`
启用，`0`/`off`/`none` 禁用）。设置后 Admin 插件开关只读。

## 安装依赖（纯 Node，无需工具链）

```bash
cd plugins/mimo-computer-use
npm run install-adapter      # npm install → nut.js
npm run doctor               # 检测 nut.js / Electron / 平台 / 权限
```

Electron（可选，真实桌面发光光标）体积大，只在你要求时才装——在插件页勾选
**「同时下载发光光标运行时（Electron）」**，或：

```bash
node ./server/index.mjs --install-adapter --with-electron
```

macOS：装完到「系统设置 → 隐私与安全性」给宿主应用（终端 / Codex）授予「辅助功能」
与「屏幕录制」权限。

模型也可调用 MCP 工具 `computer_install_adapter`（需先向用户说明会下载依赖，再带
`confirm_install=true`）。

## 发光光标 overlay（可选 Electron）

装了 Electron 后，插件会拉起一个透明、点击穿透、置顶的 overlay 窗口，AI 操作时在
真实桌面画发光青色光标 + 点击波纹，并提供可拖动的「停止 / 恢复 AI 控制」按钮和全局
热键 `Ctrl/Cmd+Alt+Esc`（按下即刻阻止后续动作）。不装 Electron 也能用——只是真实桌面
上看不到发光光标，但仍可在 **Computer Use 监看** 页查看。

## mimoskill 集成

`mimoskill/scripts/computer_use_setup.py`（stdlib-only 包装脚本）：

```bash
python3 mimoskill/scripts/computer_use_setup.py            # 检测
python3 mimoskill/scripts/computer_use_setup.py --install  # 安装依赖（npm install）
```

## 命令行、桌面端、Docker

- 命令行 / npm 全局安装：`package.json` 的 `files` 已包含 `plugins/`。
- 桌面端：`scripts/build-sidecar.mjs` 会把 `plugins/` 复制进 sidecar bundle。
- Docker：`Dockerfile` 会复制 `plugins/`。容器里启用只表示容器内 Codex 配置可写入
  MCP server；真实桌面控制取决于 MCP server 跑在哪台机器上——常规桌面自动化建议在
  宿主机的 Codex CLI / Desktop 中加载插件。

## 故障排查

- `adapter_missing`：在插件页点「安装依赖」，或运行 `npm run install-adapter`。
- 截图 / 点击无效（macOS）：到系统设置给宿主应用授予辅助功能 + 屏幕录制权限，重启 Codex。
- HiDPI 坐标偏移：`computer_state` 会返回 `scale`；从截图上读到的坐标需除以 `scale`（Windows 100% 时 `scale` 为 1）。
- 没有发光光标：未安装 Electron——在插件页点「下载发光光标(Electron)」。
- Codex 看不到工具：确认 Admin 已启用插件、`~/.codex/config.toml` 有 `[mcp_servers.mimo-computer-use]`，并完全重启 Codex。
- 监看页空白：确认插件块里有 `MIMO2CODEX_ADMIN_URL`，且代理正在 `:8788` 运行。
