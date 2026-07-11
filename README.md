# Inkstone（砚）

在 chatgpt.com 页内一键批量导出全部对话为 Obsidian 友好的 Markdown 的油猴脚本。
名取「砚」：砚是把原料研磨成墨、供你书写的石头——Inkstone 把 GPT 的原始输出研磨成能写进笔记的墨，石对石（砚 ↔ Obsidian）。
目标与完整设计见 [PLAN.md](PLAN.md)。

## 特性（P1 + P2 已实现）

- 页内浮动面板，一键抓取**全部对话**（backend-api 实时抓取，全程本地处理）
- 导出 **Markdown zip**：
  - `# User` / `# ChatGPT` 作为最高级标题分隔轮次，消息内的 H1–H6 整体降一级
  - `\( \)` / `\[ \]` → `$` / `$$` 公式定界符转换（代码块感知），货币 `$` 转义
  - **引用还原**：联网搜索引用 → 行内 `[来源](url)` 链接 + 文末 `# Sources` 汇总；文件引用 → 文件名说明；还原不了的标记剥离，绝不留乱码
  - **附件下载**：对话里的图片全部下载进笔记同目录下的附件子文件夹（默认 `conversations/attachments/`，Obsidian `![[wikilink]]` 内联）；用户上传的文件 ≤2MB 下载并链接，超限的留说明占位
  - **目录可定制**：笔记子文件夹（默认 `conversations`，可 `a/b` 嵌套、可留空写根目录）与附件子文件夹（默认 `attachments`，相对笔记所在目录、可留空与笔记同层）均可在设置里改；附件链接是相对 .md 的严格相对路径，GitHub/VS Code 预览同样可用
  - 思维链、工具运行痕迹（代码解释器代码、搜索请求、运行输出）均折叠 callout 包裹，且**默认都不写入**，高级设置「写入思考过程」「写入工具过程」分别开启（CLI 对应 `--thoughts` / `--tool-traces`）
  - 未知内容类型原样保留进折叠 callout，绝不静默丢内容
  - frontmatter：title / chat_id / url / created / updated / model / tags
- 导出**原始 JSON zip**：数据保险 + 转换器 fixture 来源
- **增量同步**：水位线记录每条对话的 update_time，重导只抓有变化的（可关；面板有「重置增量记录」）——重负载的全量抓取一辈子只需一次
- **抗限流**（实测教训换来的完整方案）：全局请求间距 + 429 自适应减速不回落 + 每 ~80 请求喘息 25s + 三类 429 区分（带 Retry-After 全局冷却 / 无头条目级快速放弃 / 跨 URL 连续短冷却）+ 失败条目结尾低速重试 + 失败过多保护性中止。⚠️ 持续高频抓取会触发 ChatGPT 账号级反滥用（旧对话渐进式 429→404、列表截断，数小时后解冻），千万别调快
- 「下载附件」开关：关闭后纯文本导出，请求量骤减
- 可取消、单条失败不中断（汇总进 `_failures.json`）

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)
2. 点击安装 [最新版 inkstone.user.js](https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js)（脚本头内置更新地址，之后发新版会自动更新）

或从源码构建：

```bash
bun install
bun run build        # 产物 dist/inkstone.user.js，拖进 Tampermonkey 即可
```

开发时用 `bun run dev`（vite-plugin-monkey 会给出一次性安装地址，改代码热更新）。

## 使用

打开 chatgpt.com（已登录），点顶栏 Share 左侧的 ⤓ 按钮（位置可在面板「高级设置 → 按钮位置」换成输入框旁）→ 选 Markdown zip 或原始 JSON zip → 解压到 Obsidian vault。UI 主题色自动跟随 ChatGPT 的外观设置（明暗 + accent color）。

## 开发

```bash
bun test             # 转换层单测（纯 TS，无浏览器依赖）
bun run typecheck
bun run build
```

## 路线图

MV3 浏览器扩展（脱离 Tampermonkey、上架商店）、Claude / Gemini 适配。已完成：增量同步、直写 vault、设置面板、Canvas patch 重放、官方导出 zip 离线 CLI（`bun run offline`）。详见 PLAN.md。

## 许可证

[GPL-3.0](./LICENSE)
