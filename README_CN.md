<p align="right">
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

<h1 align="center">browser-ctl</h1>

<p align="center">
  <strong>为 AI Agent 打造的浏览器自动化工具。</strong><br>
  让你的 LLM 直接控制一个真实的 Chrome 浏览器 — 保留你的登录会话、Cookie 和扩展，只需简单的命令行调用。
</p>

<p align="center">
  <a href="https://pypi.org/project/browser-ctl/"><img alt="PyPI" src="https://img.shields.io/pypi/v/browser-ctl?color=blue"></a>
  <a href="https://pypi.org/project/browser-ctl/"><img alt="Python" src="https://img.shields.io/pypi/pyversions/browser-ctl"></a>
  <a href="https://github.com/mikuh/browser-ctl/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/mikuh/browser-ctl"></a>
</p>

<br>

```bash
pip install browser-ctl

bctl go https://github.com
bctl snapshot                        # 列出可交互元素 → e0, e1, e2, …
bctl click e3                        # 通过引用点击 — 无需 CSS 选择器
bctl type e5 "browser-ctl"          # 通过引用输入文本
bctl press Enter
bctl screenshot results.png
```

<br>

## 现有浏览器自动化工具的痛点

[browser-use](https://github.com/browser-use/browser-use)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Puppeteer](https://github.com/puppeteer/puppeteer) 等工具很强大，但在 AI Agent 场景下都有一系列共同的痛点：

| 痛点 | 传统工具 | browser-ctl |
|------|---------|-------------|
| **需要下载浏览器二进制文件** — 必须下载并管理内置 Chromium（约 400 MB） | Playwright、Puppeteer | 直接使用你已安装的 Chrome — 零浏览器下载 |
| **无法访问真实会话** — 启动全新的空白浏览器，无 Cookie、无登录状态、无扩展 | browser-use、Playwright MCP | 控制你的真实 Chrome — 所有会话、Cookie、扩展完整保留 |
| **被反爬虫检测** — 无头浏览器会被大量网站识别并拦截 | Puppeteer、Playwright | 使用真实浏览器配置文件 — 与正常浏览无异 |
| **复杂的 SDK 集成** — 需要导入库、编写异步代码 | browser-use、Stagehand | 纯 CLI + JSON 输出 — 任何 LLM 都能调用 `bctl click "button"` |
| **依赖沉重** — 仅 Playwright 就需要约 50 MB 包 + 浏览器二进制文件 | Playwright、Puppeteer | CLI 零外部依赖；服务器仅需 `aiohttp` |
| **对 LLM 不友好** — 冗长的 API 调用浪费上下文窗口 Token | SDK 类工具 | 简洁命令：`bctl text h1` vs 大量模板代码 |
| **SPA 点击失效** — 程序化点击被弹窗拦截器阻止 | Puppeteer、Playwright | 拦截 `window.open()` 并通过 `chrome.tabs` 导航 — 完美兼容 SPA |

<br>

## 为 LLM Agent 而生

browser-ctl 专为 AI Agent 工作流设计：

- **Snapshot 优先** — `bctl snapshot` 列出页面可交互元素并标记为 `e0`、`e1`、…，直接用引用操作（`bctl click e3`）— 无需猜测 CSS 选择器
- **天然适配 tool-calling** — 每个命令都是一次 Shell 调用 + 结构化 JSON 返回，完美契合 function-calling / tool-use 模式
- **内置 AI 技能文件** — 自带 `SKILL.md`，可直接教会 AI Agent（Cursor、OpenCode 等）完整的命令集和最佳实践
- **真实浏览器 = 真实访问** — 你的 LLM 可以直接操作已登录的页面（Gmail、Jira、内部工具），无需管理凭证
- **确定性输出** — 基于元素引用或 CSS 选择器的 JSON 响应，大多数任务无需视觉模型
- **最小 Token 开销** — `bctl snapshot` + `bctl click e5` 即可完成交互，避免"截图 → 视觉模型 → 解析"的多步循环

```bash
# 一条命令为 Cursor IDE 安装 AI 技能
bctl setup cursor
```

<br>

## 工作原理

```
AI Agent / 终端  ──HTTP──▶  桥接服务器  ◀──WebSocket──  Chrome 扩展
   (bctl CLI)                (:19876)                  (你的浏览器)
```

1. **CLI**（`bctl`）通过 HTTP 向本地桥接服务器发送命令
2. **桥接服务器**通过 WebSocket 将命令转发给 Chrome 扩展
3. **扩展**在你的真实浏览器中使用 Chrome API 和内容脚本执行命令
4. 结果以 JSON 格式沿相同路径返回

> 桥接服务器在首次执行命令时自动启动，无需手动设置。

<br>

## 安装

**第一步** — 安装 Python 包：

```bash
pip install browser-ctl
```

**第二步** — 加载 Chrome 扩展：

```bash
bctl setup
```

然后在 Chrome 中：`chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** → 选择 `~/.browser-ctl/extension/`

**第三步** — 验证：

```bash
bctl ping
# {"success": true, "data": {"server": true, "extension": true}}
```

<br>

## 命令参考

### 导航

| 命令 | 说明 |
|------|------|
| `bctl navigate <url>` | 导航到 URL &nbsp; *（别名：`nav`、`go`；自动补全 `https://`）* |
| `bctl back` | 后退 |
| `bctl forward` | 前进 &nbsp; *（别名：`fwd`）* |
| `bctl reload` | 重新加载页面 |

### 交互

所有 `<sel>` 参数既支持 CSS 选择器，也支持 `snapshot` 的元素引用（如 `e5`）。

| 命令 | 说明 |
|------|------|
| `bctl click <sel> [-i N] [-t text]` | 点击元素；`-t` 按可见文本过滤（子串匹配） |
| `bctl dblclick <sel> [-i N] [-t text]` | 双击元素 |
| `bctl hover <sel> [-i N] [-t text]` | 悬停在元素上；`-t` 按可见文本过滤 |
| `bctl focus <sel> [-i N] [-t text]` | 聚焦元素 |
| `bctl type <sel> <text>` | 在 input/textarea 中输入文本（兼容 React，替换原有值） |
| `bctl input-text <sel> <text>` | 逐字符输入，适配富文本编辑器 `[--clear] [--delay ms]` |
| `bctl press <key>` | 按下键盘键 — Enter 提交表单，Escape 关闭弹窗 |
| `bctl check <sel> [-i N] [-t text]` | 勾选复选框或单选按钮 |
| `bctl uncheck <sel> [-i N] [-t text]` | 取消勾选复选框 |
| `bctl scroll <方向\|sel> [像素]` | 滚动：`up` / `down` / `top` / `bottom` 或将元素滚动到视口 |
| `bctl select-option <sel> <val>` | 选择下拉选项 &nbsp; *（别名：`sopt`）* `[--text]` |
| `bctl drag <src> [target]` | 拖拽到元素或偏移位置 `[--dx N --dy N]` |

### DOM 查询

| 命令 | 说明 |
|------|------|
| `bctl snapshot [--all]` | 列出可交互元素并分配引用 `e0`、`e1`、… &nbsp; *（别名：`snap`）* |
| `bctl text [sel]` | 获取文本内容（默认：`body`） |
| `bctl html [sel]` | 获取 innerHTML |
| `bctl attr <sel> [name] [-i N]` | 获取元素属性 |
| `bctl select <sel> [-l N]` | 列出匹配元素 &nbsp; *（别名：`sel`）* |
| `bctl count <sel>` | 计数匹配元素 |
| `bctl status` | 当前页面 URL 和标题 |
| `bctl is-visible <sel> [-i N]` | 检查元素是否可见（返回边界框） |
| `bctl get-value <sel> [-i N]` | 获取表单元素值（input / select / textarea） |

### JavaScript

| 命令 | 说明 |
|------|------|
| `bctl eval <code>` | 在页面上下文中执行 JS（自动绕过 CSP） |

### 标签页

| 命令 | 说明 |
|------|------|
| `bctl tabs` | 列出所有标签页 |
| `bctl tab <id>` | 按 ID 切换标签页 |
| `bctl new-tab [url]` | 打开新标签页 |
| `bctl close-tab [id]` | 关闭标签页（默认：当前标签页） |

### 截图与文件

| 命令 | 说明 |
|------|------|
| `bctl screenshot [path]` | 截图 &nbsp; *（别名：`ss`）* |
| `bctl download <target> [-o path] [-i N]` | 下载文件/图片 &nbsp; *（别名：`dl`；`-o` 支持绝对路径）* |
| `bctl upload <sel> <files...>` | 上传文件到 `<input type="file">` |

### 等待与弹窗

| 命令 | 说明 |
|------|------|
| `bctl wait <sel\|秒数> [timeout]` | 等待元素出现或延时 |
| `bctl dialog [accept\|dismiss] [--text val]` | 处理下一个 alert / confirm / prompt |

### 批量执行

| 命令 | 说明 |
|------|------|
| `bctl pipe` | 从 stdin 逐行读取命令（JSONL 输出）。连续 DOM 操作自动合批为单次浏览器调用 |
| `bctl batch '<cmd1>' '<cmd2>' ...` | 一次调用执行多条命令，智能合批 |

### 服务器

| 命令 | 说明 |
|------|------|
| `bctl ping` | 检查服务器和扩展状态 |
| `bctl serve` | 前台启动服务器 |
| `bctl stop` | 停止服务器 |
| `bctl setup` | 安装扩展到 `~/.browser-ctl/extension/` 并打开 Chrome 扩展页面 |
| `bctl setup cursor` | 为 Cursor IDE 安装 AI 技能（`SKILL.md`） |
| `bctl setup opencode` | 为 OpenCode 安装 AI 技能 |
| `bctl setup <path>` | 将 AI 技能安装到自定义目录 |

<br>

## 示例

<details open>
<summary><b>Snapshot 工作流（推荐 AI Agent 使用）</b></summary>

```bash
bctl go "https://example.com"
bctl snapshot                          # 列出所有可交互元素，标记为 e0、e1、…
bctl click e3                          # 通过引用点击 — 无需 CSS 选择器
bctl type e5 "hello world"            # 通过引用输入文本
bctl get-value e5                      # 读取表单值
bctl is-visible e3                     # 检查可见性
```
</details>

<details>
<summary><b>搜索并提取</b></summary>

```bash
bctl go "https://news.ycombinator.com"
bctl select "a.titlelink" -l 5       # 前 5 个链接，包含文本、href 等
```
</details>

<details>
<summary><b>按文本点击（SPA 友好）</b></summary>

```bash
bctl click "button" -t "Sign in"        # 点击包含 "Sign in" 文本的按钮
bctl click "a" -t "Settings"            # 点击包含 "Settings" 文本的链接
bctl click "div[role=button]" -t "Save" # 任意元素 + 文本过滤
```
</details>

<details>
<summary><b>填写表单</b></summary>

```bash
bctl type "input[name=email]" "user@example.com"
bctl type "input[name=password]" "hunter2"
bctl select-option "select#country" "US"
bctl upload "input[type=file]" ./resume.pdf
bctl click "button[type=submit]"
```
</details>

<details>
<summary><b>滚动与截图</b></summary>

```bash
bctl go "https://en.wikipedia.org/wiki/Web_browser"
bctl scroll down 1000
bctl ss page.png
```
</details>

<details>
<summary><b>处理弹窗</b></summary>

```bash
bctl dialog accept              # 在触发操作之前设置处理器
bctl click "#delete-button"     # 这会触发一个 confirm() 弹窗
```
</details>

<details>
<summary><b>拖拽</b></summary>

```bash
bctl drag ".task-card" ".done-column"
bctl drag ".range-slider" --dx 50 --dy 0
```
</details>

<details>
<summary><b>批量 / 管道（高速多步操作）</b></summary>

```bash
# 管道模式：多条命令一次调用，自动合批
bctl pipe <<'EOF'
click "button" -t "Select tag"
wait 1
type "input[placeholder='Search']" "v1.0.0"
wait 1
click "button" -t "Create new tag"
EOF

# 批量模式：以参数形式传入
bctl batch \
  'click "button" -t "Sign in"' \
  'wait 1' \
  'type "#email" "user@example.com"' \
  'type "#password" "secret"' \
  'click "button[type=submit]"'
```
</details>

<details>
<summary><b>Shell 脚本</b></summary>

```bash
# 提取页面中所有图片 URL
bctl go "https://example.com"
bctl eval "JSON.stringify(Array.from(document.images).map(i=>i.src))"

# 等待 SPA 内容加载
bctl go "https://app.example.com/dashboard"
bctl wait ".dashboard-loaded" 15
bctl text ".metric-value"
```
</details>

<br>

## 输出格式

所有命令以 JSON 格式输出到 stdout：

```jsonc
// 成功
{"success": true, "data": {"url": "https://example.com", "title": "Example"}}

// 错误
{"success": false, "error": "Element not found: .missing"}
```

错误时返回非零退出码，可与 `set -e` 和 `&&` 链式调用自然配合。

<br>

## 架构

```
┌─────────────────────────────────────────────────────┐
│  AI Agent / 终端                                    │
│  $ bctl click "button.submit"                       │
│       │                                             │
│       ▼  HTTP POST localhost:19876/command           │
│  ┌──────────────────────┐                           │
│  │   桥接服务器          │  (Python, aiohttp)        │
│  │   :19876             │                           │
│  └──────────┬───────────┘                           │
│             │  WebSocket                            │
│             ▼                                       │
│  ┌──────────────────────┐                           │
│  │  Chrome 扩展          │  (Manifest V3)            │
│  │  Service Worker      │                           │
│  └──────────┬───────────┘                           │
│             │  chrome.scripting / chrome.debugger    │
│             ▼                                       │
│  ┌──────────────────────┐                           │
│  │  你的真实浏览器        │  (会话、Cookie 等)        │
│  └──────────────────────┘                           │
└─────────────────────────────────────────────────────┘
```

| 组件 | 说明 |
|------|------|
| **CLI** | 纯标准库，原始 socket HTTP（零重依赖导入，约 5ms 冷启动） |
| **桥接服务器** | 异步中继（aiohttp），自动守护进程化 |
| **扩展** | MV3 Service Worker，通过 `chrome.alarms` 自动重连 |
| **Click** | 三阶段：指针事件 → MAIN world 点击 → `window.open()` 拦截，完美兼容 SPA |
| **Eval** | 双策略：MAIN world 注入（快速）+ CDP 回退（绕过 CSP） |

<br>

## 系统要求

- Python >= 3.11
- Chrome / Chromium 并加载扩展
- macOS、Linux 或 Windows

## 隐私

所有通信都在本地进行（`127.0.0.1`）。无分析、无遥测、无外部服务器。详见 [PRIVACY.md](PRIVACY.md)。

## 许可证

[MIT](LICENSE)
