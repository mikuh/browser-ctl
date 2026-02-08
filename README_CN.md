<p align="right">
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

<h1 align="center">browser-ctl</h1>

<p align="center">
  <strong>从终端控制 Chrome 浏览器。</strong><br>
  一个轻量级的命令行浏览器自动化工具 — 导航、点击、输入、滚动、截图，一切尽在掌握。
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

## 特性

| | 特性 | |
|---|---|---|
| **零配置** | 单一 `bctl` 命令，JSON 输出，适用于任何 Shell 或脚本 | 开箱即用 |
| **无需管理浏览器** | 直接使用你已安装的 Chrome，配合轻量级扩展 | 无需 Puppeteer/Playwright |
| **CLI 零依赖** | CLI 本身仅使用 Python 标准库 | 极小体积 |
| **AI Agent 友好** | 内置 `SKILL.md`，支持 Cursor / OpenCode 集成 | 为 LLM 工作流而生 |
| **本地且私密** | 所有通信都在 `localhost` 上，数据不会离开设备 | 隐私优先 |

<br>

## 工作原理

```
终端 (bctl)  ──HTTP──▶  桥接服务器  ◀──WebSocket──  Chrome 扩展
```

1. **CLI**（`bctl`）通过 HTTP 向本地桥接服务器发送命令
2. **桥接服务器**通过 WebSocket 将命令转发给 Chrome 扩展
3. **扩展**使用 Chrome API 和内容脚本执行命令
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

## AI Agent 集成

browser-ctl 内置了专为 AI 编程助手设计的 `SKILL.md`：

```bash
bctl setup cursor       # Cursor IDE
bctl setup opencode     # OpenCode
bctl setup /path/to/dir # 自定义目录
```

安装后，AI Agent 可以使用 `bctl` 命令代你自动化浏览器操作。

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
│  终端                                               │
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
│  │  网页                 │                           │
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
