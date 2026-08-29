# Inkstone → Claude 对话导出：可行性分析

> **实施状态（2026-08-29）**：本文第四节的架构改造与第六节的 P1–P4 已完成。
> Claude 的当前、选择、全部与增量导出均已接入；因限流画像仍缺少大样本实测，P4
> 使用单并发、独立慢速 Fetcher、429/Retry-After 熔断、1000 请求预算与低失败率阈值，
> 不做整批二次重试。落地记录见 `PLAN.md` § P5，探针脚本见 `docs/claude-probe.js`。
> 本文其余部分保持评估当时的原貌，不随实施回填——它是决策依据的快照。

> 评估日期：2026-08-28 · 基准代码：`2121e9f`（v0.2.3，与上游 ZhenHuangLab/inkstone 同步）
>
> 证据分级：**[码]** = 读本仓库源码得出；**[开源]** = 依据 claude.ai 现有开源导出器的实现与其维护文档（二手，标注记录时间）；**[待测]** = 需要在真实 claude.ai 会话里实测确认。本文不含任何未标注来源的推断。

## 结论

**可行，且比预期便宜。** 移植的主要成本不在写 Claude 适配器，而在把现有代码从「隐式假设 ChatGPT 数据模型」重构成「站点适配器 + 中间表示」。

- 转换层（`convert/`）里真正**站点无关**的部分——公式、标题降级、代码块感知、排版收尾、附件链接、frontmatter、文件名——可以原样复用，约占转换层代码的 40%。
- ChatGPT 最脏的两块逻辑（PUA Unicode 引用还原、Canvas 正则 patch 重放）在 Claude 侧**都不需要**：Claude 的 artifact 修订是显式 `old_str`→`new_str` 结构 [开源]，引用是结构化数组 [开源/待测]，反而更简单。
- 取数层的**工程价值全部可复用**：全局限速、突发桶退避、条目级 429 与全局限流的区分、空页重试、失败重试与保护性中止——这些是 344/432 对话实测踩出来的经验 [码/PLAN.md]，换个站点端点即可继续用。
- 唯一真正的新增风险是**风控未知**：Claude 侧没有对应的实测数据，ChatGPT 的限流画像不能照搬。

工作量估算：**8–12 人天**（熟悉本代码库的前提下），其中重构 3、Claude 适配器 3、UI 适配 2、实测调试与 fixture 2。

---

## 一、现状：这个项目是什么

Tampermonkey userscript，TypeScript + Bun + Vite + vite-plugin-monkey，产物单文件 `inkstone.user.js`，注入 chatgpt.com，把全部对话批量转成 Obsidian 友好的 Markdown。3553 行源码，纯本地处理。[码]

### 分层（作者刻意的两层解耦）

| 层 | 文件 | 行数 | 职责 |
|---|---|---|---|
| 取数 | `src/api.ts` | 313 | ChatGPT backend-api 客户端：token、列表分页、详情、附件签名 URL、全局限速与退避 |
| 转换 | `src/convert/*` | 833 | 纯 TS 零浏览器依赖，`bun test` 可测：线性化、公式、标题、引用、Canvas、代码感知 |
| 编排 | `src/main.ts` | 563 | 抓取 → 转换 → 附件下载 → 落地；两遍抓取 + 水位线推进 |
| 输出 | `src/output/*` | 140 | fflate 打 zip / File System Access 直写 vault |
| 状态 | `src/state.ts` | 128 | 增量水位线 + 设置持久化（GM 存储，回退 localStorage） |
| UI | `src/ui.ts` | 991 | Shadow DOM 液态玻璃面板、FAB 锚定、主题跟随 |
| 离线 | `cli/export.ts` | 370 | 官方导出 zip → Markdown，完全不碰内部 API |

`PLAN.md` 的 P4 路线图第 3 项就写着 **「Claude/Gemini adapter」**，尚未动工——本文即为该项的前置评估。[码]

### 这个项目真正的资产

不是「能导出对话」，市面上一堆脚本都能。是这三样：

1. **失真控制的产品哲学**：未知内容类型 → 原始 JSON 塞折叠 callout，**永不静默丢内容**；引用还原不了 → 剥离，绝不留乱码；附件失败 → 正文留占位 + 完成文案报数。[码 `markdown.ts:default` 分支]
2. **实战限流画像**：列表 `total` 不可靠、列表索引会瞬时降级、突发桶型限流、条目级 429 vs 全局限流的区分、附件 `size` 元数据不可靠。这些写在 `PLAN.md` 的「实战经验」里，是 344 + 432 对话跑出来的。[码]
3. **两条管道一致性**：油猴端与离线 CLI 共用同一个 `assetLink` / `conversationToMarkdown`，保证产出一致。[码 `markdown.ts` 注释]

移植的意义在于：把这三样资产复用到 Claude，而不是再写一个「能导出对话」的脚本。

---

## 二、两侧数据模型对照

| 维度 | ChatGPT（本项目现状 [码]） | claude.ai [开源，2026-07 记录] |
|---|---|---|
| 鉴权 | `GET /api/auth/session` 换 `accessToken`，再带 `Authorization: Bearer` | 同源 cookie 直接够用，**无需换 token**；只需 orgId（`lastActiveOrg` cookie 或 `GET /api/organizations`） |
| 列表 | `GET /backend-api/conversations?offset&limit=100&order=updated` | `GET /api/organizations/{org}/chat_conversations`（分页参数 `limit`/`offset` 见于部分实现，**是否必需/上限 [待测]**） |
| 详情 | `GET /backend-api/conversation/{id}` | `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` |
| 会话结构 | `mapping: Record<id, {message, parent, children}>` 树 | `chat_messages[]` 扁平数组 + `parent_message_uuid` 链 |
| 主线定位 | 从 `current_node` 沿 parent 回溯后 reverse | 从 `current_leaf_message_uuid` 沿 `parent_message_uuid` 回溯后 reverse（**同构**） |
| 角色 | `author.role: user/assistant/system/tool` | `sender: 'human' \| 'assistant'`（无 tool 角色，工具在 content 块里） |
| 消息内容 | `content.content_type` + `parts[]`（单一类型/条消息） | `content: [{type: 'text'\|'thinking'\|'tool_use'\|'tool_result', ...}]`（**一条消息多块、按序交错**） |
| 正文来源 | `parts[]` 拼接 | `content[].text`；注意顶层便利字段 `chat_messages[].text` 在此 rendering mode 下**为空** |
| 思维链 | `content_type: 'thoughts'` → `thoughts[{summary, content}]` | `type: 'thinking'` 块（**字段名 [待测]**） |
| 富文档 | Canvas：`recipient: canmore.*` + JSON payload，`update_textdoc` 走**正则 patch**，重放易失败 | Artifact：`tool_use` name=`artifacts`，`input.command: create/update/rewrite`，update 是**字面量 `old_str`→`new_str`**，`version_uuid` 标记最后一次编辑 |
| 引用 | 正文嵌 **PUA Unicode 标记**（U+E200 区段），靠 `metadata.content_references` 反查还原，官方导出包里连 `matched_text` 都没有，需按数量顺序配对 | 结构化 `citations` 数组（API 版形态见官方文档；**网页版实际形态 [待测]**）；web_search 结果 URL 会 `is_expired` |
| 上传文件 | `metadata.attachments[]` + `sediment://` 指针 → `GET /backend-api/files/{id}/download` 换签名 URL | `files[]`：image→`preview_url`、document→`document_asset.url`+`page_count`、blob→无 URL；另有 `attachments[]` 携带 **`extracted_content` 纯文本**（ChatGPT 无此项） |
| 生成图片 | `multimodal_text` 里的 `asset_pointer` | 走 artifact / 文件 [待测] |
| 时间戳 | epoch 秒（详情）/ ISO（列表）混用 | ISO 字符串 |
| 模型 | 消息级 `metadata.model_slug`（最后一条为准） | 会话级 `model`（可能为 null，老对话需按日期推断 [开源]） |
| 层级 | 无（Branch 对话靠 metadata 回链） | **Projects**：对话可归属 project，ChatGPT 侧无对应概念 [待测字段名] |
| 官方离线导出 | 账号设置导出 zip，含 `conversations.json`（tool/system 被剥离） | 设置 → Privacy → Export data，邮件发 zip，含 `conversations.json`（结构比页内 API 简化 [开源]） |

### 三个关键判断

**① 主线定位同构。** 两侧都是「叶子 + parent 链」模型，`linearize.ts` 的算法（含防环 `seen` 集合、缺 leaf 时的兜底）逻辑照搬，只换字段名。约 30 行改动。[码 + 开源]

**② 内容模型是唯一的结构性差异。** ChatGPT 是「一条消息一种 content_type」，`renderMessage` 用 `switch` 分发；Claude 是「一条消息多个 typed block 按序交错」。现有 `switch` 结构无法直接套用——但这恰恰是引入中间表示（IR）的动机，见第四节。

**③ Claude 侧的脏活更少。** PUA Unicode 引用还原（`citations.ts` 178 行，含「matched_text 可能是裸空格」「turn 号是另一套编号只能按数量配对」这类补丁）和 Canvas 正则 patch 重放（`canvas.ts` 150 行，重放失败要回退原始 JSON）——这两块合计 328 行的复杂度在 Claude 侧都不存在。Claude 的 artifact 折叠只需 30 行左右 [开源实现即约此量级]。

---

## 三、逐模块移植评估

| 模块 | 行数 | 判定 | 说明 |
|---|---|---|---|
| `convert/codeaware.ts` | 78 | **原样复用** | 纯 Markdown 代码块感知，零站点耦合 |
| `convert/headings.ts` | 32 | **原样复用** | ATX 标题降级/剥离，零耦合 |
| `convert/math.ts` | 20 | **原样复用**（行为待验） | `\(\)`→`$` 转换。Claude 输出的公式定界符形态 [待测]：若本就是 `$`，此模块变成幂等空转，无害 |
| `output/zip.ts` | 27 | **原样复用** | |
| `output/fsaccess.ts` | 113 | **原样复用** | |
| `state.ts` | 128 | **复用 + 小改** | 水位线键改 `inkstone:wm:claude:{kind}`；`selectChanged` 已泛型化，直接吃 `updated_at` |
| `api.ts` | 313 | **框架复用，端点重写** | 限速/退避/并发池/分页器/取消令牌**全部保留**；`getAccessToken` 变成 `resolveOrgId`；三个端点换 URL。限流常数需按 Claude 实测重调 |
| `convert/linearize.ts` | 72 | **算法复用，字段重写** | 见上「判断①」 |
| `convert/markdown.ts` | 391 | **拆分重构** | 站点无关部分（frontmatter、文件名净化、callout/fence、Sources 汇总、排版收尾、assetLink）抽成 `render.ts`；`renderMessage` 的 content_type 分发下沉到各站点 adapter |
| `convert/canvas.ts` | 150 | **不移植，另写** | Claude 侧新写 `artifacts.ts`（约 30–40 行，`old_str`→`new_str` 折叠 + `version_uuid` 定稿）。⚠️ 注意开源实现踩过的坑：`String.replace` 必须传**函数**替换器，否则 `new_str` 里的 `$&`/`` $` ``/`$$` 会被当替换模式，静默损坏内容 [开源] |
| `convert/citations.ts` | 178 | **不移植，另写** | Claude 侧按结构化 citations 直接生成链接 + Sources，无需 PUA 处理 |
| `main.ts` | 563 | **编排复用，取数调用改造** | 两遍抓取、水位线合并推进、保护性中止、附件缓存与占位——逻辑全站点无关，只需把 `fetchConversation` 等换成 adapter 调用 |
| `ui.ts` | 991 | **结构复用，锚定与配色重写** | 面板、设置、多选懒加载、进度全部无关站点；FAB 锚点（`[data-testid="share-chat-button"]` / `#prompt-textarea`）与 accent 探测（`html[data-chat-theme]` + `--{theme}-theme-submit-btn-bg`）是 ChatGPT 专属，需为 claude.ai 各写一套 [待测选择器] |
| `cli/export.ts` | 370 | **框架复用，解包重写** | Claude 官方导出 zip 的内部布局与附件命名规则 [待测] |

按行数粗算：**约 40% 原样复用，35% 改造复用，25% 需新写**。

---

## 四、建议的架构改造：SiteAdapter + 中间表示

现在的耦合是隐式的——`ConversationDetail`、`Message` 这些类型名不带站点前缀，但字段全是 ChatGPT 的。硬加 Claude 支持会变成 `if (isClaude)` 遍地。建议先做一次结构性重构：

```
src/
  core/
    ir.ts            # 站点无关的中间表示（新增）
    render.ts        # IR → Markdown（从 markdown.ts 抽出，站点无关）
    math.ts headings.ts codeaware.ts   # 原样迁入
    fetcher.ts       # 限速/退避/并发池/取消（从 api.ts 抽出）
  sites/
    index.ts         # 按 location.host 选 adapter
    chatgpt/{api,types,convert,canvas,citations}.ts
    claude/{api,types,convert,artifacts}.ts
  output/ state.ts ui/
```

### 中间表示草案

```ts
export interface IRConversation {
  source: 'chatgpt' | 'claude'
  id: string
  title: string
  url: string
  createdAt: string        // ISO
  updatedAt: string
  model?: string
  models?: string[]
  extraFrontmatter?: Record<string, string>   // branched_from / project / …
  turns: IRTurn[]
}

export interface IRTurn {
  role: 'user' | 'assistant'
  blocks: IRBlock[]        // 按序，允许交错
}

export type IRBlock =
  | { kind: 'prose'; text: string; sources?: SourceLink[] }      // 已还原引用的正文
  | { kind: 'thinking'; title?: string; text: string }           // 受 thoughts 开关控制
  | { kind: 'tool'; label: string; body: string; lang?: string } // 受 toolTraces 开关控制
  | { kind: 'document'; title: string; docType: string; content: string }  // Canvas / Artifact 终稿
  | { kind: 'asset'; ref: AssetRef }                             // 占位符，由编排层下载改链
  | { kind: 'raw'; label: string; json: unknown }                // 未知类型兜底，永不丢内容
```

这套 IR 让**现有的三个开关语义（`thoughts` / `toolTraces` / `assets`）在两侧完全对齐**：

| 开关 | ChatGPT | Claude |
|---|---|---|
| `thoughts` | `content_type: 'thoughts'` | `type: 'thinking'` 块 |
| `toolTraces` | `content_type: 'code'` / `execution_output` / `recipient !== 'all'` | `type: 'tool_use'` / `tool_result`（artifacts 除外，它归 `document`） |
| `assets` | `attachments[]` + `asset_pointer` | `files[]` + `attachments[].extracted_content` |

`render.ts` 只认 IR，不认站点。CLI 和油猴端继续共用它——两条管道一致性的保证不变。

### 一个 Claude 独有的增益

`attachments[].extracted_content` 直接给出上传文档的**纯文本抽取**。ChatGPT 侧没有这个，只能下载二进制原件。在 Claude 侧可以把它作为 `raw`/`prose` 块内联为引用块（开源实现的做法是整块 `>` 引用，让附件自身的标题不进文档大纲 [开源]）——这让导出的笔记对 RAG 和全文检索**自包含**，是 ChatGPT 版做不到的。值得作为 Claude 侧的差异化特性。

---

## 五、风险与待实测清单

### 风险（按严重度排序）

1. **风控未知（最高）。** 本项目对 ChatGPT 的限流认知是实测出来的：突发桶型、~200 连发触发连环 429、列表索引会瞬时降级、旧对话会渐进式变 429→404 且**恢复要数小时** [码/PLAN.md]。Claude 侧**没有任何对应数据**。批量抓取整个历史是明显的异常行为模式，不能假设 ChatGPT 的参数（并发 2、间距 800ms、每 80 请求歇 25s）在 Claude 也安全。
   **应对**：首版把并发锁死 1、间距起步 1500ms 以上，先用 10 条 / 50 条分级试跑，观察 429 与 `Retry-After`，再逐步放宽。宁可慢，不可触发账号级限制。
2. **内部 API 无稳定性保证。** 两侧同等风险，且 Claude 侧无历史稳定性数据。缓解方式与现有一致：未知字段从宽、未知类型不丢内容、失败不中断整条流水线。
3. **附件 URL 的会话绑定。** `preview_url` / `document_asset.url` 是同源 claude.ai 地址，只在登录同账号时可取 [开源]。能否在脚本里直接 `fetch` 到字节 [待测]；若返回重定向到 CDN 且跨域，附件管道需要额外处理。
4. **CSP。** claude.ai 的 CSP 会限制 `connect-src`；同源 API 调用不受影响，但 **vite dev 模式从 localhost 加载脚本可能被拦** [开源提到 CSP 无法在 CI 验证]。开发时要准备好直接用 build 产物在 Tampermonkey 里验证。
5. **`is_expired` 的搜索结果。** Claude 的 web 搜索结果 URL 会被标记过期 [开源]。把过期链接写进笔记会制造死链——建议沿用现有哲学：能还原的还原，不能的剥离并在 callout 里说明，不留假链接。

### 待实测清单（建议按顺序打通）

| # | 待确认 | 怎么测 |
|---|---|---|
| 1 | `chat_conversations` 列表是否分页、上限多少、是否支持 `order` | 带/不带 `limit`&`offset` 各调一次，比对返回条数与账号实际对话数 |
| 2 | 列表项字段名（`uuid` / `name` / `updated_at` / `project_uuid`） | dump 首项键名 |
| 3 | `thinking` 块的字段名与是否有 summary | 找一条开了扩展思考的对话 dump 该块的键 |
| 4 | 网页版 citations 的实际挂载位置与形态 | 找一条带 web 搜索的对话 dump text 块的全部键 |
| 5 | 附件 URL 能否直接取到字节、Content-Type 是否正确 | 对 `preview_url` 做一次 `fetch` 看 status 与 headers |
| 6 | Claude 输出里公式的定界符形态（`$` 还是 `\(`） | 找一条带公式的对话看 `content[].text` 原文 |
| 7 | Projects 归属字段名 | dump 一条项目内对话的会话级键 |
| 8 | 官方导出 zip 的内部布局与附件命名 | 申请一次数据导出，解包看目录 |
| 9 | claude.ai 的 FAB 锚点选择器与主题变量 | 在页面上找稳定的 share 按钮 / composer 容器；读 `:root` 的 CSS 变量 |

### 探针脚本

打通 1–7 项，只需在 claude.ai 打开一条对话后，把下面这段贴进浏览器控制台。它**只打印字段名与类型骨架，不打印任何对话内容**：

```js
(async () => {
  const org = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1]
  const id = location.pathname.split('/').pop()
  const skeleton = (v, d = 0) => {
    if (v === null) return 'null'
    if (Array.isArray(v)) return v.length ? [skeleton(v[0], d + 1)] : []
    if (typeof v !== 'object') return typeof v
    if (d > 4) return '…'
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skeleton(x, d + 1)]))
  }
  const j = async (u) => (await fetch(u, { credentials: 'include' })).json()

  const list = await j(`/api/organizations/${org}/chat_conversations?limit=5&offset=0`)
  console.log('列表条数', Array.isArray(list) ? list.length : '非数组')
  console.log('列表项骨架', skeleton(Array.isArray(list) ? list[0] : list))

  const conv = await j(
    `/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`,
  )
  console.log('会话级键', Object.keys(conv))
  console.log('消息级键', [...new Set(conv.chat_messages.flatMap(Object.keys))])
  console.log('内容块类型', [
    ...new Set(conv.chat_messages.flatMap((m) => (m.content || []).map((b) => b.type))),
  ])
  console.log('tool_use 名称', [
    ...new Set(
      conv.chat_messages.flatMap((m) =>
        (m.content || []).filter((b) => b.type === 'tool_use').map((b) => b.name),
      ),
    ),
  ])
  for (const t of ['text', 'thinking', 'tool_use', 'tool_result']) {
    const b = conv.chat_messages.flatMap((m) => m.content || []).find((x) => x.type === t)
    if (b) console.log(`${t} 块骨架`, skeleton(b))
  }
  const f = conv.chat_messages.flatMap((m) => m.files || [])[0]
  if (f) console.log('files[0] 骨架', skeleton(f))
})()
```

---

## 六、建议的实施路径

**P0 · 离线通道先行（1–2 天，零风控风险）**
用 Claude 官方数据导出的 zip 走 CLI 通道。不碰内部 API，不动 UI，纯粹验证转换层：Claude JSON → IR → Markdown。产出是可回归的 fixture 和一条能跑通的管道。这一步的价值是**把最不确定的转换质量问题，放在最没有风险的环境里解决**。

**P1 · 结构重构（3 天）**
落地 `core/` + `sites/` + IR，把现有 ChatGPT 逻辑迁进 `sites/chatgpt/`，`bun test` 全绿——即现有 8 个测试文件必须一个不改地通过（`markdown.test.ts` 等可能需改导入路径，但断言不变）。这是安全网：重构不改行为。

**P2 · Claude 取数层（2–3 天）**
`sites/claude/api.ts` 复用 `core/fetcher.ts`，端点换掉，限流参数保守起步。先只做单对话导出（风险最小），实测跑通后再开批量。

**P3 · UI 适配（1–2 天）**
`vite.config.ts` 的 `match` 加 `https://claude.ai/*`；FAB 锚点与 accent 探测按站点分派。现有的「找不到锚点就不出现、锚点消失 4s+ 才整体隐藏」策略直接沿用——它本来就是为「页面改版」设计的防御。

**P4 · 批量与增量（1–2 天）**
列表分页器 + 水位线，按 P2 实测出的限流画像调参。跑一次全量，把 Claude 侧的实战经验补进 `PLAN.md`——这份文档是本项目最值钱的部分之一，Claude 侧应当有对应的一节。

### 一个战术建议

先做 **P0 + 单对话导出**，发一个 `0.3.0-alpha`。这样能在真实用户的真实数据上暴露转换质量问题（公式、artifact、附件），而完全不触碰批量抓取的风控风险。批量放到最后，等限流画像清楚了再开。

---

## 七、参考

- 本仓库 `PLAN.md`（ChatGPT 侧实战经验，2026-07）
- [agarwalvishal/claude-chat-exporter](https://github.com/agarwalvishal/claude-chat-exporter) — 单文件控制台脚本，其 `CLAUDE.md` 记录了迄今最完整的 claude.ai 内部 API 响应契约，且明确区分「已验证」与「假设」，本文的 [开源] 结论多出自此
- [socketteer/Claude-Conversation-Exporter](https://github.com/socketteer/Claude-Conversation-Exporter) — Chrome 扩展，含列表接口与批量导出实现
- [Emnolope/claude-conversation-export](https://github.com/Emnolope/claude-conversation-export) — `tree=True` 全分支导出
- [Claude Platform Docs · Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) / [Citations](https://platform.claude.com/docs/en/build-with-claude/citations) — API 版引用结构（网页版是否一致待测）
