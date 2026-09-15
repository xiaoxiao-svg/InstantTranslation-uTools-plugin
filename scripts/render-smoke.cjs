/**
 * 渲染冒烟：在 jsdom 里真实挂载 dist 产物，setup + onMounted + 模板渲染全跑一遍。
 * 静态检查（check-template）只能抓"模板引用了不存在的标识符"，抓不住运行时才炸的
 * 引用错误/取值错误——2026-09-15 voiceOf 事故的真正补课。挂在 build 链最后，
 * 拿 dist/assets/index-*.js 当输入，mock 掉 window.preload / utools / TTS 服务。
 */
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const distAssets = path.join(__dirname, '..', 'dist', 'assets')
const bundle = fs.readdirSync(distAssets).find((f) => /^index-.*\.js$/.test(f))
if (!bundle) { console.error('[render-smoke] dist/assets 里没有 index-*.js，先 vite build'); process.exit(1) }

const errors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message))
vc.on('error', (m) => errors.push('console.error: ' + m))

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/', virtualConsole: vc, pretendToBeVisual: true,
})

// jsdom 的 window 属性铺到 globalThis（Vue 运行时到处摸 document/navigator）
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (!(k in globalThis)) { try { globalThis[k] = dom.window[k] } catch {} }
}
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.navigator = dom.window.navigator

const cfg = {
  modelDir: 'C:/smoke/models', modelId: '1.8b-q4', voicePackMap: { en: '', zh: 'kokoro-v1_1' }, kokoroSid: { zh: 3, en: 0 },
  tgtLang: 'zh', srcLang: 'auto', style: '日常', terms: {},
}
const KO_VOICES = [
  { sid: 0, name: 'af_maple', group: 'en', label: '英语' },
  { sid: 3, name: 'zf_001', group: 'zh-f', label: '中文女声' },
  { sid: 58, name: 'zm_009', group: 'zh-m', label: '中文男声' },
]
const voices = [
  { id: 'kokoro-v1_1', kind: 'kokoro', flagship: true, label: 'Kokoro 多语种', size: '348MB', lang: '', installed: true, model: 'model.onnx' },
  { id: 'en-amy', kind: 'vits', label: '英语 · Amy 女声', size: '64MB', lang: 'en', installed: false, model: 'en_US-amy-medium.onnx' },
  { id: 'zh-matcha', kind: 'matcha', label: '中文 · 女声 自然', size: '127MB', lang: 'zh', installed: false, model: 'model-steps-3.onnx', vocoder: { file: 'vocos-16khz-univ.onnx' } },
]
// 挂载路径会同步调到的 preload API 都给良性返回；其余靠 Proxy 兜底返回 undefined
window.preload = new Proxy({
  getConfig: () => cfg,
  saveConfig: () => true,
  readStore: () => ({}),
  writeStore: () => true,
  entryKeywords: () => ['翻译', 'fy'],
  engineInfo: () => ({
    installed: true, marker: 'b10734', engineDir: 'C:/smoke/engine', platform: 'win32/x64', version: 'b10734',
    target: { key: 'win-vulkan-x64', label: 'Windows x64（Vulkan GPU 加速）', exe: 'llama-server.exe', size: '33.5MB', url: 'https://example.invalid/llama.zip' },
    mirrors: [],
  }),
  listModels: () => [{ id: '1.8b-q4', label: '1.8B · Q4_K_M', size: '1.1GB', ram: '~1.6GB', file: 'hy-mt2-1.8b-q4.gguf', installed: true }],
  modelExists: () => true,
  getModelFile: () => 'C:/smoke/models/hy-mt2-1.8b-q4.gguf',
  modelLinks: () => ({ rows: [], file: '', size: '' }),
  voicePackInfo: () => ({ voices, espeakReady: false, runtimeReady: false, kokoroVoices: KO_VOICES, kokoroDefaultSid: { zh: 3, en: 0 } }),
  ensureModel: async () => ({ ok: true }),
  translate: async () => ({ ok: false, reason: 'smoke' }),
  ttsWarmup: () => ({ ok: true, warming: [] }),
  readTtsErrorLog: () => '',
  ttsErrorLogPath: () => '',
}, {
  get(t, k) {
    if (k in t) return t[k]
    return () => undefined // 未枚举到的 API：调用返回 undefined，别在这里炸
  },
})
window.utools = new Proxy({ copyText: () => {}, showOpenDialog: () => [], showItemInFolder: () => {} }, {
  get(t, k) { return k in t ? t[k] : (() => undefined) },
})

process.on('uncaughtException', (e) => errors.push('uncaught: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)))
dom.window.addEventListener('error', (e) => errors.push('window.onerror: ' + (e.message || e.error)))

import('file:///' + path.join(distAssets, bundle).replace(/\\/g, '/'))
  .then(async () => {
    // 等挂载与 onMounted 的异步链（预热定时器等）跑完
    await new Promise((r) => setTimeout(r, 1200))
    const app = dom.window.document.querySelector('#app')
    const html = app ? app.innerHTML : ''
    const text = app ? app.textContent : ''
    if (!html.trim()) errors.push('挂载后 #app 为空——组件没有渲染出来')
    if (!/翻译|朗读/.test(text)) errors.push('#app 内容不含预期文案，疑似白屏: ' + text.slice(0, 80))
    // 模拟点开「设置」——语音区块（音色下拉/试听）是 2026-09-15 事故现场，必须真实渲染一遍
    if (!errors.length) {
      const btns = [...dom.window.document.querySelectorAll('button')]
      const settingsBtn = btns.find((b) => /设置/.test(b.textContent || ''))
      if (!settingsBtn) errors.push('主界面找不到「设置」入口（按钮清单: ' + btns.map((b) => (b.textContent || '').trim().slice(0, 8)).join(',') + '）')
      else {
        settingsBtn.click()
        await new Promise((r) => setTimeout(r, 600))
        const t2 = dom.window.document.querySelector('#app').textContent || ''
        for (const probe of ['朗读语音', 'Kokoro', '试听', '中文音色']) {
          if (!t2.includes(probe)) errors.push('设置页缺少预期区块文案: ' + probe)
        }
        // 已装旗舰包的 mock 下：不出现「一键启用」，出现旗舰行的「删除」
        if (t2.includes('一键启用')) errors.push('Kokoro 已装时不应再显示「一键启用」')
        if (!t2.includes('删除')) errors.push('设置页缺少旗舰包「删除」按钮')
        if (!dom.window.document.querySelector('.voice-select')) errors.push('设置页没有渲染出音色下拉（.voice-select）')
      }
    }
    if (errors.length) {
      console.error('[render-smoke] 渲染冒烟失败：')
      for (const e of errors) console.error('  - ' + e)
      process.exit(1)
    }
    console.log('[render-smoke] dist 真实挂载渲染 ✓（#app ' + html.length + ' 字符，含主界面文案）')
    process.exit(0)
  })
  .catch((e) => {
    console.error('[render-smoke] 挂载抛错：' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e))
    process.exit(1)
  })
