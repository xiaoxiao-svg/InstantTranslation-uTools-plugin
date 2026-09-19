/**
 * TTS 一键启用链路冒烟：在纯 Node 里加载 dist/preload.js（stub utools），
 * 真实执行 installVoiceBundle 全链：下载运行时(npmmirror) → 解压 → 下语音包 → 起子进程 → 合成。
 * 专门抓"真机能跑/本地脚本不跑"类断点——2026-09-15「一键启用卡在准备安装」的复现入口。
 *
 * 中英各合成一句是重点：两个语音包都靠 espeak 音素化（各自的 espeak-ng-data 装进共享
 * _espeak），只跑一句中文验证不到英文那条路径的依赖是否齐全。
 *
 * 用法: node scripts/tts-chain-smoke.cjs [--keep]   (--keep 保留产物便于复查)
 */
const fs = require('fs')
const path = require('path')

const UDATA = path.join(__dirname, '..', '..', '..', 'bench-kokoro', 'e2e', 'udata')
const KEEP = process.argv.includes('--keep')
if (!KEEP) { try { fs.rmSync(UDATA, { recursive: true, force: true }) } catch {} }
fs.mkdirSync(UDATA, { recursive: true })

global.window = {}
global.utools = {
  getPath: (k) => (k === 'userData' ? UDATA : UDATA),
  copyText: () => {},
  showOpenDialog: () => [],
  showItemInFolder: () => {},
  onPluginEnter: () => {},
  setExpendHeight: () => {},
}

const t0 = Date.now()
const log = (...a) => console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's]', ...a)
process.on('uncaughtException', (e) => { log('未捕获异常:', e.stack || e.message); process.exit(1) })

require(path.join(__dirname, '..', 'dist', 'preload.js'))
const p = window.preload
if (!p || !p.installVoiceBundle) { log('preload 挂载失败或缺 installVoiceBundle'); process.exit(1) }
log('preload 已加载，开始一键启用链路（运行时 ~22MB + 华燕 64MB + Amy 64MB）')

;(async () => {
  let lastPct = -1
  try {
    const r = await p.installVoiceBundle({
      onPhase: (msg) => log('phase:', msg),
      onProgress: (got, total) => {
        const pct = total ? Math.round((got / total) * 100) : -1
        if (pct >= 0 && pct >= lastPct + 25) { lastPct = pct; log('progress:', pct + '%') }
      },
    })
    log('installVoiceBundle 返回:', JSON.stringify(r))
  } catch (e) {
    log('installVoiceBundle 失败:', e.message)
    log('last-tts-error:', (() => { try { return p.readTtsErrorLog() } catch { return '' } })())
    process.exit(1)
  }

  const info = p.voicePackInfo()
  log('runtimeReady=', info.runtimeReady, '| 语音包:', info.voices.map(v => v.id + '=' + (v.installed ? '已装' : '未装')).join(' '))
  if (info.legacy.length) log('遗留旧包:', info.legacy.map(v => v.id).join('、'))

  let allOk = true
  for (const [id, text] of [['zh-huayan', '这是一条测试语音，用来确认中文合成正常。'], ['en-amy', 'This is a test of the English voice.']]) {
    const t = Date.now()
    const r = await p.ttsSynthesize(text, id).catch((e) => ({ ok: false, reason: e.message }))
    const ms = Date.now() - t
    if (r.ok) log(`合成 ${id}: OK ${r.sampleRate}Hz ${(r.wav.length / 1024).toFixed(0)}KB 耗时 ${ms}ms`)
    else { allOk = false; log(`合成 ${id}: FAIL ${r.reason}`) }
  }
  log(allOk ? '链路冒烟通过' : '链路冒烟失败')
  process.exit(allOk ? 0 : 1)
})()

setTimeout(() => { log('超时（10 分钟）仍未完成——链路有挂死'); process.exit(2) }, 600000)
