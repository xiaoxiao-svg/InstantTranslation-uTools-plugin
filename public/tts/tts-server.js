/**
 * 本地语音合成服务（子进程，纯 Node 环境运行）
 *
 * 为什么必须单独起进程：uTools 的 preload 跑在 Chromium 渲染进程里，原生 NAPI 插件与
 * 大模型推理都不适合进渲染进程（阻塞 UI / 崩溃即带崩插件）。子进程用
 * ELECTRON_RUN_AS_NODE=1 启动，是纯 Node 环境，sherpa-onnx 原生绑定原样可用。
 *
 * 由 preload.js 通过 spawn(process.execPath, [本脚本, port, voicesRoot, espeakDir, runtimeDir],
 * { cwd: voicesRoot }) 启动。cwd 固定在 voices 根目录：spec 里的模型路径全部相对该目录 ——
 * espeak-ng 在 Windows 上读不了非 ASCII 路径（中文用户名/中文目录必挂），相对路径天然避开。
 * 闲置 IDLE_MS 后自行退出（与翻译服务一样，不常驻占内存）。
 *
 * 运行时外置：sherpa-onnx-node（原生绑定 + onnxruntime，多线程 CPU）不随插件分发，
 * 存放在 runtimeDir，首次用到 TTS 时由 preload 从 npm 镜像下载官方包解压过去。
 * 因此这里对运行时的 require 必须是惰性的 —— 服务启动时运行时可能还没装好
 * （/extract、/install 解压运行时与语音包都发生在启动之后），顶层 require 会直接把进程拉死。
 *
 * 接口（127.0.0.1:<port>，仅本机）：
 *   GET  /health                       → {status:'ok'}
 *   POST /warmup  {spec}               → {ok}
 *   POST /synth   {spec,text,sid}      → {ok, wav(base64), sampleRate}
 *   POST /synth-stream {spec,text,sid} → NDJSON 流：{t:'s',sr,segs} / {t:'c',pcm} / {t:'e',n} / {t:'x',error}
 *   POST /install {archive,targetDir,espeakDir,expectTop} → {ok, files, topDir}
 *   POST /extract {archive,destDir}    → {ok, files}（npm tgz：gunzip → tar，剥顶层 package/）
 *
 * spec 形如 { kind:'vits', model, lexicon, tokens, dataDir, ruleFsts }（路径全部相对 voicesRoot）
 */
const fs = require('fs')
const http = require('http')
const path = require('path')
const zlib = require('zlib')
const os = require('os')

const PORT = Number(process.argv[2]) || 18156
const VOICES_ROOT = process.argv[3] || ''
const RUNTIME_DIR = process.argv[5] || ''
// 闲置回收窗口：小模型加载约 1 秒，但冷启动仍会让首次朗读"卡一下"。给足 30 分钟，
// 覆盖"翻几句、隔一会儿再读"的正常节奏；真长时间不用才回收，不留常驻进程。
const IDLE_MS = 30 * 60 * 1000

// 惰性加载外置运行时（见头部说明）
let sherpa = null
let Bzip2 = null
function getSherpa() {
  if (!sherpa) sherpa = require(path.join(RUNTIME_DIR, 'sherpa-onnx-node'))
  return sherpa
}
function getBzip2() {
  if (!Bzip2) Bzip2 = require(path.join(RUNTIME_DIR, 'wasm-bz2', 'dist', 'index.js'))
  return Bzip2
}

// 原生 onnxruntime 走真多线程：实测线程数并非越多越快（超物理核后过订阅反而掉速），
// 取一半物理核夹在 [4,8] 对各类机器都稳。
const NUM_THREADS = Math.min(8, Math.max(4, os.cpus().length >> 1))

const engines = {}
let idleTimer = null
function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS)
}
touchIdle()

// 引擎按 spec 缓存：同一语音包的多段合成复用同一个已加载模型。
// lexicon / dataDir 决定音素化路线，换了就得重建引擎，所以一并进 key。
function engineKey(spec) {
  return [spec.kind, spec.model, spec.lexicon || '', spec.dataDir || ''].join('|')
}
function getEngine(spec) {
  const key = engineKey(spec)
  if (!engines[key]) {
    // numThreads / provider / debug 绑定层只在 model 这一层读（官方示例同款结构），
    // 放进 vits 小节会被静默忽略 —— 别再合错层
    const base = { numThreads: NUM_THREADS, provider: 'cpu' }
    if (process.env.TTS_DEBUG) base.debug = 1 // 临时诊断开关
    const cfg = { maxNumSentences: 1, ruleFsts: spec.ruleFsts || '' }
    cfg.model = Object.assign({ vits: { model: spec.model, lexicon: spec.lexicon || '', tokens: spec.tokens, dataDir: spec.dataDir || '' } }, base)
    engines[key] = new (getSherpa().OfflineTts)(cfg)
  }
  return engines[key]
}

// Float32 → 16bit PCM WAV
function floatToWavBase64(samples, sampleRate) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf.toString('base64')
}

// Float32 → 16bit PCM 裸数据（流式分块用；裸 PCM 不带 WAV 头，前端按块顺序灌进音频队列）
function floatToPcmBase64(samples) {
  const n = samples.length
  const buf = Buffer.allocUnsafe(n * 2)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), i * 2)
  }
  return buf.toString('base64')
}

// 切分文本：句末标点优先，超长句退到逗号，仍过长才硬切。
// 段越短首字出声越快（引擎按段回调），但切太碎会损伤自然韵律 —— 逗号只用于兜底，
// 正常长度的句子保持完整，让模型自己处理语调。
const SEG_MAX = 42
// 首段另给一个更小的上限：首字出声时间只由第一段决定，后面还有的是时间追上来，
// 所以只把开头切细，后面的句子照旧保持完整。
// 定 8 字是实测取舍：fp32 档下首块约 0.1 秒（整链路，见 scripts/tts-perf.cjs），
// 再短出声更快但开头断得太碎；这个值只在"首段"生效，之后各段仍是 SEG_MAX。
const SEG_HEAD_MAX = 8
function splitByCommas(s, max) {
  const out = []
  let buf = ''
  for (const t of s.split(/(?<=[，,、：:])/)) {
    if (buf && (buf + t).length > max) { out.push(buf); buf = t } else buf += t
  }
  if (buf) out.push(buf)
  return out
}
// 硬断的落点：中文没有词间空格，只能按字数断；拉丁文退到空格处，
// 否则 "Artificial intelligence…" 会被砍成 "Artifici"、work 会被劈成 w/ork 念错。
// cap 之内就有空格 → 切在那儿（首段不超 cap）；没有才往后找（最多到 cap*2）；
// 单个词本身就比 cap*2 还长时只能硬切 —— 罕见，且没有更好的选择。
// 注意别用 /^.*\s/ 一把贪到底：那会取到最远的空格，首段直接被撑到 2 倍 cap，
// 首字延迟也就不再是 SEG_HEAD_MAX 说了算。
function cutPointAt(s, cap) {
  if (!/[a-zA-Z]/.test(s.slice(0, cap))) return cap
  const inner = s.slice(0, cap).match(/^.*\s/)
  if (inner) return inner[0].length
  const outer = s.slice(cap, cap * 2).match(/^\S*\s/)
  return outer ? cap + outer[0].length : cap
}
// 超长段按长度切（切点避开单词内部）
function splitByLength(s, max) {
  const out = []
  let rest = s
  while (rest.length > max) {
    const cut = cutPointAt(rest, max)
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}
function splitSegments(text, maxLen, headMaxLen) {
  const max = maxLen || SEG_MAX
  const head = headMaxLen || SEG_HEAD_MAX
  const raw = String(text || '').trim()
  if (!raw) return []
  const out = []
  // 英文句末的 "." 也要能分句，否则整段英文只有一句（中文标点集合里没有 .）。
  // 用 ". "（点+空白）而不是 "."，避免把 3.14、U.S.A 这类切开。
  const sentences = raw.split(/(?<=[。！？!?；;…\n])|(?<=\.\s)/).map((s) => s.trim()).filter(Boolean)
  for (let i = 0; i < sentences.length; i++) {
    const cap = i === 0 ? head : max
    let parts = sentences[i].length <= cap ? [sentences[i]] : splitByCommas(sentences[i], cap)
    // splitByCommas 只认逗号，整句没标点时会把原句整段返回，首段等于没切 —— 补一次硬切，
    // 否则"人工智能正在改变我们的生活方式。"这种 16 字无逗号句会把首字延迟翻倍
    if (i === 0 && parts[0].length > cap) {
      const cut = cutPointAt(parts[0], cap)
      parts = [parts[0].slice(0, cut), parts[0].slice(cut)].concat(parts.slice(1))
    }
    for (const p of parts) {
      if (p.length <= max * 2) out.push(p)
      else out.push(...splitByLength(p, max))
    }
  }
  return out
}

// 同一时间只跑一次生成：原生合成在 onnxruntime 的工作线程里算，若两个请求并发进来
// 会互相抢核，两边都掉速；这里串行排队，后到的请求等前一个完（或被前端掐断）。
let genChain = Promise.resolve()

/**
 * 流式合成：逐段合成、逐段推给客户端。
 *
 * 段内用原生 generateAsync 的进度回调 —— 合成跑在 onnxruntime 的工作线程，JS 事件循环
 * 不被阻塞，每算出一块就立刻写进 socket；段间顺序 await。前端可以边播边等下一段。
 */
async function streamSynth(res, spec, text, sid, speed) {
  const send = (o) => { if (!res.destroyed) res.write(JSON.stringify(o) + '\n') }
  const run = async () => {
    const engine = getEngine(spec)
    const segs = splitSegments(text)
    send({ t: 's', sr: engine.sampleRate, segs: segs.length })
    let total = 0
    for (const seg of segs) {
      if (res.destroyed) return            // 前端已取消（用户停止或发起新朗读）
      touchIdle()
      await engine.generateAsync({
        text: seg,
        sid: sid || 0,
        speed: speed || 1.0,
        // Electron 给内嵌 Node 打了禁用 napi 外部缓冲区的补丁（ELECTRON_RUN_AS_NODE 也拦），
        // 默认的 external buffer 直接抛 "External buffers are not allowed"——必须关掉，
        // 让插件走拷贝模式的普通 Float32Array（代价只是每块一次拷贝）
        enableExternalBuffer: false,
        onProgress: (info) => {
          if (res.destroyed) return 0      // 返回 0 让引擎提前收工（取消）
          total += info.samples.length
          send({ t: 'c', pcm: floatToPcmBase64(info.samples) })
          return 1
        },
      })
    }
    send({ t: 'e', n: total })
    if (!res.destroyed) res.end()
  }
  const mine = genChain.then(run, run)
  genChain = mine.catch(() => {})
  return mine
}

// tar.bz2 解压安装：bz2 容量靠递增重试（多流 bz2 的尾部 ISIZE 是垃圾值）
function decompressAll(bz2, packed) {
  let size = Math.ceil(packed.length * 1.5)
  for (let i = 0; i < 4; i++) {
    try {
      return Buffer.from(bz2.decompress(packed, size))
    } catch (e) {
      if (!/BZ_OUTBUFF_FULL|-8/.test(e.message)) throw e
      size *= 2
    }
  }
  throw new Error('语音包解压失败（内容异常）')
}

async function installPack(archive, targetDir, espeakDir, expectTop) {
  if (!fs.existsSync(archive)) throw new Error('文件不存在: ' + archive)
  const bz2 = await getBzip2().init()
  const tar = decompressAll(bz2, fs.readFileSync(archive))
  const topDir = tar.slice(0, 100).toString('utf8').replace(/\0.*$/, '').replace(/\/.*$/, '')
  if (expectTop && topDir !== expectTop) {
    throw new Error('不是该语音包（顶层目录 ' + topDir + '，期望 ' + expectTop + '）')
  }
  const sharedEspeak = espeakDir || '_espeak'
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  let off = 0, files = 0
  while (off + 512 <= tar.length) {
    const raw = tar.slice(off, off + 100).toString('utf8').replace(/\0.*$/, '')
    if (!raw) break
    const size = parseInt(tar.slice(off + 124, off + 136).toString('utf8').replace(/\0/g, '').trim(), 8) || 0
    const type = tar[off + 156]
    const dataStart = off + 512
    if (type === 0 || type === 48) {
      const rel = raw.replace(/^[^/]+\//, '') // 剥顶层目录
      if (rel) {
        let dest
        if (rel.startsWith('espeak-ng-data/')) {
          // 各语音包共用同一份音素数据：已存在则跳过
          dest = path.join(sharedEspeak, rel.replace(/^espeak-ng-data\//, ''))
          if (fs.existsSync(dest)) { off = dataStart + Math.ceil(size / 512) * 512; continue }
        } else {
          dest = path.join(targetDir, rel)
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, tar.slice(dataStart, dataStart + size))
        files++
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return { files, topDir }
}

// npm 包 tgz 解压：gzip → tar，剥掉顶层 package/ 目录后平铺到 destDir。
// 运行时外置用（sherpa-onnx-node / wasm-bz2 / tslib 都以官方 npm tarball 形式从镜像下载）。
// npm 的 ustar 头可能带 prefix 字段，长路径要拼上，否则文件名会被截断错位。
function extractTarGz(archive, destDir) {
  if (!fs.existsSync(archive)) throw new Error('文件不存在: ' + archive)
  const tar = zlib.gunzipSync(fs.readFileSync(archive))
  fs.mkdirSync(destDir, { recursive: true })
  let off = 0, files = 0
  while (off + 512 <= tar.length) {
    const raw = tar.slice(off, off + 100).toString('utf8').replace(/\0.*$/, '')
    if (!raw) break
    const size = parseInt(tar.slice(off + 124, off + 136).toString('utf8').replace(/\0/g, '').trim(), 8) || 0
    const type = tar[off + 156]
    const dataStart = off + 512
    if (type === 0 || type === 48) {
      const prefix = tar.slice(off + 345, off + 500).toString('utf8').replace(/\0.*$/, '')
      const rel = ((prefix ? prefix + '/' : '') + raw).replace(/^[^/]+\//, '')
      if (rel) {
        const dest = path.join(destDir, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, tar.slice(dataStart, dataStart + size))
        files++
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

function readBody(req) {  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 4 * 1024 * 1024) reject(new Error('请求体过大')) })
    req.on('end', () => resolve(b))
    req.on('error', reject)
  })
}

function reply(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  touchIdle()
  // 前端取消朗读 / 中途关掉窗口时 socket 会被重置，此后任何一次 write 都会发出 'error'
  // 事件；不接住的话会变成未捕获异常，把整个语音服务进程带走（后续朗读全部失败）
  res.on('error', (e) => process.stderr.write('[tts-server] res error: ' + e.message + '\n'))
  req.on('error', (e) => process.stderr.write('[tts-server] req error: ' + e.message + '\n'))
  try {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { status: 'ok' })
    if (req.method === 'POST' && req.url === '/warmup') {
      const a = JSON.parse(await readBody(req))
      const engine = getEngine(a.spec)
      engine.generate({ text: 'a', sid: 0, speed: 1.0, enableExternalBuffer: false }) // JIT 预热（开关说明见 streamSynth）
      return reply(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/synth') {
      const a = JSON.parse(await readBody(req))
      const audio = getEngine(a.spec).generate({ text: a.text, sid: a.sid || 0, speed: a.speed || 1.0, enableExternalBuffer: false }) // 开关说明见 streamSynth
      return reply(res, 200, { ok: true, wav: floatToWavBase64(audio.samples, audio.sampleRate), sampleRate: audio.sampleRate })
    }
    if (req.method === 'POST' && req.url === '/synth-stream') {
      const a = JSON.parse(await readBody(req))
      // 响应头必须先发出去：拿到头之后才开始逐段推，前端才能边收边播
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      })
      try {
        await streamSynth(res, a.spec, a.text, a.sid, a.speed)
      } catch (e) {
        process.stderr.write('[tts-server] stream error: ' + (e && e.stack ? e.stack : e) + '\n')
        try { res.write(JSON.stringify({ t: 'x', error: String((e && e.message) || e) }) + '\n') } catch {}
        if (!res.destroyed) res.end()
      }
      return
    }
    if (req.method === 'POST' && req.url === '/extract') {
      const a = JSON.parse(await readBody(req))
      const files = extractTarGz(a.archive, a.destDir)
      return reply(res, 200, { ok: true, files })
    }
    if (req.method === 'POST' && req.url === '/install') {
      const a = JSON.parse(await readBody(req))
      const r = await installPack(a.archive, a.targetDir, a.espeakDir, a.expectTop)
      return reply(res, 200, { ok: true, files: r.files, topDir: r.topDir })
    }
    reply(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    process.stderr.write('[tts-server] ' + (e && e.stack ? e.stack : e) + '\n')
    reply(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
})

server.on('error', (e) => {
  process.stderr.write('[tts-server] listen error: ' + e.message + '\n')
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => process.stdout.write('tts-server ready on ' + PORT + '\n'))
