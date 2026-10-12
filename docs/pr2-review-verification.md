# PR #2 审查核实与登录环境诊断

本轮复核：[PR #2 最新审查](https://github.com/ZhenHuangLab/inkstone/pull/2#pullrequestreview-5477994378)，审查基线为 `4f5ec79`。上游已认可批次护栏顺序，并提出共享失败附件重复请求和 URL 附件命名兼容两项非阻塞意见。此前的 [工作区、水位线与沙箱意见](https://github.com/ZhenHuangLab/inkstone/pull/2#issuecomment-5910947602) 继续由本分支回归覆盖。

| 问题 | 代码核实 | 修复后的行为 |
| --- | --- | --- |
| 多组织账号错误选择第一项 | `resolveOrgId` 在组织接口成功时直接选第一条 UUID，当前活跃组织仅在请求失败后读取 | 将 `lastActiveOrg` 与成员组织匹配；只有一个组织时可直接使用；多个组织且无法匹配时弹出工作区选择，取消后停止。接口失败时停止，不凭未经核对的 cookie 继续请求 |
| 旧水位线没有迁移 | 读取键由 `markdown/json` 改成 `chatgpt:markdown/json`，存储层没有回退 | 新键缺失时一次性复制旧记录；已有新记录（包括重置后的 `{}`）优先；Claude 不读取旧 ChatGPT 记录 |
| 附件发现失败仍推进完整成功水位线 | 沙箱请求失败返回 `sandboxUnavailable`，正文成功落盘后批量层仍记录更新时间 | IR 显式携带附件发现失败状态；正文正常保存；附件开启时在汇总和 `_failures.json` 说明不完整，移除该条旧水位线，下次增量重试。原始 JSON 或关闭附件的导出仍可完成 |
| 带 Retry-After 的 429 在护栏生效前先等待并重试 | 已认可的 fetcher 修复将护栏放在冷却与实际请求之前 | 首次全局限流信号立即停止，排队请求不会继续发送；`maxAttempts` 注释明确表示首次请求后的重试次数 |
| 多个对话共用持续失败附件时重复请求 | 在 `4f5ec79` 实际构建上复现：三个 ChatGPT 对话、两遍抓取共发出 4 次附件请求 | 将 #4 已验证的每遍 Promise 缓存移入 #2，同遍共享进行中及失败结果，下一遍重新尝试，成功结果继续复用 |
| 无 UUID 附件的安全命名改变旧版文件名 | 地址摘要避免相同 URL 尾部造成文件覆盖，但升级后重导会改变名称 | 两份 README 明确实际重导的笔记才使用新名称，既有附件不自动改名或删除 |

共享导出修复与浏览器回归现在全部在 #2；#4 只承接界面增量，见 [PR 范围与合并顺序](./pr-merge-order.md)。

## 自动验证

2026-10-12（Asia/Hong_Kong）独立构建 #2：`bun test` 194 pass / 0 fail；`bun run typecheck` 和 `bun run build` 通过。导出 Chromium 回归 15 个场景通过，使用本分支实际构建产物，不依赖 #4 的界面实现。

回归测试覆盖当前组织不是第一项、组织选择/取消、cookie 损坏、单组织、GM/localStorage 升级迁移、重置后不复活旧记录，以及正文保留与附件发现失败标记。

浏览器检查验证 503 后保留正文/失败汇总/不推进水位线，接口恢复后未变化对话重新导出并补齐文件，再次增量不重抓；另外检查已有水位线失效、关闭附件、JSON 导出和组织选择/取消。新增三个 ChatGPT 对话共享失败附件的恢复/持续失败场景（每遍一次请求），以及三个 Claude 对话共享失败附件的单并发场景（本次一次请求、下一次增量恢复后一次请求，补齐三条水位线）。prepare/list/detail/sandbox/asset 五个入口的 Retry-After 中止检查继续通过。

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bunx playwright install chromium
bun run build
node scripts/check-export-browser.mjs
```

已安装兼容 Chromium 时，可设置 `INKSTONE_BROWSER_EXECUTABLE` 指向其可执行文件。浏览器检查拦截页面的全部网络请求，不连接真实 Claude 账号。

## 真实登录环境检查

提交者已反馈本次登录环境手工检查无误。以下步骤保留用于复查当前工作区标记、组织列表形态与沙箱端点可用性。

1. 在已登录的 `claude.ai` 打开一条包含生成文件的对话。若有个人和团队工作区，先切到非列表第一项的工作区。
2. F12 → Console，复制并运行 [claude-workspace-probe.js](./claude-workspace-probe.js) 的全部内容。
3. 保存 `INKSTONE_CLAUDE_WORKSPACE_PROBE_BEGIN/END` 之间的 JSON。也可在单组织账号或 `/new` 页运行，但未覆盖的检查会明确标为跳过。

探针最多发出 3 次同源 GET，间隔 1500ms，遇 HTTP 错误立即停止，无自动重试。不输出 cookie 值、组织名称/UUID、对话正文/UUID、文件路径或登录凭据。为检查结构，会读取当前对话详情和沙箱清单的响应；只将计数、布尔值和 HTTP 状态写入报告。

关注 `workspace.activeMembershipIndex`、`workspace.activeIsFirst`、`workspace.selectionRequiresUser`、`workspace.cookieChangedDuringProbe`，以及 `current-conversation` / `sandbox-list` 的请求状态。切换工作区后分别运行，报告应与实际操作对应；如果活跃 cookie 缺失或不匹配，先保留报告，导出时会要求显式选择。

复查时可安装修复后的脚本，确认工作区选择框和实际下载结果。上述自动测试使用合成数据；本次真实登录环境的手工结论由提交者提供。
