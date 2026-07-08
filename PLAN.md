# gexport — ChatGPT 对话高保真导出（→ Obsidian）

> 2026-07-06 brainstorm 定稿。形态：**油猴脚本（Tampermonkey userscript）**，TypeScript 编写，Bun + Vite + vite-plugin-monkey 构建，产物为单个 `.user.js`。

## 目标

- 在 chatgpt.com 页内一键**批量导出全部对话**为 Obsidian 友好的 Markdown
- 高保真：公式、引用链接、代码、图片/附件、思维链、Canvas 不丢不乱
- 增量同步：重跑只导出有变化的对话
- 全程本地处理，不经任何第三方服务

## 架构：两层解耦

### 取数层（页内 backend-api 客户端）

同源 fetch 自带登录态，天然绕过 Cloudflare：

- `GET /api/auth/session` → accessToken（加 `Authorization: Bearer` 头）
- `GET /backend-api/conversations?offset&limit=100&order=updated` → 分页对话列表
- `GET /backend-api/conversation/{id}` → 完整 mapping 树（比官方导出 zip 的 metadata 更全）
- `GET /backend-api/files/{file_id}/download` → 附件签名 URL → fetch blob

并发 2–3、请求间加抖动延时、429/5xx 指数退避、进度 UI 可暂停/续跑。
⚠️ 非官方接口，字段名和路径以实际抓包为准，做好会变动的心理预期。

### 转换层（纯 TS 模块，核心价值所在）

无浏览器依赖，`bun test` + 真实对话 JSON fixture 单测。JSON → Markdown + 附件。

## 转换规则（定稿）

1. **树线性化**：`mapping` 是树（编辑/重新生成产生分支），沿 `current_node` 回溯取主线（=网页所见）；过滤 `is_visually_hidden`、空 system、自定义指令节点；全分支导出留开关。
2. **标题降级**（用户指定）：`# User` / `# ChatGPT` 作为文档最高级标题；消息内容里的 H1–H6 **全部降一级**（H6 封顶；可选"全部剥离"模式），跳过代码块里的 `#`。
3. **公式**：`\(...\)` → `$...$`，`\[...\]` → `$$...$$`（独立成行）；跳过 fenced code / 行内代码；正文裸 `$`（美元）转义防误渲染。
4. **引用还原**：正文私有区 Unicode 标记（`citeturn0search1` 之类）↔ `metadata.content_references` 映射 → 行内 `[title](url)` 链接 + 文末 Sources 汇总；旧版 `【12†source】` 同理；匹配不上的标记剥离，绝不留乱码。
5. **内容类型分发**：
   - `code` / `execution_output`（代码解释器）→ 围栏代码块
   - `multimodal_text` 图片指针 → 下载附件并改链
   - `thoughts`（推理模型思维链）→ 折叠 callout，默认带、可关
   - Canvas textdoc → MVP 整块嵌入，后续做 patch 重放还原终稿
   - **未知类型 → 原始 JSON 塞进折叠 callout，永不静默丢内容**
6. **附件管道**：`file-service://` 与 `sediment://` 指针 → files 接口下载 → `attachments/` 按内容哈希去重 → 链接改写（wikilink `![[...]]` / 标准相对链接，可配）；下载失败留占位说明。
7. **Frontmatter**：title、chat_id、url（`chatgpt.com/c/<id>`）、created、updated、model、tags —— 配 Dataview 即全库索引。
8. **文件名**：`标题 ~短id.md` 防重名，id 保证增量覆盖稳定。

## 输出形态

- **v1**：fflate 内存打 zip → 浏览器下载 → 解压进 vault（超大附件集考虑分卷/流式）
- **v2**：File System Access API（Chrome/Edge）`showDirectoryPicker` 直写 Obsidian vault 目录 → 真"一键同步"；Firefox 回退 zip
- **早期福利**：先做"导出原始 JSON zip"——既是数据保险，也是转换器 fixture 的来源

## 增量同步

`GM_setValue` 存 `conv_id → update_time` 水位线；列表按 updated 降序翻页，翻到水位线即停；只重转有变化的对话。

## 项目结构

```
gexport/
  package.json          # bun
  vite.config.ts        # vite-plugin-monkey
  src/
    main.ts             # UI 注入 + 流程编排
    api.ts              # backend-api 客户端（token/列表/全文/附件）
    convert/
      linearize.ts      # mapping 树 → 线性消息
      markdown.ts       # 消息 → md（content_type 分发）
      math.ts           # 公式定界符转换（代码块感知）
      citations.ts      # 引用标记还原
      headings.ts       # 标题降级
    output/
      zip.ts            # fflate 打包
      fsaccess.ts       # 直写 vault（v2）
    state.ts            # 增量水位线
    ui.ts               # 浮动面板 + 进度
  test/
    fixtures/*.json     # 真实对话 JSON（脱敏）
    *.test.ts           # bun test
```

## 阶段

- **P1 骨架 + 取数** ✅（2026-07-08）：脚手架、UI 注入、API 客户端、全量抓取、原始 JSON zip 导出 + 基础 Markdown（线性化/公式/标题降级/frontmatter/排版）
- **P2 保真度** ✅（2026-07-08）：引用还原（content_references → 行内链接 + Sources）、附件管道（图片全下 / 文件 ≤2MB）、thoughts/代码解释器类型、全局限速 + 失败重试（Canvas 精细还原顺延到 P3，MVP 为折叠嵌入）
- **P3 体验**：增量同步、File System Access 直写 vault、设置面板（排版风格/链接风格/附件上限/开关）、Canvas patch 重放
- **P4 可选**：复用转换核心做官方导出 zip 的离线 CLI（Bun 直接跑）；Claude/Gemini adapter

## 实战经验（2026-07-08 E2E，344 对话实测）

- 列表接口 `total` 字段不可靠（翻页途中返回 offset+len+1），终止只认空页 + 重试确认
- 列表索引会瞬时降级：突发请求后整个列表短暂只返回 83/344 条（对话详情仍可取），恢复需静置几分钟
- 限流是突发桶型：~200 连发后连环 429，Retry-After 可能很长；必须全局共享冷却而非各请求独立退避
- 附件元数据 `size` 不可靠（library 文件报 0），大小上限要靠 Content-Length + 实际字节双重护栏
- `sources_footnote` 引用的 `matched_text` 可能是一个裸空格——替换前必须验证 matched_text 真的是引用标记
- 模型会写同长度反引号嵌套围栏（```md 内套 ```bash），任何 CommonMark 状态机都会错位——引用剥离不能依赖代码感知

## 风险

- 非官方接口变动（历史上相对稳定，但无保证）
- 大历史触发 429 → 限速 + 断点续传
- 超大附件集内存占用 → 分卷 zip / 流式写
- File System Access 仅 Chromium 系可用
