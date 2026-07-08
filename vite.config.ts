import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'gexport — ChatGPT 对话导出',
        namespace: 'https://github.com/ZhenHuangLab/gexport',
        description: '高保真批量导出 ChatGPT 对话为 Obsidian 友好的 Markdown（公式 / 引用 / 附件）',
        match: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
        icon: 'https://chatgpt.com/favicon.ico',
        'run-at': 'document-idle',
        noframes: true,
        grant: ['GM_getValue', 'GM_setValue'],
      },
      build: {
        fileName: 'gexport.user.js',
      },
    }),
  ],
})
