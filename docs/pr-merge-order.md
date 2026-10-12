# PR 范围与合并顺序

| PR | 本次范围 | 独立验证 |
| --- | --- | --- |
| [#2](https://github.com/ZhenHuangLab/inkstone/pull/2) `feat/claude-adapter` | 站点适配器与通用导出基础、Claude 支持、批次护栏、水位线迁移、附件失败重试与每遍去重、附件命名兼容说明 | 单元测试、typecheck、build、导出浏览器回归 |
| [#4](https://github.com/ZhenHuangLab/inkstone/pull/4) `fix/chatgpt-redesign` | 基于 #2 的 ChatGPT DOM/主题/层叠及定位修复、锚点与定位方式契约、实时缩放重选、对应界面探针与浏览器回归 | 单元测试、typecheck、build、导出及界面浏览器回归 |

共享附件修复及导出回归归入 #2。#4 相对 #2 不再修改 `src/main.ts`、`scripts/check-export-browser.mjs` 或两份 README；Claude 适配器在 #4 中的改动仅用于同步界面锚点返回契约。

#4 使用了 #2 引入的 `SiteAdapter` 和通用 UI，因此先合入 #2，再合入 #4。审查 #4 的界面增量可使用 [分支比较](https://github.com/pmwl0128/inkstone/compare/feat/claude-adapter...fix/chatgpt-redesign)。两个 PR 保留原分支与提交历史，#4 合入 #2 当前提交，使共同代码只在 #2 继续维护。

合并前重新获取上游和 fork，检查两条分支的最新 head。若 #2 继续修改，先将修改同步进 #4，再验证独立差异和最终构建。

2026-10-12 使用临时 commit/tree 验证：#2 普通 merge 后，#4 无冲突且结果与已测试的 #4 tree 一致。#2 squash 后直接合入旧 #4 会出现适配器文件 add/add 等冲突；将相对 #2 的界面增量重放到 squash 后的 tree 则无冲突，结果仍完全一致。

若上游 squash/rebase 合入 #2，可在干净工作区执行以下步骤，保留原 #4 分支并创建新的候选分支。差异文件由 Git 原生写出，PowerShell 不需要重定向或转换编码。

```powershell
git fetch upstream
git diff --binary --output=pr4-ui.local feat/claude-adapter fix/chatgpt-redesign
git switch -c fix/chatgpt-redesign-replayed upstream/main
git apply --index pr4-ui.local
git commit -m "fix(ui): adapt to redesigned ChatGPT pages"
bun test
bun run typecheck
bun run test:browser
```

确认 `upstream/main` 已包含 #2，且候选分支只包含界面增量后，再更新 #4 的分支。上游若有额外变更，仍以重新应用与门禁结果为准；不能凭旧分支祖先关系判断 GitHub 的差异范围。

浏览器回归使用实际构建的 userscript 和合成 DOM/API，全部网络请求被拦截。真实登录环境、非公开 API 的现状和页面灰度布局需要现场复查。
