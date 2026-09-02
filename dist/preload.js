
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { unpackArchive } = require('./engine-unpack.js')

const FIXED_PORT = 18155
const SLEEP_IDLE_SECONDS = 300 
const MAX_TOKENS = 1024





const ENG_VERSION = 'b10734'
const ENG_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download/' + ENG_VERSION
const ENG_PACKS = {
  'win-vulkan-x64': { label: 'Windows x64（Vulkan GPU 加速）', file: `llama-${ENG_VERSION}-bin-win-vulkan-x64.zip`, exe: 'llama-server.exe', size: '33.5MB' },
  'win-cpu-x64': { label: 'Windows x64（CPU，无独显备用）', file: `llama-${ENG_VERSION}-bin-win-cpu-x64.zip`, exe: 'llama-server.exe', size: '17.5MB' },
  'win-cpu-arm64': { label: 'Windows ARM64（CPU）', file: `llama-${ENG_VERSION}-bin-win-cpu-arm64.zip`, exe: 'llama-server.exe', size: '11.4MB' },
  'macos-arm64': { label: 'macOS Apple Silicon（Metal 加速）', file: `llama-${ENG_VERSION}-bin-macos-arm64.tar.gz`, exe: 'llama-server', size: '10.6MB' },
  'macos-x64': { label: 'macOS Intel（Metal 加速）', file: `llama-${ENG_VERSION}-bin-macos-x64.tar.gz`, exe: 'llama-server', size: '10.6MB' },
  'ubuntu-x64': { label: 'Linux x64（CPU）', file: `llama-${ENG_VERSION}-bin-ubuntu-x64.tar.gz`, exe: 'llama-server', size: '15.9MB' },
  'ubuntu-arm64': { label: 'Linux ARM64（CPU，实验性）', file: `llama-${ENG_VERSION}-bin-ubuntu-arm64.tar.gz`, exe: 'llama-server', size: '12.7MB' },
}
function engineTarget() {
  const p = process.platform, a = process.arch
  if (p === 'win32') return a === 'arm64' ? 'win-cpu-arm64' : 'win-vulkan-x64'
  if (p === 'darwin') return a === 'arm64' ? 'macos-arm64' : 'macos-x64'
  if (p === 'linux') return a === 'arm64' ? 'ubuntu-arm64' : 'ubuntu-x64'
  return null
}


function entryKeywords() {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin.json'), 'utf8'))
    const f = (pj.features || []).find((x) => x.code === 'translate')
    return ((f && f.cmds) || []).filter((c) => typeof c === 'string')
  } catch {
    return ['翻译', 'fy']
  }
}
function engineInstallDir() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'engine') }
function engineExeName() { return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server' }
let engineDirCache = null

function writeEngineError(msg) {
  try {
    fs.mkdirSync(path.join(utools.getPath('userData'), 'utools-hy-mt2'), { recursive: true })
    fs.writeFileSync(path.join(utools.getPath('userData'), 'utools-hy-mt2', 'last-engine-error.txt'),
      new Date().toLocaleString() + '\n' + msg.replace(/\x1b\[[0-9;]*m/g, '') + '\n\n--- 引擎日志 ---\n' + errLogTail.replace(/\x1b\[[0-9;]*m/g, ''), 'utf8')
  } catch (e) { console.error('[hy-mt2] 写入错误日志失败:', e.message) }
}


function engineInfo() {
  const key = engineTarget()
  const t = key ? ENG_PACKS[key] : null
  const dir = engineInstallDir()
  let marker = ''
  try { marker = fs.readFileSync(path.join(dir, 'version.txt'), 'utf8').trim() } catch {}
  const exe = t ? path.join(dir, t.exe) : null
  const installed = !!(exe && fs.existsSync(exe) && marker === ENG_VERSION)
  return {
    installed, marker, engineDir: dir, platform: process.platform + '/' + process.arch,
    version: ENG_VERSION,
    target: t ? { key, label: t.label, exe: t.exe, size: t.size, url: ENG_BASE + '/' + t.file } : null,
    
    mirrors: [ENG_BASE, 'https://gh-proxy.com/' + ENG_BASE, 'https://ghfast.top/' + ENG_BASE].map((b) => b + '/' + (t ? t.file : '')),
  }
}


function installEngineArchive(archive, t, onPhase) {
  const dir = engineInstallDir()
  const tmp = dir + '.tmp-' + Date.now()
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
  return new Promise((resolve, reject) => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.mkdirSync(tmp, { recursive: true })
      onPhase && onPhase('解压引擎中...')
      unpackArchive(archive, tmp)
      const exe = path.join(tmp, t.exe)
      if (!fs.existsSync(exe)) throw new Error('安装包内未找到 ' + t.exe + '，请确认下载的是「' + t.label + '」版本')
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755) 
      fs.rmSync(dir, { recursive: true, force: true })
      fs.renameSync(tmp, dir)
      fs.writeFileSync(path.join(dir, 'version.txt'), ENG_VERSION, 'utf8')
      engineDirCache = dir
      resolve(dir)
    } catch (e) {
      cleanup()
      writeEngineError('引擎安装失败: ' + (e && e.stack ? e.stack : e.message))
      reject(new Error('引擎安装失败: ' + e.message))
    }
  })
}


async function openEngineDownload() {
  const key = engineTarget()
  const t = key ? ENG_PACKS[key] : null
  if (!t) throw new Error('当前平台不受支持: ' + process.platform + '/' + process.arch)
  await openExternal(ENG_BASE + '/' + t.file)
  return { url: ENG_BASE + '/' + t.file, size: t.size }
}


function chooseEngineFile() {
  return new Promise((resolve) => {
    const r = utools.showOpenDialog({
      title: '选择下载好的引擎安装包（.zip 或 .tar.gz）',
      properties: ['openFile'],
      filters: [
        { name: '引擎安装包', extensions: ['zip', 'tgz'] },
        { name: '压缩包', extensions: ['gz'] },
      ],
    })
    resolve(r && r.length ? r[0] : null)
  })
}
function installEngineFromFile(archive, onPhase) {
  const key = engineTarget()
  const t = key ? ENG_PACKS[key] : null
  if (!t) return Promise.reject(new Error('当前平台不受支持: ' + process.platform + '/' + process.arch))
  if (!fs.existsSync(archive)) return Promise.reject(new Error('文件不存在: ' + archive))
  return installEngineArchive(archive, t, onPhase)
}


async function ensureEngine(onPhase) {
  if (engineDirCache) {
    if (!fs.existsSync(path.join(engineDirCache, engineExeName()))) engineDirCache = null
    else return engineDirCache
  }
  const st = engineInfo()
  if (st.installed) { engineDirCache = st.engineDir; return engineDirCache }
  const t = st.target
  throw new Error('推理引擎未安装（' + ENG_VERSION + (t ? '，' + t.label + ' ' + t.size : '，当前平台暂不支持') + '），请先安装引擎')
}


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


let serverProc = null
let serverPort = null
let errLogTail = '' 




const CFG_KEY = 'hy-mt2-config'
const HIST_KEY = 'hy-mt2-history'
function storeFile() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'storage.json') }

function readStore() {
  try {
    const d = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    return { config: d.config || null, history: Array.isArray(d.history) ? d.history : [] }
  } catch {
    
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
  
  const plain = JSON.parse(JSON.stringify(c))
  writeStore({ config: plain })
  cfgCache = plain
}


function chooseModelDir() {
  return new Promise((resolve) => {
    const dirs = utools.showOpenDialog({
      title: '选择模型存放目录（Hy-MT2 1.08GB 将下载到此）',
      properties: ['openDirectory', 'createDirectory'],
    })
    resolve(dirs && dirs.length ? dirs[0] : null)
  })
}




function openExternal(url) {
  return new Promise((resolve, reject) => {
    try {
      utools.shellOpenExternal(url)
      resolve(true)
    } catch (e) {
      reject(new Error('无法调用系统浏览器: ' + e.message))
    }
  })
}

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
    if (h.statusCode === 503) return { up: true, sleeping: false, loading: true } 
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


function spawnServer(modelPath) {
  return new Promise((resolve, reject) => {
    const exe = path.join(engineDirCache, engineExeName())
    if (!fs.existsSync(exe)) return reject(new Error('推理引擎缺失: ' + exe))
    errLogTail = ''
    let settled = false
    let tries = 0
    let poll = null 
    const fail = (msg) => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      serverPort = null
      writeEngineError(msg) 
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
    
    serverProc.on('exit', (code) => {
      fail('推理引擎启动失败(退出码 ' + code + ')' + (errLogTail ? '：' + errLogTail.slice(-300) : ''))
    })
    poll = setInterval(async () => {
      if (settled) { clearInterval(poll); return }
      const st = await probePort(FIXED_PORT)
      if (settled) return
      
      if (st && st.up && !st.loading) {
        settled = true
        clearInterval(poll)
        serverPort = FIXED_PORT
        resolve(FIXED_PORT)
      } else if (++tries > 360) { 
        fail('推理服务启动超时(180s)' + (errLogTail ? '：' + errLogTail.slice(-300) : ''))
      }
    }, 500)
  })
}


function startServer(modelPath) {
  return new Promise((resolve, reject) => {
    if (serverPort) return resolve(serverPort)
    probePort(FIXED_PORT).then((st) => {
      if (st && st.up) {
        
        serverPort = FIXED_PORT
        waitModelReady(FIXED_PORT).then(() => resolve(FIXED_PORT)).catch(reject)
      } else {
        spawnServer(modelPath).then(resolve).catch(reject)
      }
    }).catch(() => spawnServer(modelPath).then(resolve).catch(reject))
  })
}

function stopServer() {
  
  try {
    const r = http.request({ host: '127.0.0.1', port: FIXED_PORT, path: '/shutdown', method: 'POST', timeout: 500 })
    r.on('error', () => {})
    r.end()
  } catch {}
  serverPort = null
  if (serverProc) {
    try { serverProc.kill() } catch {}
    serverProc = null
    
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



try { utools.onPluginOut(() => {  }) } catch {}






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
  if (termLines.length) parts.push('参考下面的翻译：\n' + termLines.join('\n'))
  const style = settings.style && styleMap[settings.style]
  
  
  if (style && (text || '').trim().length > 4) {
    parts.push(`请将以下文本翻译为${tgt}。\n注意翻译的风格要严格符合【${style}】`)
  } else {
    parts.push(`将以下文本翻译为${tgt}，注意只需要输出翻译后的结果，不要额外解释：`)
  }
  parts.push('', text)
  return parts.join('\n')
}

function chatTranslate(text, settings) {
  const prompt = buildPrompt(text, settings)
  return requestJson(serverPort, 'POST', '/v1/chat/completions', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: MAX_TOKENS,
    temperature: 0.7, 
    top_p: 0.6,
    top_k: 20,
    repeat_penalty: 1.05,
    cache_prompt: false, 
  }, 120000).then((res) => {
    const msg = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message
    const out = msg && typeof msg.content === 'string' ? msg.content.trim() : ''
    if (!out) throw new Error('服务响应异常: ' + (res.raw || '').slice(0, 120))
    return out
  })
}


window.preload = {
  getConfig: readCfg,
  saveConfig: writeCfg,
  
  engineInfo,
  openEngineDownload,
  installEngineFromFile,
  chooseEngineFile,
  entryKeywords,
  
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
  
  async openModelDownload() {
    await openExternal(getModelUrl())
    return { ok: true }
  },
  
  
  async ensureModel(onPhase) {
    const cfg = readCfg()
    const mp = cfg.modelPath || (cfg.modelDir ? path.join(cfg.modelDir, 'Hy-MT2-1.8B-Q4_K_M.gguf') : null)
    if (!mp) return { ok: false, reason: '未配置模型' }
    try {
      await ensureEngine(onPhase)
      const st0 = await probePort(FIXED_PORT)
      if (st0 && st0.sleeping) {
        
        if (onPhase) onPhase('唤醒中...')
        await requestJson(FIXED_PORT, 'POST', '/completion', { prompt: 'Hi', n_predict: 1, cache_prompt: false }, 60000)
        return { ok: true }
      }
      if (st0 && st0.up && !st0.loading) return { ok: true } 
      
      if (onPhase) onPhase('启动引擎中...')
      await startServer(mp)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  },
  
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
