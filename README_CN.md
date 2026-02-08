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
bctl click "a.search-button"
bctl type "input[name=q]" "browser-ctl"
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

<br>

## 为 LLM Agent 而生

browser-ctl 专为 AI Agent 工作流设计：

- **天然适配 tool-calling** — 每个命令都是一次 Shell 调用 + 结构化 JSON 返回，完美契合 function-calling / tool-use 模式
- **内置 AI 技能文件** — 自带 `SKILL.md`，可直接教会 AI Agent（Cursor、OpenCode 等）完整的命令集和最佳实践
- **真实浏览器 = 真实访问** — 你的 LLM 可以直接操作已登录的页面（Gmail、Jira、内部工具），无需管理凭证
- **确定性输出** — 基于 CSS 选择器的 JSON 响应，大多数任务无需视觉模型
- **最小 Token 开销** — `bctl select "a.link" -l 5` 一次调用返回结构化数据，避免"截图 → 视觉模型 → 解析"的多步循环

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
| `bctl navigate <url>` | 导航到 URL &nbsp; *（别名：`nav`、`go`）* |
| `bctl back` | 后退 |
| `bctl forward` | 前进 &nbsp; *（别名：`fwd`）* |
| `bctl reload` | 重新加载页面 |

### 交互

| 命令 | 说明 |
|------|------|
| `bctl click <sel> [-i N]` | 点击元素（CSS 选择器，可选第 N 个匹配项） |
| `bctl hover <sel> [-i N]` | 悬停在元素上 |
| `bctl type <sel> <text>` | 在 input/textarea 中输入文本 |
| `bctl press <key>` | 按下键盘键（Enter、Escape、Tab 等） |
| `bctl scroll <方向\|sel> [像素]` | 滚动：`up` / `down` / `top` / `bottom` 或将元素滚动到视口 |
| `bctl select-option <sel> <val>` | 选择下拉选项 &nbsp; *（别名：`sopt`）* `[--text]` |
| `bctl drag <src> [target]` | 拖拽到元素或偏移位置 `[--dx N --dy N]` |

### DOM 查询

| 命令 | 说明 |
|------|------|
| `bctl text [sel]` | 获取文本内容（默认：`body`） |
| `bctl html [sel]` | 获取 innerHTML |
| `bctl attr <sel> [name] [-i N]` | 获取元素属性 |
| `bctl select <sel> [-l N]` | 列出匹配元素 &nbsp; *（别名：`sel`）* |
| `bctl count <sel>` | 计数匹配元素 |
| `bctl status` | 当前页面 URL 和标题 |

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
| `bctl download <target> [-o file] [-i N]` | 下载文件/图片 &nbsp; *（别名：`dl`）* |
| `bctl upload <sel> <files...>` | 上传文件到 `<input type="file">` |

### 等待与弹窗

| 命令 | 说明 |
|------|------|
| `bctl wait <sel\|秒数> [timeout]` | 等待元素出现或延时 |
| `bctl dialog [accept\|dismiss] [--text val]` | 处理下一个 alert / confirm / prompt |

### 服务器

| 命令 | 说明 |
|------|------|
| `bctl ping` | 检查服务器和扩展状态 |
| `bctl serve` | 前台启动服务器 |
| `bctl stop` | 停止服务器 |

<br>

## 示例

<details>
<summary><b>搜索并提取</b></summary>

```bash
bctl go "https://news.ycombinator.com"
bctl select "a.titlelink" -l 5       # 前 5 个链接，包含文本、href 等
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
| **CLI** | 纯标准库，通过 HTTP 通信 |
| **桥接服务器** | 异步中继（aiohttp），自动守护进程化 |
| **扩展** | MV3 Service Worker，通过 `chrome.alarms` 自动重连 |
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
