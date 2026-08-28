# Inkstone（砚）— ChatGPT / Claude 对话导出

> 名取「砚」：把 GPT 的原始输出研磨成能写进笔记的墨；石对石（砚 ↔ Obsidian）。

> 2026-07-06 brainstorm 定稿。形态：**油猴脚本（Tampermonkey userscript）**，TypeScript 编写，Bun + Vite + vite-plugin-monkey 构建，产物为单个 `.user.js`。

## 目标

- 在 chatgpt.com / claude.ai 页内一键导出对话为 Obsidian 等笔记软件友好的 Markdown
  （ChatGPT 支持批量与增量；Claude 首版只做当前对话，理由见 P5）
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
6. **附件管道**：`file-service://` 与 `sediment://` 指针 → files 接口下载 → 笔记同目录下的附件子文件夹（默认 `conversations/attachments/`）→ 链接改写（wikilink `![[...]]` / 标准相对链接，可配；链接相对 .md 严格成立）；下载失败留占位说明并在完成文案里报数。笔记/附件子文件夹名均可设置（可 `a/b` 嵌套、可留空；`sanitizeSubdir` 逐段净化防逃逸），油猴设置面板与 CLI `--notes-dir`/`--attachments-dir` 同规则。⚠️ 直写 vault 时注意 macOS 大小写不敏感：目录名撞上 vault 已有目录（如 `Attachments`）会直接写进去——2026-07-10 排查的"附件丢失"即此叠加 fast-note-sync 云预览删本地所致，非代码 bug。
7. **Frontmatter**：title、chat_id、url（`chatgpt.com/c/<id>`）、created、updated、model（实际生成消息的 model_slug，最后一条为准；多模型另列 models）、tags —— 配 Dataview 即全库索引。
8. **文件名**：`标题-短id.md` 防重名（无空格/波浪线，非法字符与空白归一为 `-`），id 保证增量覆盖稳定。

## 输出形态

- **v1**：fflate 内存打 zip → 浏览器下载 → 解压进 vault（超大附件集考虑分卷/流式）
- **v2**：File System Access API（Chrome/Edge）`showDirectoryPicker` 直写 Obsidian vault 目录 → 真"一键同步"；Firefox 回退 zip
- **早期福利**：先做"导出原始 JSON zip"——既是数据保险，也是转换器 fixture 的来源

## 增量同步

`GM_setValue` 存 `conv_id → update_time` 水位线；列表按 updated 降序翻页，翻到水位线即停；只重转有变化的对话。

## 项目结构

依赖方向单向收敛：`sites/* → core/*`。core 不认识任何站点，sites 不认识编排。

```
inkstone/
  package.json          # bun（scripts: dev/build/test/typecheck/offline）
  vite.config.ts        # vite-plugin-monkey（match: chatgpt.com / claude.ai）
  cli/
    export.ts           # 官方导出 zip → vault 的离线 CLI（bun 直跑，P4.2）
  docs/
    claude-adapter-feasibility.md   # Claude 移植可行性评估（P5 的依据）
    claude-probe.js                 # 贴进 claude.ai 控制台的结构 / 限流探针
  src/
    main.ts             # 流程编排 + 输出 Sink（zip/直写）——站点无关
    ui.ts               # 浮动面板 + 进度——站点无关，锚点与配色问 adapter
    state.ts            # 增量水位线（按站点分表）+ 设置持久化
    core/               # ← 站点无关内核
      ir.ts             # 中间表示：IRConversation / IRTurn / IRBlock
      render.ts         # IR → Markdown（轮次标题、callout、围栏、frontmatter）
      fetcher.ts        # 限速 / 退避 / 并发池 / 取消 / 限流观测（每站点一个实例）
    sites/
      types.ts          # SiteAdapter 契约（取数 + 转换 + 界面锚点 + 批量能力）
      index.ts          # 按 location.host 分派
      chatgpt/
        index.ts        # adapter 实装
        convert.ts      # backend-api JSON → IR（content_type 分发、canmore 语义）
      claude/
        index.ts        # adapter 实装（supportsBatch: false）
        api.ts          # 内部 API 客户端 + 保守限流参数 + 分页器（未接界面）
        types.ts        # 从宽的字段类型，[待测] 处已标注
        convert.ts      # 内部 API JSON → IR（块级分发、主线回溯、附件两处来源）
        artifacts.ts    # artifact create/update/rewrite 折叠成终稿
    convert/            # ChatGPT 专属转换 + 通用文本工具（历史路径，测试直接引用）
      markdown.ts       # 兼容壳：conversationToIR + renderConversation
      linearize.ts      # mapping 树 → 线性消息
      canvas.ts         # Canvas textdoc patch 重放
      citations.ts      # 私有区引用标记还原
      math.ts           # 公式定界符转换（代码块感知）—— 两站点共用
      headings.ts       # 标题降级 / 剥离为加粗 —— 两站点共用
      codeaware.ts      # 代码块感知的文本变换基础设施 —— 两站点共用
    api.ts              # ChatGPT backend-api 客户端（端点与字段，节奏交给 core）
    output/
      zip.ts            # fflate 打包
      fsaccess.ts       # File System Access 直写 vault（句柄存 IndexedDB）
  test/
    fixtures/*.json     # 对话 JSON（ChatGPT 真实脱敏 / Claude 合成）
    *.test.ts           # bun test（132 个）
```

## 阶段

- **P1 骨架 + 取数** ✅（2026-07-08）：脚手架、UI 注入、API 客户端、全量抓取、原始 JSON zip 导出 + 基础 Markdown（线性化/公式/标题降级/frontmatter/排版）
- **P2 保真度** ✅（2026-07-08）：引用还原（content_references → 行内链接 + Sources）、附件管道（图片全下 / 文件 ≤2MB）、thoughts/代码解释器类型、全局限速 + 失败重试（Canvas 精细还原顺延到 P3，MVP 为折叠嵌入）
- **P2.5** ✅（2026-07-08）：增量同步（提前自 P3）、单对话导出、附件上限设置、Branch 对话 frontmatter 回链父对话
- **P3 体验** ✅（2026-07-10）：File System Access 直写 vault（目录句柄存 IndexedDB 跨会话复用，Firefox 锁死 zip）、链接风格（wikilink / 标准 md）与消息内标题模式（降级 / 剥离为加粗）设置、Canvas patch 重放（create/update 重放还原终稿，重放失败回退原始 JSON 嵌入；账号历史里无真实 Canvas 数据，仅合成 fixture 验证，待真实数据回归）
- **P3.5 目录定制** ✅（2026-07-11）：笔记/附件子文件夹可设置（面板 + CLI `--notes-dir`/`--attachments-dir`），附件目录改挂笔记目录下、链接改为相对 .md 的严格相对路径；完成文案报附件失败/超限数（油猴直写端待真实页面回归）
- **UI v3 液态玻璃** ✅（2026-07-11）：Apple liquid glass 重设计，主色运行时跟随页面 accent（`html[data-chat-theme]` → `--{theme}-theme-submit-btn-bg/-text/entity-accent`，变量消失时退回扫描含 accent 最饱和色 → 黑白中性）；导出钮双位置可设（默认贴顶栏 Share 左侧、底色同款 translucent blur(24px)，备选输入框旁玻璃圆钮），**无固定默认位置**：找不到锚点不现身、锚点短暂消失位置冻结、消失 4s+ 整体隐藏；点击后图标变向下箭头。轻量约束：blur 只上两层、动效仅 transform/opacity、@supports 与 prefers-reduced-transparency 降级。已通过 CDP 注入真实页面验证（紫色 accent 提取、双模式几何、会话切换不闪跳、无锚点页隐藏）
- **P4 脱离油猴（用户明确期望）**：转换层（convert/）零浏览器依赖、api.ts 只依赖 fetch，天然可复用到：
  1. **MV3 浏览器扩展**——同一套 src，加 manifest + content script 打包目标（vite 多入口）；不再依赖 Tampermonkey，可上架商店（用户拍板：等功能完善后再做/上架）
  2. **官方导出 zip 的离线 CLI** ✅（2026-07-10，`bun run offline <zip|目录> [-o 输出]`）——完全不碰 backend-api，零限流风险；432 对话 + 248 附件 ~8s 转完；支持 `--link-style/--heading-mode/--no-thoughts/--no-assets`
  3. Claude adapter ✅ 骨架（2026-08-28，见下）／ Gemini 待做

- **P5 多站点架构 + Claude adapter**（2026-08-28）：见 `docs/claude-adapter-feasibility.md`（可行性评估）
  - **架构**：引入站点无关的中间表示（IR）与适配器契约，依赖方向变成
    `sites/{chatgpt,claude}/ → core/{ir,render,fetcher}`。编排（main.ts）与界面（ui.ts）
    不再认识任何一家的端点、字段或 DOM；新增站点 = 新增一个 adapter，不改编排。
    重构以「现有 102 个测试断言一字不改地通过」为验收标准，行为逐字节等价。
  - **两侧数据模型的结构性差异**：ChatGPT 一条消息一种 content_type（消息级分发），
    Claude 一条消息多个 typed block 按序交错（块级分发）。主线定位则同构——
    两边都是「叶子 + parent 链回溯后反转」。
  - **Claude 侧的脏活更少**：Canvas 的正则 patch 重放（150 行）与私有区 Unicode 引用
    还原（178 行）在 Claude 都不需要——artifact 的 update 是字面量 `old_str`→`new_str`，
    引用是结构化数组。artifact 折叠约 40 行。
  - **⚠️ 首版刻意只做「导出当前对话」**：批量的地基（分页器、水位线、并发池、
    保护性中止）全部就位且已单测，但 `supportsBatch: false` 关着。理由是限流画像
    未知——ChatGPT 侧的参数是 344 + 432 对话实测调出来的，Claude 侧一条实测数据
    都没有。调研过的三个开源 claude.ai 导出器**没有一个实现了 429 退避**
    （最激进的是 3 并发 + 固定 200ms 间隔且不看 429），所以没有可借鉴的安全参数。
  - **Claude 限流起步参数**（保守，待实测调整）：间距 1500ms（ChatGPT 侧的两倍慢）、
    上限 8000ms、每 40 请求歇 30s、最多重试 6 次。每个站点持有独立的 fetcher 实例，
    一边的限流不拖累另一边。吃到 429 时导出完成文案会报出次数、被推大的间距与
    服务端要求的最长等待——未知站点的节奏只能靠实测看清，先让它可见再谈调参。
  - **待实测**：`docs/claude-probe.js` 可直接粘进 claude.ai 控制台，打印字段骨架
    （不打印对话内容）并做一次 ≤8 请求的保守限流试探。清单见可行性文档第五节：
    分页是否生效、thinking 字段名、citations 挂载形态、附件地址能否直取字节、
    公式定界符、Projects 字段名、FAB 锚点选择器。
  - **未做**：Claude 的行内引用锚定（citations 的字符级定位字段未实测，首版只把
    来源汇总进文末 Sources，正文一字不动）；Claude 官方导出 zip 的离线 CLI 通道。

## 实战经验（2026-07-08 E2E，344 对话实测）

- 列表接口 `total` 字段不可靠（翻页途中返回 offset+len+1），终止只认空页 + 重试确认
- 列表索引会瞬时降级：突发请求后整个列表短暂只返回 83/344 条（对话详情仍可取），恢复需静置几分钟
- 限流是突发桶型：~200 连发后连环 429，Retry-After 可能很长；必须全局共享冷却而非各请求独立退避
- 附件元数据 `size` 不可靠（library 文件报 0），大小上限要靠 Content-Length + 实际字节双重护栏
- `sources_footnote` 引用的 `matched_text` 可能是一个裸空格——替换前必须验证 matched_text 真的是引用标记
- 模型会写同长度反引号嵌套围栏（```md 内套 ```bash），任何 CommonMark 状态机都会错位——引用剥离不能依赖代码感知

## 实战经验（2026-07-10 官方导出 zip，432 对话实测）

- 官方 zip 只保留 user/assistant 可见消息：tool/system 全剥离，Canvas、代码解释器载荷、recipient 字段都不存在——高保真必须走 backend-api，官方 zip 是保底
- mapping 节点只有 parent 链没有 children；对话级 create/update_time 有一批被服务端迁移重写（指纹：create==update==导出前一天，2023 老对话 47/432 中招），要用消息时间修正
- 附件：`sediment://file_X` ↔ 包内 `file_X.dat`，原名在 conversation_asset_file_names.json；被引用附件可能不在包里（23/271，服务端已过期删除），须留占位
- content_references 没有 matched_text/start_idx：file 引用用 `input_pointer(message_index, file_index)` 精确定位；cite 标记正文里的 turn 号是另一套大数编号，token 对不上——但「cite 标记数 == web 引用数」503/503 成立，按出现顺序配对即可全量还原
- Branch 对话只有 branching_from_conversation_title 没有 id；分支会整份复制父对话消息 id，按消息 id 反查会命中父 + 各兄弟分支，须再按标题精确匹配消歧（唯一命中才认）

## 风险

- 非官方接口变动（历史上相对稳定，但无保证）
- 大历史触发 429 → 限速 + 断点续传
- 超大附件集内存占用 → 分卷 zip / 流式写
- File System Access 仅 Chromium 系可用
