/**
 * TTS 一键启用链路冒烟：在纯 Node 里加载 dist/preload.js（stub utools），
 * 真实执行 installVoiceBundle 全链：下载运行时(npmmirror) → 解压 → 起语音服务子进程。
 * 专门抓"真机能跑/本地脚本不跑"类断点——2026-09-15「一键启用卡在准备安装」的复现入口。
 * 用法: node scripts/tts-chain-smoke.cjs [--keep]   (--keep 保留产物便于复查)
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

// 追踪谁删了下载中间产物（.part 消失竞态的取证）
const _unlink = fs.unlinkSync, _rm = fs.rmSync, _rmRf = fs.rmdirSync
const trace = (tag) => (p) => {
  if (String(p).includes('.tgz') || String(p).includes('tts-runtime') || String(p).includes('.part')) {
    console.log('[fs-trace]', tag, String(p).split(/[\\/]/).pop(), '\n    ', new Error().stack.split('\n')[2].trim())
  }
  return _unlink.call(fs, p)
}
fs.unlinkSync = trace('unlinkSync')
fs.rmSync = (p, o) => {
  if (String(p).includes('tts-runtime') || String(p).includes('.tgz')) {
    console.log('[fs-trace] rmSync', String(p).split(/[\\/]/).pop(), '\n    ', new Error().stack.split('\n')[2].trim())
  }
  return _rm.call(fs, p, o)
}
fs.rmdirSync = (p, o) => _rmRf.call(fs, p, o)

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
log('preload 已加载，开始一键启用链路（运行时 ~22MB + 不下语音包，只验证到服务就绪）')

// 只验证运行时安装 + 服务就绪：下载 348MB 语音包太重，单独用 --pack 开关
if (!process.argv.includes('--pack')) {
  ;(async () => {
    try {
      const r = await p.installVoiceBundle({
        onPhase: (msg) => log('phase:', msg),
      })
      log('installVoiceBundle 返回:', JSON.stringify(r))
    } catch (e) {
      log('installVoiceBundle 失败:', e.message)
      log('last-tts-error:', (() => { try { return p.readTtsErrorLog() } catch { return '' } })())
      process.exit(1)
    }
    // 验证语音服务能起、能合成
    try {
      const info = p.voicePackInfo()
      log('voicePackInfo: runtimeReady=', info.runtimeReady, 'kokoroInstalled=', info.voices.find(v => v.flagship)?.installed)
      const r = await p.ttsSynthesize('测试。', 'kokoro-v1_1:3').catch((e) => ({ ok: false, reason: e.message }))
      log('ttsSynthesize:', r.ok ? 'OK ' + r.sampleRate + 'Hz wav ' + (r.wav.length / 1024).toFixed(0) + 'KB' : 'FAIL ' + r.reason)
      log('链路冒烟结束')
      process.exit(r.ok ? 0 : 1)
    } catch (e) { log('合成阶段异常:', e.stack || e.message); process.exit(1) }
  })()
  setTimeout(() => { log('超时（10 分钟）仍未完成——链路有挂死'); process.exit(2) }, 600000)
}
