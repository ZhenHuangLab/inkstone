# gexport

在 chatgpt.com 页内一键批量导出全部对话为 Obsidian 友好的 Markdown 的油猴脚本。
目标与完整设计见 [PLAN.md](PLAN.md)。

## 特性（P1 已实现）

- 页内浮动面板，一键抓取**全部对话**（backend-api 实时抓取，全程本地处理）
- 导出 **Markdown zip**：
  - `# User` / `# ChatGPT` 作为最高级标题分隔轮次，消息内的 H1–H6 整体降一级
  - `\( \)` / `\[ \]` → `$` / `$$` 公式定界符转换（代码块感知），货币 `$` 转义
  - 引用标记剥离不留乱码（P2 将还原成链接）
  - 代码解释器代码 + 运行输出、思维链折叠 callout
  - 未知内容类型原样保留进折叠 callout，绝不静默丢内容
  - frontmatter：title / chat_id / url / created / updated / model / tags
- 导出**原始 JSON zip**：数据保险 + 转换器 fixture 来源
- 429/5xx 指数退避、并发限速、可取消、单条失败不中断（汇总进 `_failures.json`）

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

P2 引用还原 / 附件下载 / Canvas；P3 增量同步 / File System Access 直写 vault。详见 PLAN.md。
