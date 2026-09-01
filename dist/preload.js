/**
 * Hy-MT2 翻译插件 - preload（CommonJS，uTools 规范）
 * 职责：
 *  1. 模型目录管理（用户自定义，utools.showOpenDialog 三端一致）
 *  2. 管理本地 llama-server.exe 推理服务（官方 llama.cpp 构建，b10361 Vulkan 版）
 *  3. 翻译请求转发（/v1/chat/completions，官方 prompt 模板）
 *
 * 引擎说明（2026-08-31 实测改造）：
 *  - 弃用 node-llama-cpp + 系统 Node 服务（模块导入冷启动 24s、预编译二进制在本机
 *    加载 22~40s 或推理异常慢），改为直接 spawn 官方 llama-server.exe：
 *    加载就绪 ~11s、翻译 0.4~1.4s/句、Arc 核显 -ngl 99 加速。
 *  - 生命周期：服务进程常驻，闲置 5 分钟自动睡眠（内存 2.4GB→63MB），来请求自动唤醒
 *    （唤醒+首译实测 ~3.9s）。插件退出不杀进程，无看门狗需求。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

const FIXED_PORT = 18155
const SLEEP_IDLE_SECONDS = 300 // 闲置 5 分钟自动睡眠（权重出内存）
const MAX_TOKENS = 1024

// 推理引擎目录：打包安装时插件位于 asar 归档内，exe 无法直接执行（spawn ENOENT），
// 首次运行需把 server/llama 释放到 userData/utools-hy-mt2/engine 再启动；
// 开发者模式（直读 dist）无此问题，直接用包内目录。
function bundledEngineDir() { return path.join(__dirname, 'server', 'llama') }
function engineInstallDir() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'engine') }
function inAsar() {
  if (process.env.HY_MT2_FORCE_ASAR === '1') return true // 测试钩子
  return __dirname.split(path.sep).some((s) => s.endsWith('.asar'))
}
let engineDirCache = null

function writeEngineError(msg) {
  try {
    fs.mkdirSync(path.join(utools.getPath('userData'), 'utools-hy-mt2'), { recursive: true })
    fs.writeFileSync(path.join(utools.getPath('userData'), 'utools-hy-mt2', 'last-engine-error.txt'),
      new Date().toLocaleString() + '\n' + msg.replace(/\x1b\[[0-9;]*m/g, '') + '\n\n--- stderr ---\n' + errLogTail.replace(/\x1b\[[0-9;]*m/g, ''), 'utf8')
  } catch (e) { console.error('[hy-mt2] 写入错误日志失败:', e.message) }
}

// 逐文件复制（asar 兼容）：fs.cp/promises.cp 不支持 asar 源路径（opendir ENOENT），
// 必须用被 Electron 打过补丁的 readFileSync（可读 asar）+ writeFileSync（写真实磁盘）
async function copyEngineDir(src, dest, onPhase) {
  fs.mkdirSync(dest, { recursive: true })
  const names = fs.readdirSync(src)
  let done = 0
  for (const name of names) {
    const s = path.join(src, name)
    const d = path.join(dest, name)
    if (fs.statSync(s).isDirectory()) {
      await copyEngineDir(s, d, onPhase)
    } else {
      fs.writeFileSync(d, fs.readFileSync(s))
      done++
      if (onPhase && done % 4 === 0) onPhase(`释放引擎中 ${done}/${names.length}...`)
      await new Promise((r) => setTimeout(r, 0)) // 让出事件循环，状态文本可刷新
    }
  }
}

async function ensureEngine(onPhase) {
  if (engineDirCache) return engineDirCache
  if (!inAsar()) { engineDirCache = bundledEngineDir(); return engineDirCache }
  const dest = engineInstallDir()
  let version = ''
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8')).version || '' } catch {}
  const exe = path.join(dest, 'llama-server.exe')
  let marker = ''
  try { marker = fs.readFileSync(path.join(dest, 'version.txt'), 'utf8').trim() } catch {}
  if (!fs.existsSync(exe) || marker !== version) {
    try {
      if (onPhase) onPhase('释放引擎中...')
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      await copyEngineDir(bundledEngineDir(), dest, onPhase)
      fs.writeFileSync(path.join(dest, 'version.txt'), version, 'utf8')
    } catch (e) {
      engineDirCache = null
      writeEngineError('引擎释放失败: ' + (e && e.stack ? e.stack : e.message))
      throw new Error('引擎释放失败: ' + e.message)
    }
  }
  engineDirCache = dest
  return dest
}

// Hy-MT2 官方支持的语种（GitHub README_CN 语言表），value 为 prompt 里使用的中文全称
const LANGS = {
  'zh': '中文', 'en': '英语', 'ja': '日语', 'ko': '韩语', 'fr': '法语', 'de': '德语',
  'es': '西班牙语', 'pt': '葡萄牙语', 'it': '意大利语', 'ru': '俄语', 'ar': '阿拉伯语',
  'th': '泰语', 'vi': '越南语', 'id': '印尼语', 'ms': '马来语', 'tl': '菲律宾语',
  'tr': '土耳其语', 'hi': '印地语', 'pl': '波兰语', 'cs': '捷克语', 'nl': '荷兰语',
  'uk': '乌克兰语', 'fa': '波斯语', 'he': '希伯来语', 'ur': '乌尔都语', 'bn': '孟加拉语',
  'ta': '泰米尔语', 'te': '泰卢固语', 'gu': '古吉拉特语', 'mr': '马拉地语',
  'kk': '哈萨克语', 'mn': '蒙古语', 'ug': '维吾尔语', 'bo': '藏语',
  'yue': '粤语', 'zh-Hant': '繁体中文',
}

// 翻译服务进程
let serverProc = null
let serverPort = null
let errLogTail = '' // 服务启动失败时给用户看的日志尾巴

// ---- 本地文件存储（userData/utools-hy-mt2/storage.json，用户可直接查看/备份）----
// 弃用 utools.db：历史+配置放一个 JSON 文件，简单透明、无 db 写入间隔约束。
// 首次读取时自动从旧 utools.db 迁移（旧数据只读不删，可回退）。
const CFG_KEY = 'hy-mt2-config'
const HIST_KEY = 'hy-mt2-history'
function storeFile() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'storage.json') }

function readStore() {
  try {
    const d = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    return { config: d.config || null, history: Array.isArray(d.history) ? d.history : [] }
  } catch {
    // 文件不存在/损坏 → 尝试从旧 utools.db 迁移
    let config = null, history = []
    try {
      const c = utools.db.get(CFG_KEY)
      if (c && c.data) config = c.data
      const h = utools.db.get(HIST_KEY)
      if (h && Array.isArray(h.data)) history = h.data
    } catch {}
    return { config, history }
  }
}

function writeStore(patch) {
  const cur = readStore()
  const next = {
    config: patch.config !== undefined ? JSON.parse(JSON.stringify(patch.config)) : cur.config,
    history: patch.history !== undefined ? JSON.parse(JSON.stringify(patch.history)) : cur.history,
  }
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
  fs.writeFileSync(storeFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

let cfgCache = null
function readCfg() {
  if (cfgCache) return cfgCache
  const s = readStore()
  cfgCache = s.config || { modelPath: null, modelDir: null, style: '日常', maxLen: '默认', terms: {} }
  return cfgCache
}
async function writeCfg(c) {
  // 传字面量对象（Vue Proxy 无法 structuredClone）
  const plain = JSON.parse(JSON.stringify(c))
  writeStore({ config: plain })
  cfgCache = plain
}

// ---- 模型目录选择（uTools 原生对话框，三端一致）----
function chooseModelDir() {
  return new Promise((resolve) => {
    const dirs = utools.showOpenDialog({
      title: '选择模型存放目录（Hy-MT2 1.08GB 将下载到此）',
      properties: ['openDirectory', 'createDirectory'],
    })
    resolve(dirs && dirs.length ? dirs[0] : null)
  })
}

// ---- HTTP 小工具 ----
function requestJson(port, method, apiPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request({
      host: '127.0.0.1', port, path: apiPath, method,
      headers: data ? { 'Content-Type': 'application/json' } : {},
      timeout: timeoutMs || 5000,
    }, (res) => {
      let b = ''
      res.on('data', (c) => b += c)
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(b) } catch {}
        resolve({ statusCode: res.statusCode, json, raw: b })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    if (data) req.write(data)
    req.end()
  })
}

// 探测端口上的 llama-server：返回 {up, sleeping} 或 null
async function probePort(port) {
  try {
    const h = await requestJson(port, 'GET', '/health', null, 1500)
    if (h.statusCode === 200 && h.json && h.json.status === 'ok') {
      let sleeping = false
      try {
        const p = await requestJson(port, 'GET', '/props', null, 1500)
        sleeping = !!(p.json && p.json.is_sleeping)
      } catch {}
      return { up: true, sleeping }
    }
    if (h.statusCode === 503) return { up: true, sleeping: false, loading: true } // 正在加载模型
    return null
  } catch { return null }
}

function waitModelReady(port) {
  return new Promise((resolve, reject) => {
    let tries = 0
    const iv = setInterval(async () => {
      const st = await probePort(port)
      if (st && st.up && !st.loading) { clearInterval(iv); resolve() }
      else if (st && st.loading && ++tries > 600) { clearInterval(iv); reject(new Error('模型加载超时')) }
    }, 500)
  })
}

// 启动 llama-server.exe（Vulkan 构建：有 Arc 核显走核显，无核显自动回退 CPU）
function spawnServer(modelPath) {
  return new Promise((resolve, reject) => {
    const exe = path.join(engineDirCache, 'llama-server.exe')
    if (!fs.existsSync(exe)) return reject(new Error('推理引擎缺失: ' + exe))
    errLogTail = ''
    let settled = false
    let tries = 0
    let poll = null // 注意：fail 可能先于 poll 初始化被调，禁止直接 clearInterval(poll)
    const fail = (msg) => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      serverPort = null
      writeEngineError(msg) // 落盘完整错误，方便排查（状态徽章上可能显示不全）
      reject(new Error(msg.replace(/\x1b\[[0-9;]*m/g, '')))
    }
    serverProc = spawn(exe, [
      '-m', modelPath,
      '--port', String(FIXED_PORT),
      '--host', '127.0.0.1',
      '-c', '2048',
      '-ngl', '99',
      '--no-webui',
      '--sleep-idle-seconds', String(SLEEP_IDLE_SECONDS),
    ], {
      cwd: engineDirCache,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      detached: false,
    })
    serverProc.stderr.on('data', (d) => {
      errLogTail = (errLogTail + d.toString()).slice(-2000)
    })
    serverProc.on('error', (e) => fail('推理引擎启动失败: ' + e.message))
    // 进程秒退（模型路径错误/被杀软拦截/端口被占等）必须立刻失败，不能傻等超时
    serverProc.on('exit', (code) => {
      fail('推理引擎启动失败(退出码 ' + code + ')' + (errLogTail ? '：' + errLogTail.slice(-300) : ''))
    })
    poll = setInterval(async () => {
      if (settled) { clearInterval(poll); return }
      const st = await probePort(FIXED_PORT)
      if (settled) return
      // 200 = 已就绪（含睡眠态，睡眠会被后续唤醒）；503 = 正在加载模型，继续等
      if (st && st.up && !st.loading) {
        settled = true
        clearInterval(poll)
        serverPort = FIXED_PORT
        resolve(FIXED_PORT)
      } else if (++tries > 360) { // 最长等 180 秒（首次运行杀软扫描可能很慢）
        fail('推理服务启动超时(180s)' + (errLogTail ? '：' + errLogTail.slice(-300) : ''))
      }
    }, 500)
  })
}

// 获取服务端口（复用已运行服务 or 启动新服务）
function startServer(modelPath) {
  return new Promise((resolve, reject) => {
    if (serverPort) return resolve(serverPort)
    probePort(FIXED_PORT).then((st) => {
      if (st && st.up) {
        // 已有服务（可能是上一代 preload 启动的），直接收养
        serverPort = FIXED_PORT
        waitModelReady(FIXED_PORT).then(() => resolve(FIXED_PORT)).catch(reject)
      } else {
        spawnServer(modelPath).then(resolve).catch(reject)
      }
    }).catch(() => spawnServer(modelPath).then(resolve).catch(reject))
  })
}

function stopServer() {
  // 先请求旧版服务自毁（兼容 v0.2.0 的 node 服务；llama-server 无此路由，404 无害）
  try {
    const r = http.request({ host: '127.0.0.1', port: FIXED_PORT, path: '/shutdown', method: 'POST', timeout: 500 })
    r.on('error', () => {})
    r.end()
  } catch {}
  serverPort = null
  if (serverProc) {
    try { serverProc.kill() } catch {}
    serverProc = null
    // 给端口释放留点时间
    const dead = Date.now() + 1500
    const check = setInterval(() => {
      probePort(FIXED_PORT).then((st) => {
        if (!(st && st.up) || Date.now() > dead) {
          clearInterval(check)
          if (st && st.up) {
            try { execSync(`taskkill /F /IM llama-server.exe /T`, { windowsHide: true }) } catch {}
          }
        }
      })
    }, 300)
  }
}

// 生命周期：插件退出不杀进程。服务闲置 5 分钟自动睡眠（内存降至 ~60MB），
// 复进插件毫秒级就绪（睡眠中则预热唤醒 ~3.5s）。需要立即释放时：设置页"更换模型"。
try { utools.onPluginOut(() => { /* 服务自睡眠，见 SLEEP_IDLE_SECONDS */ }) } catch {}

// Hy-MT2 官方 prompt 模板（GitHub README_CN）：
//   默认：将以下文本翻译为 {目标语言中文全称}，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}
//   术语：在默认指令之前，每行一条 "{source} 翻译成 {target}"
//   风格：注意翻译的风格要严格符合【{style}】
function buildPrompt(text, settings = {}) {
  const tgt = LANGS[settings.tgtLang] || '中文'
  const styleMap = {
    '日常': '日常口语，自然通顺',
    '正式': '正式书面语',
    '简洁': '简洁精炼，去掉冗余表达',
  }
  const parts = []
  const terms = settings.terms || {}
  const termLines = Object.keys(terms).map(k => `${k} 翻译成 ${terms[k]}`)
  if (termLines.length) parts.push(termLines.join('\n'))
  let instr = `将以下文本翻译为${tgt}，注意只需要输出翻译后的结果，不要额外解释：`
  if (settings.style && styleMap[settings.style]) instr += `注意翻译的风格要严格符合【${styleMap[settings.style]}】。`
  parts.push(instr)
  parts.push('', text)
  return parts.join('\n')
}

function chatTranslate(text, settings) {
  const prompt = buildPrompt(text, settings)
  return requestJson(serverPort, 'POST', '/v1/chat/completions', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: MAX_TOKENS,
    temperature: 0.7, // 官方推荐生成参数（1.8B）
    top_p: 0.6,
    top_k: 20,
    repeat_penalty: 1.05,
    cache_prompt: false, // 翻译无状态，不复用前缀缓存
  }, 120000).then((res) => {
    const msg = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message
    const out = msg && typeof msg.content === 'string' ? msg.content.trim() : ''
    if (!out) throw new Error('服务响应异常: ' + (res.raw || '').slice(0, 120))
    return out
  })
}

// ---- 对外 API（挂到 window.preload，渲染层调用）----
window.preload = {
  getConfig: readCfg,
  saveConfig: writeCfg,
  // 本地文件存储（历史记录等）：渲染层读/增量写
  readStore() { return readStore() },
  writeStore(patch) { return writeStore(patch) },
  chooseModelDir,
  modelExists(dir) {
    if (!dir) return false
    const f = path.join(dir, 'Hy-MT2-1.8B-Q4_K_M.gguf')
    return fs.existsSync(f) && fs.statSync(f).size > 100 * 1024 * 1024
  },
  getModelFile(dir) { return path.join(dir, 'Hy-MT2-1.8B-Q4_K_M.gguf') },
  getModelUrl() { return 'https://hf-mirror.com/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf' },
  openModelDir(dir) { utools.showItemInFolder(path.join(dir, 'Hy-MT2-1.8B-Q4_K_M.gguf')) },
  // 官方 ubrowser.download（三端一致）；ubrowser 无进度回调，用文案提示
  downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        utools.ubrowser.download(url, dest).run().then(() => {
          if (onProgress) onProgress(100, 100)
          resolve(dest)
        }).catch(reject)
      } catch (e) { reject(e) }
    })
  },
  // 预热（进插件调用）：启动/复用服务；睡眠中则唤醒，之后首译无需等待
  // onPhase(phase) 用于状态显示：'启动引擎中...' / '唤醒中...'
  async ensureModel(onPhase) {
    const cfg = readCfg()
    const mp = cfg.modelPath || (cfg.modelDir ? path.join(cfg.modelDir, 'Hy-MT2-1.8B-Q4_K_M.gguf') : null)
    if (!mp) return { ok: false, reason: '未配置模型' }
    try {
      await ensureEngine(onPhase)
      const st0 = await probePort(FIXED_PORT)
      if (st0 && st0.sleeping) {
        // 睡眠中：先唤醒（进程还热着，比重启快），避免用户点翻译时才等
        if (onPhase) onPhase('唤醒中...')
        await requestJson(FIXED_PORT, 'POST', '/completion', { prompt: 'Hi', n_predict: 1, cache_prompt: false }, 60000)
        return { ok: true }
      }
      if (st0 && st0.up && !st0.loading) return { ok: true } // 已就绪
      // 未启动或加载中(503)：启动/收养并等就绪
      if (onPhase) onPhase('启动引擎中...')
      await startServer(mp)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  },
  // 翻译（服务可能已睡眠自动唤醒/意外退出则重启，失败后重试一次）
  async translate(text, settings) {
    const mp = settings.modelPath || (settings.modelDir ? path.join(settings.modelDir, 'Hy-MT2-1.8B-Q4_K_M.gguf') : null)
    try {
      await ensureEngine()
      await startServer(mp)
      return await chatTranslate(text, settings)
    } catch (e) {
      serverPort = null
      serverProc = null
      await ensureEngine()
      await startServer(mp)
      return await chatTranslate(text, settings)
    }
  },
  stopServer,
}
