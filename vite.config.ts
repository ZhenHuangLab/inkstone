import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

// 砚台图标（墨滴 + 下载箭头）。内联 data URI，不依赖任何站点的 favicon——
// 脚本现在同时服务 chatgpt.com 与 claude.ai，借用其中一家的图标会名不副实。
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1e6b72" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>`,
  )

export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: {
          '': 'Inkstone — ChatGPT & Claude Conversation Exporter',
          'zh-CN': 'Inkstone — ChatGPT / Claude 对话导出',
        },
        namespace: 'https://github.com/ZhenHuangLab/inkstone',
        description: {
          '':
            'Grind ChatGPT and Claude conversations into Obsidian-friendly Markdown — ' +
            'high-fidelity export (math / citations / attachments / artifacts)',
          'zh-CN':
            '砚 · 把 ChatGPT 与 Claude 对话研磨成 Obsidian 友好的 Markdown，' +
            '高保真导出（公式 / 引用 / 附件 / Artifact）',
        },
        match: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://claude.ai/*'],
        icon: ICON,
        license: 'GPL-3.0-only',
        'run-at': 'document-idle',
        noframes: true,
        grant: ['GM_getValue', 'GM_setValue'],
        // 指向 GitHub Releases 的固定「最新版」地址：发新 release 后 Tampermonkey 自动更新
        downloadURL: 'https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js',
        updateURL: 'https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js',
      },
      build: {
        fileName: 'inkstone.user.js',
      },
    }),
  ],
})
