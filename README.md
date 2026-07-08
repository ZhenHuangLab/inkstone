# gexport

在 chatgpt.com 页内一键批量导出全部对话为 Obsidian 友好的 Markdown 的油猴脚本。
目标与完整设计见 [PLAN.md](PLAN.md)。

## 特性（P1 + P2 已实现）

- 页内浮动面板，一键抓取**全部对话**（backend-api 实时抓取，全程本地处理）
- 导出 **Markdown zip**：
  - `# User` / `# ChatGPT` 作为最高级标题分隔轮次，消息内的 H1–H6 整体降一级
  - `\( \)` / `\[ \]` → `$` / `$$` 公式定界符转换（代码块感知），货币 `$` 转义
  - **引用还原**：联网搜索引用 → 行内 `[来源](url)` 链接 + 文末 `# Sources` 汇总；文件引用 → 文件名说明；还原不了的标记剥离，绝不留乱码
  - **附件下载**：对话里的图片全部下载进 `attachments/`（Obsidian `![[wikilink]]` 内联）；用户上传的文件 ≤2MB 下载并链接，超限的留说明占位
  - 代码解释器代码 + 运行输出、思维链折叠 callout
  - 未知内容类型原样保留进折叠 callout，绝不静默丢内容
  - frontmatter：title / chat_id / url / created / updated / model / tags
- 导出**原始 JSON zip**：数据保险 + 转换器 fixture 来源
- **抗限流**：全局请求间距 + 429 全员共享冷却（respect Retry-After）、失败条目结尾低速重试；列表接口截断/空页降级的防御性重试
- 可取消、单条失败不中断（汇总进 `_failures.json`）

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)
2. 构建并安装脚本：

```bash
bun install
bun run build        # 产物 dist/gexport.user.js，拖进 Tampermonkey 即可
```

开发时用 `bun run dev`（vite-plugin-monkey 会给出一次性安装地址，改代码热更新）。

## 使用

打开 chatgpt.com（已登录），点右下角绿色 ⇩ 按钮 → 选 Markdown zip 或原始 JSON zip → 解压到 Obsidian vault。

## 开发

```bash
bun test             # 转换层单测（纯 TS，无浏览器依赖）
bun run typecheck
bun run build
```

## 路线图

P3 增量同步 / File System Access 直写 vault / 设置面板（附件大小上限、链接风格等）；Canvas 精细还原。详见 PLAN.md。
