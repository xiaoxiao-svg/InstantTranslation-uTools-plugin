/**
 * TTS 合成速度实测：冷启动 / 热态首句 / 长文实时倍率。
 * 复用 tts-chain-smoke 装好的产物（userData 目录动都不动）。
 *
 * 为什么分开测冷/热：引擎加载和合成是两笔时间，用户感受到的"等太久"可能出在任何一笔。
 * 首句用 8~16 字，因为 tts-server 的 SEG_HEAD_MAX=8 —— 首段多长，首字就等多久。
 *
 * 用法: node scripts/tts-perf.cjs
 */
const path = require('path')

const UDATA = path.join(__dirname, '..', '..', '..', 'bench-kokoro', 'e2e', 'udata')

global.window = {}
global.utools = {
  getPath: () => UDATA,
  copyText: () => {}, showOpenDialog: () => [], showItemInFolder: () => {},
  onPluginEnter: () => {}, setExpendHeight: () => {},
}

require(path.join(__dirname, '..', 'dist', 'preload.js'))
const p = window.preload

// WAV: 44 字节头 + 16bit 单声道
const wavMs = (b64, sr) => ((b64.length * 3 / 4 - 44) / 2 / sr) * 1000

const CASES = [
  ['zh-huayan', '人工智能正在改变我们的生活方式。', '中文 16 字（首段量级）'],
  ['zh-huayan', '人工智能正在改变我们的生活方式，本地翻译工具也因此变得越来越实用。它不需要联网，速度快，还能保护隐私。', '中文 53 字（长文）'],
  ['en-amy', 'Artificial intelligence is changing how we live.', '英文 9 词（首段量级）'],
  ['en-amy', 'Artificial intelligence is changing how we live and work. Local translation tools are becoming more practical every day, and they work without an internet connection.', '英文 30 词（长文）'],
]

// 点击朗读 → 第一块 PCM 到达（这才是用户真正等的那个数）
function firstChunk(id, text) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    const fin = (v) => { if (!settled) { settled = true; resolve(v) } }
    const s = p.ttsSpeakStream(text, id, {
      // cancel 必须同步调用：它内部操作的是模块级 ttsStreamReq，延迟执行会误杀下一个请求
      onChunk: () => { fin(Date.now() - t0); s.cancel() },
      onDone: () => fin(-1),
      onError: (e) => fin('ERR ' + e.message),
    })
    setTimeout(() => fin('TIMEOUT'), 60000)
  })
}

;(async () => {
  const info = p.voicePackInfo()
  console.log('语音包:', info.voices.map(v => v.id + '=' + (v.installed ? '已装' : '未装')).join(' '))

  for (const [id, text, label] of CASES) {
    const runs = []
    for (let i = 0; i < 4; i++) {
      const t = Date.now()
      const r = await p.ttsSynthesize(text, id).catch(e => ({ ok: false, reason: e.message }))
      const ms = Date.now() - t
      if (!r.ok) { console.log(`${id} ${label}: FAIL ${r.reason}`); break }
      if (i === 0) {
        const audioMs = wavMs(r.wav, r.sampleRate)
        console.log(`${id} ${label}: 冷启动 ${ms}ms（含引擎加载），音频 ${audioMs.toFixed(0)}ms`)
      } else runs.push(ms)
    }
    if (runs.length) {
      const avg = runs.reduce((a, b) => a + b, 0) / runs.length
      const r0 = await p.ttsSynthesize(text, id)
      const audioMs = wavMs(r0.wav, r0.sampleRate)
      console.log(`   热态平均 ${avg.toFixed(0)}ms（${runs.map(x => x + 'ms').join(' ')}）| 音频 ${audioMs.toFixed(0)}ms → ${(audioMs / avg).toFixed(1)}x 实时`)
    }
  }
  console.log('\n--- 首块延迟：点击朗读 → 第一个字出声（引擎已加载；每次之间留间隔让服务端清干净）---')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (const [id, text] of [
    ['zh-huayan', '人工智能正在改变我们的生活方式。'],
    ['zh-huayan', '人工智能正在改变我们的生活方式，本地翻译工具也越来越实用。'],
    ['en-amy', 'Artificial intelligence is changing how we live.'],
  ]) {
    const times = []
    for (let i = 0; i < 3; i++) { times.push(await firstChunk(id, text)); await sleep(1500) }
    console.log(`${id} ${text.slice(0, 12)}…: ${times.map(t => t + 'ms').join(' / ')}`)
  }
  process.exit(0)
})()
