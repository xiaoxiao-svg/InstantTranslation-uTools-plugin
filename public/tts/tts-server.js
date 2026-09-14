/**
 * 本地语音合成服务（子进程，纯 Node 环境运行）
 *
 * 为什么必须单独起进程：uTools 的 preload 跑在 Chromium 渲染进程里，主线程禁止同步编译
 * 超过 4KB 的 WASM（"WebAssembly.Compile is disallowed on the main thread..."），
 * 而 sherpa-onnx 的 nodejs 构建依赖同步实例化。子进程用 ELECTRON_RUN_AS_NODE=1 启动，
 * 是纯 Node 环境，没有该限制，sherpa / wasm-bz2 都能原样使用。
 *
 * 由 preload.js 通过 spawn(process.execPath, [本脚本, port, voicesRoot, espeakDir, runtimeDir]) 启动。
 * 闲置 IDLE_MS 后自行退出（与翻译服务一样，不常驻占内存）。
 *
 * 运行时外置：sherpa-onnx / wasm-bz2 不随插件分发，存放在 runtimeDir（用户数据目录），
 * 首次用到 TTS 时由 preload 从 npm 镜像下载官方包并解压过去。因此这里对两个库的
 * require 必须是惰性的 —— 服务启动时运行时可能还没装好（/extract、/install 解压
 * 运行时本身都发生在启动之后），顶层 require 会直接把进程拉死。
 *
 * 接口（127.0.0.1:<port>，仅本机）：
 *   GET  /health                       → {status:'ok'}
 *   POST /warmup  {spec}               → {ok}
 *   POST /synth   {spec,text}          → {ok, wav(base64), sampleRate}
 *   POST /synth-stream {spec,text}     → NDJSON 流：{t:'s',sr,segs} / {t:'c',pcm} / {t:'e',n} / {t:'x',error}
 *   POST /install {archive,targetDir,espeakDir,expectTop} → {ok, files, topDir}
 *   POST /extract {archive,destDir}    → {ok, files}（npm tgz：gunzip → tar，剥顶层 package/）
 *
 * spec 形如 { kind:'vits'|'matcha', model|acousticModel, vocoder, lexicon, tokens, dataDir, ruleFsts }
 */
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const zlib = require('zlib')

const PORT = Number(process.argv[2]) || 18156
const VOICES_ROOT = process.argv[3] || ''
const ESPEAK_DIR = process.argv[4] || ''
const RUNTIME_DIR = process.argv[5] || ''
const IDLE_MS = 5 * 60 * 1000

// 惰性加载外置运行时（见头部说明）
let sherpa = null
let Bzip2 = null
function getSherpa() {
  if (!sherpa) sherpa = require(path.join(RUNTIME_DIR, 'sherpa-onnx'))
  return sherpa
}
function getBzip2() {
  if (!Bzip2) Bzip2 = require(path.join(RUNTIME_DIR, 'wasm-bz2', 'dist', 'index.js'))
  return Bzip2
}

const engines = {}
let idleTimer = null
function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS)
}
touchIdle()

// 引擎按 spec 缓存：同一语音包的多段合成复用同一个已加载模型（加载一次约 1~5 秒）
function engineKey(spec) {
  return [spec.kind, spec.model || spec.acousticModel, spec.vocoder || '', spec.lexicon || ''].join('|')
}
function getEngine(spec) {
  const key = engineKey(spec)
  if (!engines[key]) {
    // WASM 构建不支持多线程（引擎内部会把 num_threads 压回 1），这里直接给 1 避免告警
    const base = { numThreads: 1, provider: 'cpu' }
    const cfg = { maxNumSentences: 1, ruleFsts: spec.ruleFsts || '' }
    if (spec.kind === 'matcha') {
      cfg.model = { matcha: Object.assign({ acousticModel: spec.acousticModel, vocoder: spec.vocoder, lexicon: spec.lexicon || '', tokens: spec.tokens, dataDir: spec.dataDir || '' }, base) }
    } else {
      cfg.model = { vits: Object.assign({ model: spec.model, lexicon: spec.lexicon || '', tokens: spec.tokens, dataDir: spec.dataDir || '' }, base) }
    }
    engines[key] = getSherpa().createOfflineTts(cfg)
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
// 所以只把开头切细（实测能把首块从 ~1.5s 压到 ~0.7s），后面的句子照旧保持完整。
const SEG_HEAD_MAX = 14
function splitByCommas(s, max) {
  const out = []
  let buf = ''
  for (const t of s.split(/(?<=[，,、：:])/)) {
    if (buf && (buf + t).length > max) { out.push(buf); buf = t } else buf += t
  }
  if (buf) out.push(buf)
  return out
}
function splitSegments(text, maxLen, headMaxLen) {
  const max = maxLen || SEG_MAX
  const head = headMaxLen || SEG_HEAD_MAX
  const raw = String(text || '').trim()
  if (!raw) return []
  const out = []
  const sentences = raw.split(/(?<=[。！？!?；;…\n])/).map((s) => s.trim()).filter(Boolean)
  for (let i = 0; i < sentences.length; i++) {
    const cap = i === 0 ? head : max
    const parts = sentences[i].length <= cap ? [sentences[i]] : splitByCommas(sentences[i], cap)
    for (const p of parts) {
      if (p.length <= max * 2) out.push(p)
      else for (let k = 0; k < p.length; k += max) out.push(p.slice(k, k + max))
    }
  }
  return out
}

/**
 * 流式合成：逐段合成、逐段推给客户端。
 *
 * 每段之后 await setImmediate 让出事件循环 —— 合成是同步阻塞的，不让出的话
 * 写进 socket 的数据要等整篇算完才会真正发出去，流式就退化成了"等全部再播"。
 * 让出之后这一段立刻上线，前端可以边播边等下一段。
 */
async function streamSynth(res, spec, text, sid, speed) {
  const engine = getEngine(spec)
  const segs = splitSegments(text)
  const send = (o) => { if (!res.destroyed) res.write(JSON.stringify(o) + '\n') }
  send({ t: 's', sr: engine.sampleRate, segs: segs.length })
  let total = 0
  for (const seg of segs) {
    if (res.destroyed) return            // 前端已取消（用户停止或发起新朗读）
    touchIdle()
    engine.generateWithConfig(seg, {
      sid: sid || 0,
      speed: speed || 1.0,
      callback: (samples) => {
        if (res.destroyed) return false  // 返回 false 让引擎提前收工
        total += samples.length
        send({ t: 'c', pcm: floatToPcmBase64(samples) })
        return true
      },
    })
    await new Promise((r) => setImmediate(r))
  }
  send({ t: 'e', n: total })
  if (!res.destroyed) res.end()
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
  const sharedEspeak = espeakDir || path.join(VOICES_ROOT, '_espeak')
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

// 单次 GET，跟随重定向（GitHub release 会 302 到 objects.githubusercontent.com）
function httpGet(url, depth, onRes, onErr) {
  if (depth > 5) return onErr(new Error('重定向次数过多'))
  const mod = url.startsWith('https:') ? https : http
  const req = mod.get(url, { headers: { 'User-Agent': 'utools-hy-mt2' } }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume()
      return httpGet(new URL(r.headers.location, url).toString(), depth + 1, onRes, onErr)
    }
    if (r.statusCode !== 200) { r.resume(); return onErr(new Error('HTTP ' + r.statusCode)) }
    onRes(r)
  })
  req.on('error', onErr)
  req.setTimeout(120000, () => req.destroy(new Error('下载超时')))
}

// 依次尝试多个镜像，成功一个即止；先写 .part 再改名，避免半截文件被当成装好的
async function fetchToFile(urls, dest, send) {
  let lastErr = null
  for (const url of urls) {
    const tmp = dest + '.part'
    try {
      await new Promise((resolve, reject) => {
        httpGet(url, 0, (r) => {
          const total = Number(r.headers['content-length'] || 0)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          const out = fs.createWriteStream(tmp)
          let got = 0, sentAt = 0
          r.on('data', (c) => {
            got += c.length
            const now = Date.now()
            if (now - sentAt > 250) { sentAt = now; send({ t: 'p', got, total }) }
          })
          r.on('error', reject)
          out.on('error', reject)
          out.on('finish', () => {
            try { fs.renameSync(tmp, dest) } catch (e) { return reject(e) }
            send({ t: 'p', got, total: total || got })
            resolve()
          })
          r.pipe(out)
        }, reject)
      })
      return
    } catch (e) {
      lastErr = e
      try { fs.rmSync(tmp, { force: true }) } catch {}
    }
  }
  throw lastErr || new Error('下载失败')
}

// npm 包 tgz 解压：gzip → tar，剥掉顶层 package/ 目录后平铺到 destDir。
// 运行时外置用（sherpa-onnx / wasm-bz2 都以官方 npm tarball 形式从镜像下载）。
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
      engine.generate({ text: 'a', sid: 0, speed: 1.0 }) // JIT 预热
      return reply(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/synth') {
      const a = JSON.parse(await readBody(req))
      const audio = getEngine(a.spec).generate({ text: a.text, sid: a.sid || 0, speed: a.speed || 1.0 })
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
    if (req.method === 'POST' && req.url === '/fetch') {
      const a = JSON.parse(await readBody(req))
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' })
      const send = (o) => { if (!res.destroyed) res.write(JSON.stringify(o) + '\n') }
      try {
        let done = false
        try { done = fs.statSync(a.dest).size > 0 } catch {}
        if (done) send({ t: 'd', file: a.dest, skipped: true })
        else {
          await fetchToFile(a.urls || [a.url], a.dest, send)
          send({ t: 'd', file: a.dest })
        }
      } catch (e) {
        process.stderr.write('[tts-server] fetch error: ' + (e && e.stack ? e.stack : e) + '\n')
        send({ t: 'x', error: String((e && e.message) || e) })
      }
      if (!res.destroyed) res.end()
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
