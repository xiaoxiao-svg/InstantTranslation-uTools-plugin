/**
 * 量化档位基准：同一模型 int8 / fp32 在本机的合成速度对比，用来回答"这次该选哪档"。
 * 直接调 sherpa-onnx-node，不走 preload，排除 HTTP 与流式封装的开销差异。
 *
 * 前提：先跑过 scripts/tts-chain-smoke.cjs（运行时装在它建的 userData 目录里）。
 * 需要额外档位时，手动把包解压到该 voices 目录下再往 MODELS 里加一行。
 *
 * 实测结论（2026-09，无 AVX512-VNNI 的机器）：int8 反而慢 5~8 倍，fp16 加载即崩。
 * 换机器部署前重跑本脚本，别照抄结论。
 */
const path = require('path')
const BASE = path.join(__dirname, '..', '..', '..', 'bench-kokoro', 'e2e', 'udata', 'utools-hy-mt2')
const VOICES = path.join(BASE, 'voices')
process.chdir(VOICES) // 模型路径全走相对路径：espeak-ng 在 Windows 上读不了非 ASCII 绝对路径
const sherpa = require(path.join(BASE, 'tts-runtime', 'sherpa-onnx-node'))

const MODELS = [
  { dir: 'zh-xiaoya', label: '小雅 int8 ', kind: 'zh' },
  { dir: 'zh-fp16', label: '小雅 fp16 ', kind: 'zh' },
  { dir: 'zh-fp32', label: '小雅 fp32 ', kind: 'zh' },
  { dir: 'en-amy', label: 'Amy  int8 ', kind: 'en' },
  { dir: 'en-amy-fp32', label: 'Amy  fp32 ', kind: 'en' },
]
const TEXTS = {
  zh: ['短句16字', '人工智能正在改变我们的生活方式。'],
  en: ['短句9词', 'Artificial intelligence is changing how we live.'],
}
const LONG = {
  zh: '人工智能正在改变我们的生活方式，本地翻译工具也因此变得越来越实用。它不需要联网，速度快，还能保护隐私。',
  en: 'Artificial intelligence is changing how we live and work. Local translation tools are becoming more practical every day, and they work without an internet connection.',
}

function load(m) {
  const zh = m.kind === 'zh'
  const model = zh ? 'zh_CN-xiao_ya-medium.onnx' : 'en_US-amy-medium.onnx'
  const vits = zh
    ? { model: m.dir + '/' + model, lexicon: m.dir + '/lexicon.txt', tokens: m.dir + '/tokens.txt', dataDir: '' }
    : { model: m.dir + '/' + model, lexicon: '', tokens: m.dir + '/tokens.txt', dataDir: '_espeak' }
  return new sherpa.OfflineTts({
    model: { vits, numThreads: 8, provider: 'cpu' },
    maxNumSentences: 1,
    ruleFsts: zh ? m.dir + '/phone.fst,' + m.dir + '/date.fst,' + m.dir + '/number.fst' : '',
  })
}

for (const m of MODELS) {
  let tts
  try { tts = load(m) } catch (e) { console.log(m.label, '加载失败:', e.message); continue }
  for (const [label, text] of [TEXTS[m.kind], ['长句', LONG[m.kind]]]) {
    const runs = []
    let audioMs = 0
    for (let i = 0; i < 5; i++) {
      const t = Date.now()
      const a = tts.generate({ text, sid: 0, speed: 1.0, enableExternalBuffer: false })
      const ms = Date.now() - t
      audioMs = (a.samples.length / a.sampleRate) * 1000
      if (i === 0) { console.log(`${m.label}${label}: 首次(含加载) ${ms}ms`); continue }
      if (i >= 2) runs.push(ms)
    }
    const avg = runs.reduce((x, y) => x + y, 0) / runs.length
    console.log(`${m.label}${label}: 热态 ${avg.toFixed(0)}ms（${runs.join('/')}）| 音频 ${audioMs.toFixed(0)}ms → ${(audioMs / avg).toFixed(1)}x 实时`)
  }
}
