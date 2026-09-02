/**
 * Hy-MT2 翻译插件 - preload（CommonJS，uTools 规范）
 * 职责：
 *  1. 模型目录管理（用户自定义，utools.showOpenDialog 三端一致）
 *  2. 推理引擎安装与升级（v0.4.0 起外置：用户按平台下载 llama.cpp 官方构建，
 *     插件自动解压到 userData/utools-hy-mt2/engine——插件包因此只含前端代码，KB 级）
 *  3. 管理本地 llama-server.exe 推理服务（官方 llama.cpp 构建，Vulkan/Metal/CPU 按平台）
 *  4. 翻译请求转发（/v1/chat/completions，官方 prompt 模板）
 *
 * 引擎说明（v0.4.0 重构）：
 *  - 引擎不再内置插件包：llama.cpp 官方 nightly（固定版本，见 ENG_VERSION）打包为
 *    win-vulkan / win-cpu / macos-arm64 / macos-x64 / ubuntu-x64 等平台资产，
 *    三端首次使用按平台引导下载（ubrowser 一键下载 或 手动下载后导入压缩包）。
 *  - 已安装引擎由 engine/version.txt 标记版本，与 ENG_VERSION 不符时引导重装。
 *  - 安装后流程不变：服务进程常驻，闲置 5 分钟自动睡眠（内存 2.4GB→63MB），
 *    来请求自动唤醒（唤醒+首译实测 ~3.9s）。插件退出不杀进程。
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { unpackArchive } = require('./engine-unpack.js')

const FIXED_PORT = 18155
const SLEEP_IDLE_SECONDS = 300 // 闲置 5 分钟自动睡眠（权重出内存）
const MAX_TOKENS = 1024

// ---- 推理引擎（v0.4.0 外置安装）----
// 引擎安装于 userData/utools-hy-mt2/engine（version.txt 标记版本，与 ENG_VERSION 不符即引导重装）。
// 官方每日构建（nightly）固定版本：升级引擎 = 改 ENG_VERSION 一处（链接自动跟随）。
// 注意：llama.cpp 自 2026-08 起不再发布"稳定版"，GitHub releases 上 nightly 标签即唯一分发渠道。
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

// 进入关键字（与 plugin.json features[].cmds 字符串项一致，运行时派生，杜绝两处漂移）
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

// 引擎状态快照（UI 决定是否引导安装）
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
    // 国内加速镜像（官方直链不通时浏览器手动下载用，前缀式代理）
    mirrors: [ENG_BASE, 'https://gh-proxy.com/' + ENG_BASE, 'https://ghfast.top/' + ENG_BASE].map((b) => b + '/' + (t ? t.file : '')),
  }
}

// 安装压缩包 → 解压到 engine 目录（先解到同盘 tmp，校验通过后整目录换入）
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
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755) // 纯 JS 解压不保留 tar 执行位
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

// 打开系统浏览器下载当前平台引擎（调用后由用户在浏览器完成下载，回来点「导入安装包」）
async function openEngineDownload() {
  const key = engineTarget()
  const t = key ? ENG_PACKS[key] : null
  if (!t) throw new Error('当前平台不受支持: ' + process.platform + '/' + process.arch)
  await openExternal(ENG_BASE + '/' + t.file)
  return { url: ENG_BASE + '/' + t.file, size: t.size }
}

// 用户手动下载后导入安装包
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

// 引擎就绪检查：version.txt 标记与安装产物都在才返回 engine 目录，否则抛错引导安装
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
// 下载（v0.4.3 起）：一律调用系统默认浏览器（utools.shellOpenExternal，三端一致）。
// 弃用 ubrowser：内置浏览器体验不可靠（链式 goot 限制 + 弹窗），用户明确否决。
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
    const exe = path.join(engineDirCache, engineExeName())
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

// Hy-MT2 官方 prompt 模板（HF 模型卡 README）：
//   默认：将以下文本翻译为 {目标语言中文全称}，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}
//   术语：指令之前 "参考下面的翻译：\n{source} 翻译成 {target}\n..."
//   风格：指令行与风格行各占一行（"请将以下文本翻译为{x}。\n注意翻译的风格要严格符合【…】"）
//   注意风格句不可拼进指令同一行：单字/短句输入时 1.8B 会把风格句当正文一起翻译
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
  // 退化输入保护：超短文本(≤4字符)不加风格行。实测 "翻译"→英语 在风格行存在时
  // 5/5 把风格句当正文翻译成英文；风格对单字/双词输出本就无意义，直接走默认模板
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
  // 推理引擎（外置安装）：状态/浏览器下载/导入安装包/选择文件
  engineInfo,
  openEngineDownload,
  installEngineFromFile,
  chooseEngineFile,
  entryKeywords,
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
  // 打开系统浏览器下载模型（hf-mirror 直链；下载完成后重新进入插件自动检测加载）
  async openModelDownload() {
    await openExternal(getModelUrl())
    return { ok: true }
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
