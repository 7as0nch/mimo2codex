# mimoskill · 详细介绍

> [English](./mimoskill.md) · 中文
>
> 回到：[README English](../README.md) · [README 中文](../README.zh.md)

`mimoskill/` 是仓库根目录下一捆**辅助脚本 + 参考文档**。它存在的原因是有些事 MiMo / DeepSeek / 大多数纯文本 LLM 原生做不了（图像生成、纯文本模型看图、…），而 Codex 在客户端硬编码了一些能力假设，代理层压根改不动。

代理（mimo2codex）和 mimoskill **完全独立**：不跑 mimo2codex 也能用 mimoskill，反之亦然。两者通过**约定**协作：代理检测到能力缺口时，会在消息里塞占位文本，指向对应的 `mimoskill/scripts/*.py`。

## 什么时候会触发？

> 一句话：**"模型能做的事 proxy 透传，模型做不了的事 mimoskill 兜底。"**

| 能力 | 当前 chat 模型能做 | 当前 chat 模型做不了 |
|---|---|---|
| 看图 / OCR / 识图 | proxy 透传图片给模型；**mimoskill 不触发** | proxy 剥掉图片、塞 `[N image attachment(s) omitted: … python3 mimoskill/scripts/ocr.py <path> …]` 占位文本；LLM 读到占位 + AGENTS.md 后 **去跑 `ocr.py`** |
| 图像生成 | 没有任何主流 chat 模型自带 image-gen | **mimoskill 永远触发** —— `scripts/generate_image.py` 或 `scripts/generate_pet.py` |
| 联网搜索 | proxy 在 MiMo `sk-*`（按量）key 下把 Codex 的 `web_search` 翻译成 MiMo 内置的；`tp-*`（套餐）key 与 DeepSeek 自动跳过 | `scripts/mimo_chat.py` 遵循同样规则 —— MiMo `sk-*` 自动启用，`tp-*` / pollinations 跳过。**无需参数** |
| TTS / ASR | Codex 没接 | `scripts/mimo_chat.py` 直接调 MiMo 的独立端点 |

触发**发生在 LLM 这一层**，不在 proxy 层。proxy 只做协议翻译 + 最小兼容性修整（剥图、塞占位文本）。Codex 读 [AGENTS.md](../AGENTS.md) 和 [mimoskill/SKILL.md](../mimoskill/SKILL.md)，看到占位文本或者用户意图后，自己决定调哪个脚本。脚本是独立子进程，**完全绕开 proxy** —— OCR 直接打 MiMo 或 pollinations，出图直接打 pollinations 或 OpenAI，等等。

## 目录结构

```
mimoskill/
├── SKILL.md                   # 给 LLM 看的 skill 清单 —— 触发规则 + 决策树
├── scripts/
│   ├── mimo_chat.py           # 直接调 MiMo 聊天 / 视觉 / 联网搜索（纯标准库）
│   ├── ocr.py                 # OCR / 识图。MiMo 或免费 pollinations
│   ├── generate_image.py      # 通用图像生成（任意风格 / 主题）
│   ├── generate_pet.py        # Codex 宠物生成（chibi 贴纸风）
│   └── install_pet.sh         # 把生成的 PNG 装到 Codex 的宠物目录
├── references/
│   ├── models.md              # MiMo 能力矩阵 + 字段坑
│   ├── ocr_workflow.md        # 完整 OCR 模式参考、退出码、JSON 结构
│   └── pet_workflow.md        # 单图 vs 多状态动画 bundle
└── assets/
    └── pet_prompt_template.md # 调好的 chibi 贴纸提示词模板
```

## 脚本详解

### `scripts/mimo_chat.py` —— 聊天 / 视觉（无 key 也能用）

纯标准库 Python 脚本，单轮或流式聊天。两个引擎，跟 `ocr.py` 是同一套 `--engine auto|mimo|pollinations`：

| 引擎 | 需要 key | 备注 |
|---|---|---|
| `mimo` | 需要 `MIMO_API_KEY` | 最佳质量。`sk-*` key 自动启用 web_search（无需参数），TTS / ASR 也只能用这个 |
| `pollinations` | **不需要** | 免费公共端点 `text.pollinations.ai`。文本 + 视觉可用，联网搜索 / TTS / ASR 不可用 |

auto 选择：有 `MIMO_API_KEY` 用 mimo，否则 pollinations。**这个脚本现在不依赖任何 key**（纯文本 + 视觉场景）。

```bash
# 零配置 —— 自动走 pollinations 兜底
python3 mimoskill/scripts/mimo_chat.py "讲个笑话"
python3 mimoskill/scripts/mimo_chat.py --image https://x/y.png "描述这张图"

# 最佳质量 + MiMo 原生能力（sk-* key 自动开 web_search，TTS、ASR）
export MIMO_API_KEY=sk-xxxxxxxxxxxxxxxx
python3 mimoskill/scripts/mimo_chat.py "今天上海天气"   # 自动带 web_search
python3 mimoskill/scripts/mimo_chat.py --model mimo-v2.5-pro --max-tokens 8000 --stream "写长一点"
```

mimo 引擎自动踩好 MiMo 的坑：`max_completion_tokens`（不是 `max_tokens`）、图片必须配 `text` part、多轮 `reasoning_content` 回填、联网搜索插件调用。

| 参数 | 说明 |
|---|---|
| `--engine` | `auto` / `mimo` / `pollinations`（默认 auto） |
| `--model` | 默认 `mimo-v2.5-pro`（mimo 引擎）。视觉用 `mimo-v2.5` |
| `--pollinations-model` | 默认 `openai`（视觉能力）。可选 `openai-large` / `openai-fast` |
| `--image URL` | 附图。自动 bump 到视觉能力模型 |
| `--stream` | SSE 流式 |
| `--max-tokens N` | mimo 引擎映射到 `max_completion_tokens`，pollinations 映射到 `max_tokens` |
| `--temperature F` | 默认 0.7 |

### `scripts/ocr.py` —— OCR / 识图

非视觉 chat 模型场景下的兜底。**三个引擎**（`--engine auto` 自动选）：

| 引擎 | 需要 key | 需要网络 | 支持 mode | 备注 |
|---|---|---|---|---|
| `mimo` | 需要 `MIMO_API_KEY` | 需要 | 全部 | 内部调 `mimo-v2.5`（视觉模型），与外层 chat 模型无关。质量最好 |
| `tesseract` | **不需要** | **不需要** | 仅 text | 纯本地 OCR。**国内 / GFW 环境推荐**——pollinations 不通时就靠它兜底。装一次永久可用 |
| `pollinations` | **不需要** | 需要 | 全部 | 免费公共端点 `text.pollinations.ai`，无需注册。但国内访问可能慢 / 不通 |

auto 选择顺序：`mimo`（有 key）→ `tesseract`（已装 + `--mode text`）→ `pollinations`。所以**只配了 DeepSeek key**（或啥都没配）的用户也能零配置用 OCR；国内用户装一次 tesseract 之后 OCR 就完全离线了。

```bash
# 零配置 —— auto 自动挑可用的引擎
python3 mimoskill/scripts/ocr.py path/to/image.png

# 国内 / 离线 —— 装一次 tesseract，永久离线可用
#   macOS:   brew install tesseract tesseract-lang
#   Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim
#   Windows: https://github.com/UB-Mannheim/tesseract/wiki
python3 mimoskill/scripts/ocr.py --engine tesseract --lang Chinese scan.png

# 最佳质量 —— 设 MiMo key
export MIMO_API_KEY=sk-xxxx
python3 mimoskill/scripts/ocr.py path/to/image.png   # auto -> mimo

# 强制走 pollinations（即便你有 MiMo key，比如想省额度）
python3 mimoskill/scripts/ocr.py --engine pollinations form.png

# 强制 MiMo —— 没设 key 直接报错（不静默降级）
python3 mimoskill/scripts/ocr.py --engine mimo form.png
```

四个输出模式：

| `--mode` | 输出 |
|---|---|
| `text`（默认） | 逐字 OCR —— 保留换行 + 阅读顺序 |
| `describe` | 2-4 句描述 |
| `structured` | 单个 JSON：`text` / `language` / `regions[]` / `summary` |
| `markdown` | 整张图重新渲染成 GitHub-flavored Markdown |

输入形态（位置参数，0+ 个）：
- 本地路径：`./scan.png`、`C:\foo.jpg`
- HTTP(S) URL：原样转发
- `data:image/...;base64,…`：原样转发
- `-` 或管道 stdin：从 stdin 读一张图的字节

magic-byte 嗅探 MIME（不信任扩展名）：PNG / JPEG / GIF / WebP / BMP。多个位置参数会**一次 upstream 调用**批处理。

> 完整参考：[mimoskill/references/ocr_workflow.md](../mimoskill/references/ocr_workflow.md)（模式、退出码、JSON 结构、lang/prompt 参数、pollinations 细节）。

### `scripts/generate_image.py` —— 通用图像生成

`generate_pet.py` 的薄包装，去掉 chibi 宠物提示词模板、加了可选的 `--style` 常见风格。同样的 providers、同样的环境变量、同样的 auto 兜底策略。

```bash
# 免费 —— 没设 OpenAI key 时 auto 走 pollinations
python3 mimoskill/scripts/generate_image.py --prompt "日式庭园，水彩，黎明" --out garden.png

# 高质量 —— 设 OpenAI key
export PET_OPENAI_API_KEY=sk-real-openai-key
python3 mimoskill/scripts/generate_image.py --prompt "..." --out art.png  # auto -> gpt-image-1

# 风格预设
python3 mimoskill/scripts/generate_image.py --style anime --prompt "黄昏的神社" --out shrine.png
```

| `--provider` | 后端 |
|---|---|
| `auto`（默认） | 有 `PET_OPENAI_API_KEY` 走 `gpt-image-1`，否则 `pollinations` |
| `pollinations` | 免费、无 key |
| `gpt-image-1` | OpenAI 官方图像生成 —— 最佳质量 |
| `replicate` | Replicate API（任意模型） |
| `local-sd` | 本地 Stable Diffusion |

> `PET_OPENAI_API_KEY` 故意**和 `MIMO_API_KEY`、`OPENAI_API_KEY` 分开** —— 只用于图像生成，泄露或不存在都不影响别的事。

### `scripts/generate_pet.py` —— Codex 宠物生成

同样的后端，但内置了一套调好的 chibi 贴纸提示词，围绕 `--description` 组装。输出尺寸 + 留白都按 Codex 宠物选择器适配。

```bash
# 单张静态宠物（免费）
python3 mimoskill/scripts/generate_pet.py --description "chibi shiba 程序员" --out pet.png

# 多状态动画 bundle（idle / thinking / typing / sleeping）
python3 mimoskill/scripts/generate_pet.py --description "chibi 猫" --bundle ./shiba/
```

提示词模板在 [mimoskill/assets/pet_prompt_template.md](../mimoskill/assets/pet_prompt_template.md)。完整流程见 [mimoskill/references/pet_workflow.md](../mimoskill/references/pet_workflow.md)。

### `scripts/install_pet.sh` —— 装宠物到 Codex

自动探测 macOS / Linux / Windows 的宠物目录，把 PNG（或 bundle）拷过去。绕开 Codex 硬编码的宠物路径问题。

```bash
bash mimoskill/scripts/install_pet.sh pet.png shiba
# 然后完全退出 + 重启 Codex（桌面端走系统托盘退出，不只是关窗口）
```

## 三种用法

### 1. 直接调用（普通用户，零配置）

```bash
python3 mimoskill/scripts/mimo_chat.py "..."
python3 mimoskill/scripts/ocr.py invoice.png        # 无 key 也能跑，走免费 pollinations
python3 mimoskill/scripts/generate_image.py --prompt "..."
```

不需要注册 skill —— 就是普通 Python 脚本（纯标准库，不用 `pip install`）。

### 2. 当 Claude Code 的 Skill 用

软链到 `~/.claude/skills/`：

```bash
ln -s "$(pwd)/mimoskill" ~/.claude/skills/mimoskill
```

之后 Claude 会读 [SKILL.md](../mimoskill/SKILL.md)，遇到相关请求（"帮我从这张图生成宠物"、"读一下这张截图的文字"、"让 MiMo 把这段话朗读了"）自动路由到对应脚本。

### 3. 当 Codex agent 指南

仓库根的 [AGENTS.md](../AGENTS.md) 已经接好。Codex 每次启会话都会读，遇到生图 / 宠物 / OCR 任务会路由到 mimoskill 脚本 —— **不会**再去 `pip install openai`，也不会在用 MiMo / DeepSeek / Qwen / 任何非 OpenAI 上游时尝试调 OpenAI 的 `image_gen` 工具。

## 环境变量

| 变量 | 谁用 | 说明 |
|---|---|---|
| `MIMO_API_KEY` | `mimo_chat.py`、`ocr.py`（engine=mimo / auto 时） | MiMo Chat / 视觉 key。两个脚本都**可选** —— 没设会自动走 pollinations |
| `MIMO_CHAT_ENGINE` | `mimo_chat.py` | `auto` / `mimo` / `pollinations` —— 等价于 `--engine` |
| `MIMO_BASE_URL` | `mimo_chat.py`、`ocr.py` | 默认 `https://api.xiaomimimo.com/v1` |
| `MIMO_MODEL` / `MIMO_OCR_MODEL` | `ocr.py` 模型 auto-pick | 没传 `--model` 时使用（必须视觉能力） |
| `MIMO_OCR_ENGINE` | `ocr.py` | `auto` / `mimo` / `pollinations` —— 等价于 `--engine` 参数 |
| `POLLINATIONS_MODEL` | `ocr.py` | 默认 `openai`（视觉能力）。可选 `openai-large`、`openai-fast` |
| `PET_OPENAI_API_KEY` | `generate_pet.py`、`generate_image.py` | 跟 `MIMO_API_KEY` / `OPENAI_API_KEY` 独立；只用于图像生成 |
| `REPLICATE_API_TOKEN` | `generate_*.py --provider replicate` | 仅 Replicate 后端时需要 |

## 常用组合

### 先 OCR 一张图，再用当前 chat 模型总结

```bash
TEXT=$(python3 mimoskill/scripts/ocr.py invoice.png)
python3 mimoskill/scripts/mimo_chat.py "总结这张发票:\n$TEXT"
```

或者直接在 Codex 里：把图贴进去就行。proxy 剥图后留指向 `ocr.py` 的占位文本，Codex 自己跑脚本把文字喂回对话 —— **完全自动**。

### 生成 `/hatch` 替代宠物（无 OpenAI key 也能用）

```bash
python3 mimoskill/scripts/generate_pet.py --description "chibi shiba 程序员" --out pet.png
bash mimoskill/scripts/install_pet.sh pet.png shiba
# 完全退出 + 重启 Codex，宠物菜单里挑新的
```

想要更好质量，设 `PET_OPENAI_API_KEY=sk-真OpenAI-key`，auto 会切到 `gpt-image-1`。

### 结构化 OCR + JSON 解析

```bash
JSON=$(python3 mimoskill/scripts/ocr.py --mode structured invoice.png)
echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary'])"
```

### 多图批量 OCR（一次计费）

```bash
python3 mimoskill/scripts/ocr.py page1.png page2.png page3.png
```

所有图**单次** upstream 调用，模型可跨图引用（如身份证正反面）。输出是按阅读顺序串联的一段文本。

## 故障排查

<details>
<summary><b><code>MIMO_API_KEY</code> 未设置</b> —— ocr.py 退出码 3</summary>

你显式传了 `--engine mimo`。要么去掉这个参数（`auto` 会自动降级到 pollinations），要么设 key：

```bash
export MIMO_API_KEY=sk-xxxx
python3 mimoskill/scripts/ocr.py form.png
```

</details>

<details>
<summary><b>Pollinations 返回 429 / 限流</b></summary>

撞 IP 限流。等会儿再试，或者切到 `--engine mimo`（如果你有 MiMo key）。

</details>

<details>
<summary><b>Codex 跑 /hatch 时报 <code>image_gen tool not available</code></b></summary>

Codex 的 `/hatch` 在客户端硬编码调 OpenAI 的 `image_gen` 工具，代理拦不住。改用 `generate_pet.py`，见上文「生成 /hatch 替代宠物」。

</details>

<details>
<summary><b>报 <code>pip install openai</code> 错 / Codex 想装 openai</b></summary>

是 Codex 想用 openai Python SDK 兜底图像生成。[AGENTS.md](../AGENTS.md) 已经预防这条路 —— 确认它在仓库根，且当前 Codex 会话已经读过（编辑完 AGENTS.md 后要开新会话）。

</details>

<details>
<summary><b>工具返回了图，但模型在工具结果里看不到图</b></summary>

设计如此。Chat Completions 的 `tool` role 历史上只接受字符串 content —— `function_call_output` 里的图片 content part 会被 flatten 成 `[N image attachment(s) omitted from tool output: ...]` 占位文本（详见 [src/translate/reqToChat.ts](../src/translate/reqToChat.ts) 的 `toolOutputToString`）。要把图喂给 LLM，让工具把图存到本地、返回路径，下一轮用户消息再 `@path/to/screenshot.png` 让 ocr.py 类工具读出来 —— 这时如果 chat 模型不支持视觉，OCR 兜底机制就会接管。

</details>

## 设计取舍

- **不需要 `pip install`。** 所有脚本纯标准库。避免依赖漂移，任何裸 Python ≥ 3.8 都能跑。
- **网络操作明确。** 不偷偷重试备用端点。要 MiMo 又没 key 就直接报错 —— 而不是静默降级掩盖配错。
- **proxy 和 mimoskill 互不调用。** 两个独立进程，靠 `AGENTS.md` / `SKILL.md` 约定连接。这样两边都能独立测试 / 替换。
- **Pollinations 是无 key 逃生通道。** 在 `ocr.py`（视觉）、`generate_pet.py`（出图）、`generate_image.py`（出图）里都用作免费兜底。有 IP 限流但永远在线。项目把它当成一等公民，不是"降级模式"。
