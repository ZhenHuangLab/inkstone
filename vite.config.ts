import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'Inkstone — ChatGPT 对话导出',
        namespace: 'https://github.com/ZhenHuangLab/inkstone',
        description: '砚 · 把 ChatGPT 对话研磨成 Obsidian 友好的 Markdown，高保真批量导出（公式 / 引用 / 附件）',
        match: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
        icon: 'https://chatgpt.com/favicon.ico',
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
