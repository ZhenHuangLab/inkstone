# PR #4 审查核实与登录环境诊断

本轮复核：[PR #4 最新审查](https://github.com/ZhenHuangLab/inkstone/pull/4#pullrequestreview-5478266420)，审查基线为 `6e49641`。上游已认可密集顶栏、共享护栏及锚点契约修复，剩余意见为共享导出代码的合并耦合和缩放后的短暂定位延迟。

## 代码结论

共享附件修复、完整导出回归和命名兼容说明已移入 #2，并同步进本分支。#4 相对 #2 只保留 13 个界面相关文件，不再改动 `src/main.ts`、导出回归脚本及 README。普通 merge 和 squash 后重放界面增量的验证与步骤见 [PR 范围与合并顺序](./pr-merge-order.md)。

已复现缩放延迟：360px 密集顶栏扩至 1440px 后，旧代码仍在 y=64 的下方位置，等待 2s 重绑才回到 y=10。`resize` 和锚点 ResizeObserver 现在立即重选锚点与定位方式；锚点或方式变化时收起面板，同一方式下保持展开。位置同步继续使用一次绑定的锚点/方式组合。

推送前自审补充修复两处实际复现的问题：普通动画模式的旧 right/bottom 过渡会在缩放后短暂把按钮移出视口，顶栏按钮与面板现在直接采用新坐标，保留颜色及展开动画；频繁重绑会将按调用次数计算的锚点缺失提前判为超时，现改为实际持续缺失 4s 后才隐藏。两处均有修复前失败、修复后通过的浏览器用例。

最高层 overlay 的 CSS 与内联设置仍仅限 ChatGPT。Claude 保留非定位 host 与按钮/面板的 40/41，使页面浮层可以覆盖。密集顶栏没有空间时按钮放到完整顶栏下方，避免越界或覆盖原生控件。

## 自动验证范围

2026-10-12（Asia/Hong_Kong）本次验证：`bun test` 203 pass / 0 fail；`bun run typecheck`、`bun run build` 通过。UI Chromium 回归 37 个场景、导出 Chromium 回归 15 个场景通过。

[check-ui-browser.mjs](../scripts/check-ui-browser.mjs) 使用实际构建的 userscript 和 Chromium，并拦截全部页面请求，验证：

- ChatGPT 的会话/新会话 × 聊天/工作四种合成 DOM，包含隐藏重复锚点与错误位置的 header，实际调用适配器选择锚点。
- 密集顶栏及宽动作组在普通动画/减少动画两种偏好下分别于 1440/360/320/844/1280px 连续缩放；暂停维护计时器验证立即重选，实际点击检查面板收起/保持展开、按钮避让和视口边界。另检查重复 resize、锚点持续缺失 4s 隐藏与恢复。原有 360x740、390x844、844x390、1440x900 静态布局继续覆盖。
- 顶栏和输入框两种按钮位置、位置切换后的收起，以及 URL 切换后的收起。
- ChatGPT 按钮位于高层顶栏 surface 之上，页面 author CSS 不会覆盖关键 host 设置；浏览器原生 modal 位于 Inkstone 之上。
- Claude host 不建立独立层叠上下文，普通页面上按钮可点击；`z-index: 50` 页面浮层打开时实际覆盖按钮和面板，关闭后恢复。
- [ui-overlay-probe.js](./ui-overlay-probe.js) 在覆盖前后的命中报告与浏览器实际结果一致，无 API 请求和页面异常。

```bash
bun install --frozen-lockfile
bunx playwright install chromium
bun run test:browser
```

也可设置 `INKSTONE_BROWSER_EXECUTABLE` 使用已有的 Chromium。Claude 两种位置的正常/覆盖截图保存在 `dist/claude-*-normal.png` 和 `dist/claude-*-overlay.png`。

## 真实登录环境检查

2026-10-06，提交者反馈真实登录环境手工判断无误，并确认推送修复与更新 PR。合成 DOM 验证覆盖层叠规则与已知锚点选择；以下步骤保留用于复查实际菜单、搜索结果、设置浮层及其他灰度布局。

先从当前分支构建 `dist/inkstone.user.js` 并安装到 Tampermonkey，刷新页面确认生效；若安装了其他 Inkstone 版本，应只启用本次测试版本。然后在 F12 → Console 运行 [ui-overlay-probe.js](./ui-overlay-probe.js) 全文，保存 `INKSTONE_UI_OVERLAY_PROBE_BEGIN/END` 之间的 JSON。

| 站点 | 需要采集的状态 |
| --- | --- |
| Claude | 普通页面、Inkstone 面板打开、页面菜单打开、搜索结果打开、设置/usage 浮层打开；顶栏/输入框两种位置各测一遍 |
| ChatGPT | 会话/新会话 × 聊天/工作四种布局；顶栏/输入框两种位置；页面菜单与设置浮层打开时；暗色主题 |

重点看 `host.style`、`fab.style.zIndex`、`panel.style.zIndex`、`fabHitTests`、`panelHitTests` 和 `visibleOverlays`。如果浮层与按钮/面板位置重叠，Claude 的 `inkstoneIsTop` 应为 `false`，报告中的 `top` 应是页面浮层。若两者不重叠，该字段为 `true` 不能单独证明层级有误，需要结合矩形位置判断。

探针不发网络请求，也不读取 cookie、storage、正文、输入值、原始 URL 或对象名称。没有检测到原生 Inkstone host 时，`installed` 为 `false`；先确认当前构建已安装并刷新页面，再采集。

Claude 工作区和沙箱接口的真实诊断另见 [PR #2 核实记录](./pr2-review-verification.md)。
