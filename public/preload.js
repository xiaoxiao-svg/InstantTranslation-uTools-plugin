/**
 * Hy-MT2 翻译插件 - preload（CommonJS，uTools 规范）
 * 职责：
 *  1. 模型管理：多参数规格注册表（1.8B/7B/30B-A3B 官方 GGUF 档位，MODELS 一处维护），
 *     同一目录可共存多个规格，cfg.modelId 决定当前档位（缺省回落 1.8B Q4_K_M，老配置不变）；
 *     下载走系统浏览器（hf-mirror 直链），本地文件可导入（按文件名匹配档位）
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

// ---- 模型注册表（官方 GGUF 全部可用档位，一处维护）----
// file 必须是 HF 仓库原样文件名（区分大小写）：7B 的 Q6/Q8 官方前缀是大写 HY-，其余 Hy-，勿"统一"大小写。
// 下载直链 = MODEL_REPO/<repo>/resolve/main/<file>；30B 另有 Q8_0（29.8GB）过于极端未收录，需要时在此加一行。
// 体积为文件实际大小（GiB，与 HF LFS 元数据逐字核对过）；ram 为翻译时峰值内存估算（含 2048 ctx 的 kv cache）。
const MODEL_REPO = 'https://hf-mirror.com/tencent'
const MODEL_OFFICIAL = 'https://huggingface.co/tencent'
// 国内直连首选 ModelScope（魔搭，国内实测 1.5MB/s，hf-mirror 仅 0.4MB/s 且常抽风）。
// 注意：魔搭只有 1.8B/7B 的 GGUF，30B-A3B 无 GGUF 档（仅 safetensors），故 30B 回落 hf-mirror。
const MODEL_MS = 'https://www.modelscope.cn/models/Tencent-Hunyuan'
const DEFAULT_MODEL_ID = '1.8b-q4'
const MODELS = [
  { id: '1.8b-q4', repo: 'Hy-MT2-1.8B-GGUF', ms: 'Hy-MT2-1.8B-GGUF', file: 'Hy-MT2-1.8B-Q4_K_M.gguf', label: '1.8B · Q4_K_M', size: '1.08GB', ram: '峰值内存约 2.4GB', note: '默认推荐，速度最快' },
  { id: '1.8b-q6', repo: 'Hy-MT2-1.8B-GGUF', ms: 'Hy-MT2-1.8B-GGUF', file: 'Hy-MT2-1.8B-Q6_K.gguf', label: '1.8B · Q6_K', size: '1.37GB', ram: '峰值内存约 2.8GB', note: '速度不变，质量略高' },
  { id: '1.8b-q8', repo: 'Hy-MT2-1.8B-GGUF', ms: 'Hy-MT2-1.8B-GGUF', file: 'Hy-MT2-1.8B-Q8_0.gguf', label: '1.8B · Q8_0', size: '1.78GB', ram: '峰值内存约 3.2GB', note: '接近无损' },
  { id: '7b-q4', repo: 'Hy-MT2-7B-GGUF', ms: 'Hy-MT2-7B-GGUF', file: 'Hy-MT2-7B-Q4_K_M.gguf', label: '7B · Q4_K_M', size: '4.31GB', ram: '峰值内存约 5.5GB', note: '质量明显更高' },
  { id: '7b-q6', repo: 'Hy-MT2-7B-GGUF', ms: 'Hy-MT2-7B-GGUF', file: 'HY-MT2-7B-Q6_K.gguf', label: '7B · Q6_K', size: '5.74GB', ram: '峰值内存约 7GB', note: '质量更高' },
  { id: '7b-q8', repo: 'Hy-MT2-7B-GGUF', ms: 'Hy-MT2-7B-GGUF', file: 'HY-MT2-7B-Q8_0.gguf', label: '7B · Q8_0', size: '7.43GB', ram: '峰值内存约 8.7GB', note: '接近无损' },
  { id: '30b-a3b-q4', repo: 'Hy-MT2-30B-A3B-GGUF', ms: null, file: 'Hy-MT2-30B-A3B-Q4_K_M.gguf', label: '30B-A3B · Q4_K_M', size: '17.0GB', ram: '峰值内存约 19GB', note: '质量最佳；MoE 激活 3B，速度仍快' },
]
function modelById(id) { return MODELS.find((m) => m.id === id) || MODELS[0] } // 未知 id（含旧配置无 modelId）回落默认档
// 下载链接分组：国内直连优先（ModelScope → hf-mirror），官方站殿后（需代理）
function modelUrls(m) {
  const rows = []
  if (m.ms) rows.push({ label: 'ModelScope 国内直连（推荐）', url: MODEL_MS + '/' + m.ms + '/resolve/master/' + m.file })
  rows.push({ label: m.ms ? 'hf-mirror 国内镜像' : 'hf-mirror 国内镜像（推荐）', url: MODEL_REPO + '/' + m.repo + '/resolve/main/' + m.file })
  rows.push({ label: 'HuggingFace 官方站（需代理）', url: MODEL_OFFICIAL + '/' + m.repo + '/resolve/main/' + m.file })
  return rows
}
function modelPathIn(dir, m) { return path.join(dir, m.file) }
function modelInstalled(dir, m) {
  try { const f = modelPathIn(dir, m); return fs.existsSync(f) && fs.statSync(f).size > 100 * 1024 * 1024 } catch { return false }
}
// 同一目录可共存多个规格，cfg.modelId 决定当前用哪个
function activeModel(cfg) { return modelById(cfg && cfg.modelId) }
function activeModelPath(cfg) {
  if (cfg && cfg.modelPath) return cfg.modelPath
  if (cfg && cfg.modelDir) return modelPathIn(cfg.modelDir, activeModel(cfg))
  return null
}
function sameModelPath(a, b) {
  if (!a || !b) return false
  const norm = (p) => path.resolve(String(p))
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b)
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
    // 引擎手动下载链接（官方直链需代理，国内建议用加速镜像；实测 ghfast.top 快于 gh-proxy）
    mirrors: t ? [
      { label: 'ghfast.top 加速（国内推荐）', url: 'https://ghfast.top/' + ENG_BASE + '/' + t.file },
      { label: 'gh-proxy.com 加速', url: 'https://gh-proxy.com/' + ENG_BASE + '/' + t.file },
      { label: 'GitHub 官方直链（需代理）', url: ENG_BASE + '/' + t.file },
    ] : [],
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

// 打开系统浏览器下载当前平台引擎（国内加速镜像优先，GitHub 直链国内不通）
async function openEngineDownload() {
  const key = engineTarget()
  const t = key ? ENG_PACKS[key] : null
  if (!t) throw new Error('当前平台不受支持: ' + process.platform + '/' + process.arch)
  const url = 'https://ghfast.top/' + ENG_BASE + '/' + t.file
  await openExternal(url)
  return { url, size: t.size }
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

// 查询服务当前加载的模型（/props 的 model_path；老版本/非 llama-server 服务查不到返回 null）
async function runningModelPath(port) {
  try {
    const p = await requestJson(port, 'GET', '/props', null, 1500)
    return (p.json && p.json.model_path) || null
  } catch { return null }
}

// 强杀所有 llama-server（切换模型时端口上可能挂着别的模型，收养前必须清掉）
function killLlamaServers() {
  try {
    if (process.platform === 'win32') execSync('taskkill /F /IM llama-server.exe /T', { windowsHide: true })
    else execSync('pkill -f llama-server', { windowsHide: true })
  } catch {}
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

// 获取服务端口（复用已运行服务 or 启动新服务；端口上是别的模型时清掉重启，防止收养错模型）
function startServer(modelPath) {
  return new Promise((resolve, reject) => {
    if (serverPort) return resolve(serverPort)
    probePort(FIXED_PORT).then(async (st) => {
      if (st && st.up) {
        const cur = await runningModelPath(FIXED_PORT)
        if (cur && !sameModelPath(cur, modelPath)) {
          killLlamaServers()
          const dead = Date.now() + 8000
          while (Date.now() < dead) {
            await new Promise((r) => setTimeout(r, 300))
            if (!(await probePort(FIXED_PORT))) break
          }
          return spawnServer(modelPath).then(resolve).catch(reject)
        }
        // 同模型（可能是上一代 preload 启动的），直接收养
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
            if (st && st.up) killLlamaServers()
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
//   风格：官方模板是"指令行+风格行各占一行"，但风格行必须改走 system 消息（见 buildStyleMessage）
function buildStyleMessage(settings = {}) {
  const styleMap = {
    '日常': '日常口语，自然通顺',
    '正式': '正式书面语',
    '简洁': '简洁精炼，去掉冗余表达',
  }
  const style = settings.style && styleMap[settings.style]
  return style ? `注意翻译的风格要严格符合【${style}】` : ''
}

// ---- 术语按需注入 ----
// 只把当前文本里实际出现的术语写进 prompt。全量注入会随词表线性吃上下文：
// 真机实测 113 条 = 890 tokens（占 ctx 2048 的 43%），文本超过 ~350 字即超预算；
// 按需注入后词表规模与上下文占用解耦，词表再大也不拖慢翻译。
const MAX_INJECTED_TERMS = 60 // 上限保护：术语密集的长文本不至于挤爆上下文
function normTerm(s) {
  // 统一小写并把空白/连字符折算成单空格，让 "fine-tuning" / "fine tuning" / "Fine-Tuning" 等价
  return String(s == null ? '' : s).toLowerCase().replace(/[\s\u00a0\-–—_]+/g, ' ').trim()
}
// 拉丁术语按词边界匹配（避免 token 命中 tokenizer / AI 命中 OpenAI），并容忍复数（+s/+es）；
// 中文等非拉丁术语无词边界概念，直接子串匹配
function hasTerm(hay, needle) {
  if (!needle) return false
  if (!/[a-z]/.test(needle)) return hay.includes(needle)
  for (const v of [needle, needle + 's', needle + 'es']) {
    let idx = 0
    for (;;) {
      const i = hay.indexOf(v, idx)
      if (i < 0) break
      const before = i > 0 ? hay[i - 1] : ' '
      const after = i + v.length < hay.length ? hay[i + v.length] : ' '
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true
      idx = i + 1
    }
  }
  return false
}
// 命中源侧 → 按原方向注入；命中目标侧（中文源 + en=zh 词表）→ 反方向注入，
// 给模型"待译语言在前"的对照，比让它自己反推方向更稳
function matchTerms(text, terms) {
  const hay = normTerm(text)
  if (!hay) return []
  const out = []
  for (const k of Object.keys(terms || {})) {
    if (out.length >= MAX_INJECTED_TERMS) break
    const src = String(k).trim()
    const dst = String(terms[k] == null ? '' : terms[k]).trim()
    if (!src || !dst) continue
    if (hasTerm(hay, normTerm(src))) out.push([src, dst])
    else if (hasTerm(hay, normTerm(dst))) out.push([dst, src])
  }
  return out
}

function buildPrompt(text, settings = {}) {
  const tgt = LANGS[settings.tgtLang] || '中文'
  const parts = []
  const hits = matchTerms(text, settings.terms)
  if (hits.length) parts.push('参考下面的翻译：\n' + hits.map(([s, d]) => `${s} 翻译成 ${d}`).join('\n'))
  parts.push(`将以下文本翻译为${tgt}，注意只需要输出翻译后的结果，不要额外解释：`)
  parts.push('', text)
  return parts.join('\n')
}

function chatTranslate(text, settings) {
  const messages = []
  const styleMsg = buildStyleMessage(settings)
  // 风格句绝不能写进 user 正文：与待翻译文本同处一条消息时，1.8B 在
  // 翻译词/短句输入上会把风格句当正文翻出来（真机实测 279 组泄漏 150：
  // "翻译这段文字"→英语、"Translate this"→中文等；v0.3.7 的 ≤4 字符保底挡不住）。
  // 改放 system 后同套用例 0/279，且风格仍生效（正式/简洁输出可区分）。
  if (styleMsg) messages.push({ role: 'system', content: styleMsg })
  messages.push({ role: 'user', content: buildPrompt(text, settings) })
  return requestJson(serverPort, 'POST', '/v1/chat/completions', {
    messages,
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

// ---- TTS 本地语音朗读（sherpa-onnx WASM + 语音包按需安装）----
// 运行时（sherpa-onnx ~16MB WASM）随插件分发；语音包按需下载安装。
// espeak-ng-data 各语音包内容完全相同 → 只存一份共享（省 17MB/包）
// 用 fp32 而非 int8：WASM 无 int8 优化内核，实测 int8 反而慢 36%（1.94s vs 1.43s）
//
// 音色选型（实测，同一段中文；速度是 WASM 单线程下的真实值）：
//   piper 华燕        2.16x 实时 / 首块 1266ms —— 韵律平，用户反馈"机械、没顿挫感"
//   Matcha zh-en      2.85x 实时 / 首块  509ms —— 中英混排正常，故选它作中文默认
//   Matcha zh-baker   1.96x 实时              —— 会把英文词整个丢掉（Ignore OOV 'API'/'PDF'…），
//                                               翻译结果常夹英文术语，直接排除
//   MeloTTS           0.20x 实时              —— 比播放慢 5 倍，边生成边播必然卡，弃
//   Kokoro         0.10~0.22x 实时            —— 同上弃；且 JS 绑定写死 dictDir='' 导致中文 g2p 坏（Unknown token ❓）
// matcha 架构需要额外两个共享文件：声码器（51MB）与 espeak 音素数据（7MB，读英文词用）
const TTS_REL_BASE = 'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
const TTS_MIRROR_BASE = 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
const VOCODER_BASE = 'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models'
const VOCODER_MIRROR = 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models'
const VOICES = [
  { id: 'en-amy', lang: 'en', kind: 'vits', label: '英语 · Amy 女声', size: '64MB',
    file: 'vits-piper-en_US-amy-medium.tar.bz2', dir: 'vits-piper-en_US-amy-medium', model: 'en_US-amy-medium.onnx' },
  { id: 'en-ryan', lang: 'en', kind: 'vits', label: '英语 · Ryan 男声', size: '64MB',
    file: 'vits-piper-en_US-ryan-medium.tar.bz2', dir: 'vits-piper-en_US-ryan-medium', model: 'en_US-ryan-medium.onnx' },
  { id: 'zh-matcha', lang: 'zh', kind: 'matcha', label: '中文 · 女声 自然', size: '127MB',
    file: 'matcha-icefall-zh-en.tar.bz2', dir: 'matcha-icefall-zh-en', model: 'model-steps-3.onnx',
    lexicon: 'lexicon.txt', ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'],
    // size 是总下载量：语音包 75MB（浏览器下载后导入）+ 声码器 51MB（装完自动下）
    // 包内自带 espeak-ng-data，中英混排的英文词能直接读
    vocoder: { file: 'vocos-16khz-univ.onnx', size: '51MB' } },
  { id: 'zh-huayan', lang: 'zh', kind: 'vits', label: '中文 · 华燕 女声', size: '64MB',
    file: 'vits-piper-zh_CN-huayan-medium.tar.bz2', dir: 'vits-piper-zh_CN-huayan-medium', model: 'zh_CN-huayan-medium.onnx' },
]
function voicesRoot() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'voices') }
function espeakShared() { return path.join(voicesRoot(), '_espeak') }
function voiceDirOf(id) { return path.join(voicesRoot(), id) }
function voiceById(id) { return VOICES.find(v => v.id === id) }
function vocoderPath(v) { return path.join(voicesRoot(), '_vocoder', path.basename(v.vocoder.file)) }
// 装了模型还不够：matcha 架构必须连声码器一起就位；需要读英文词的还要 espeak 数据
function voiceInstalled(v) {
  try {
    if (!fs.existsSync(path.join(voiceDirOf(v.id), v.model))) return false
    if (v.vocoder && !fs.existsSync(vocoderPath(v))) return false
    return true
  } catch { return false }
}
// 引擎配置：vits 与 matcha 字段不同，统一在这里拼，子进程只认 spec
function voiceSpec(v) {
  const d = voiceDirOf(v.id)
  const espeak = espeakShared()
  const dataDir = fs.existsSync(espeak) ? espeak : ''
  if (v.kind === 'matcha') {
    return {
      kind: 'matcha',
      acousticModel: path.join(d, v.model),
      vocoder: vocoderPath(v),
      lexicon: path.join(d, v.lexicon || 'lexicon.txt'),
      tokens: path.join(d, 'tokens.txt'),
      dataDir,
      ruleFsts: (v.ruleFsts || []).map(f => path.join(d, f)).join(','),
    }
  }
  return { kind: 'vits', model: path.join(d, v.model), tokens: path.join(d, 'tokens.txt'), dataDir }
}
function voicePackInfo() {
  return { voices: VOICES.map(v => ({ ...v, installed: voiceInstalled(v) })), espeakReady: fs.existsSync(espeakShared()) }
}
function removeVoicePack(id) {
  fs.rmSync(voiceDirOf(id), { recursive: true, force: true })
  // 最后一个语音包也删了就清共享 espeak 与声码器
  if (!VOICES.some(voiceInstalled)) {
    fs.rmSync(espeakShared(), { recursive: true, force: true })
    fs.rmSync(path.join(voicesRoot(), '_vocoder'), { recursive: true, force: true })
  }
}

// ---- 语音合成子进程 ----
// 渲染进程不能跑这些 WASM：Chromium 主线程禁止同步编译 >4KB 的 WASM
// （"WebAssembly.Compile is disallowed on the main thread..."），而 sherpa 的
// nodejs 构建依赖同步实例化。改用 ELECTRON_RUN_AS_NODE 起一个纯 Node 子进程跑
// tts/tts-server.js（解压安装与合成都在一起），渲染层只发 HTTP 请求。
const TTS_PORT = 18156
let ttsProc = null
let ttsStarting = null
let ttsStderr = ''
let ttsStreamReq = null   // 当前进行中的流式朗读请求（新朗读/停止时掐掉）
function ttsScriptPath() { return path.join(__dirname, 'tts', 'tts-server.js') }
function writeTtsError(msg) {
  try {
    const dir = path.join(utools.getPath('userData'), 'utools-hy-mt2')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'last-tts-error.txt'),
      new Date().toLocaleString() + '\n' + msg + '\n', 'utf8')
  } catch {}
}
function ttsErrorLogPath() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'last-tts-error.txt') }
// 读/清错误日志：界面展示与一键复制，便于用户回报问题
function readTtsErrorLog() {
  try { const p = ttsErrorLogPath(); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' } catch { return '' }
}
function clearTtsErrorLog() {
  try { fs.rmSync(ttsErrorLogPath(), { force: true }) } catch {}
}
function ttsAlive(proc) { return !!proc && proc.exitCode === null && !proc.killed }

function startTtsServer() {
  const script = ttsScriptPath()
  if (!fs.existsSync(script)) return Promise.reject(new Error('语音服务脚本缺失: ' + script))
  ttsStderr = ''
  try {
    ttsProc = spawn(process.execPath, [script, String(TTS_PORT), voicesRoot(), espeakShared(), ttsRuntimeDir()], {
      env: Object.assign({}, process.env || {}, { ELECTRON_RUN_AS_NODE: '1' }),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    return Promise.reject(new Error('语音服务启动失败: ' + e.message))
  }
  ttsProc.stderr.on('data', (d) => { ttsStderr = (ttsStderr + d.toString()).slice(-4000) })
  ttsProc.on('error', (e) => { ttsStderr = (ttsStderr + '\n启动异常: ' + e.message).slice(-4000) })
  // 轮询就绪（首次加载 WASM 约 1~3 秒，给足 20 秒）
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000
    const poll = setInterval(async () => {
      if (!ttsAlive(ttsProc)) {
        clearInterval(poll)
        return reject(new Error('语音服务启动失败（进程退出）' + (ttsStderr ? ': ' + ttsStderr.slice(-300) : '')))
      }
      try {
        const h = await requestJson(TTS_PORT, 'GET', '/health', null, 1500)
        if (h.statusCode === 200 && h.json && h.json.status === 'ok') {
          clearInterval(poll)
          return resolve(true)
        }
      } catch {}
      if (Date.now() > deadline) {
        clearInterval(poll)
        reject(new Error('语音服务启动超时' + (ttsStderr ? ': ' + ttsStderr.slice(-300) : '')))
      }
    }, 400)
  })
}
function ensureTtsServer() {
  if (ttsAlive(ttsProc)) return Promise.resolve(true)
  if (!ttsStarting) {
    ttsStarting = startTtsServer().finally(() => { ttsStarting = null })
  }
  return ttsStarting
}
// 与子进程通信（失败时把子进程 stderr 一并落盘，便于用户复制报错）
async function ttsCall(apiPath, body, timeoutMs) {
  await ensureTtsServer()
  let r
  try {
    r = await requestJson(TTS_PORT, 'POST', apiPath, body, timeoutMs || 60000)
  } catch (e) {
    const msg = '语音服务请求失败: ' + e.message + (ttsStderr ? '\n--- 服务日志 ---\n' + ttsStderr : '')
    writeTtsError(msg)
    throw new Error('语音服务请求失败: ' + e.message)
  }
  if (!r.json || r.json.ok !== true) {
    const err = (r.json && r.json.error) || ('HTTP ' + r.statusCode + ' ' + String(r.raw || '').slice(0, 200))
    writeTtsError('合成/安装失败: ' + err + (ttsStderr ? '\n--- 服务日志 ---\n' + ttsStderr : ''))
    throw new Error(err)
  }
  return r.json
}
// 应用内下载（带进度）：声码器这种 51MB 的附属文件，让用户"跳浏览器再手动导入"
// 太折腾，这里直接下。进度按 NDJSON 回传，界面照常显示 MB 数。
async function fetchVoiceAsset(urls, dest, onProgress) {
  await ensureTtsServer()
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ urls, dest })
    const req = http.request({
      host: '127.0.0.1', port: TTS_PORT, path: '/fetch', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    })
    let buf = '', err = null
    req.on('response', (res) => {
      res.setEncoding('utf8')
      res.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line.trim()) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.t === 'p') { if (onProgress) onProgress(msg.got, msg.total) }
          else if (msg.t === 'x') err = msg.error
        }
      })
      res.on('end', () => { err ? reject(new Error(err)) : resolve(true) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

// ---- 语音合成运行时（外置）----
// sherpa-onnx(4.3MB) + wasm-bz2(0.3MB) + tslib(0.01MB) 的 WASM/JS 不随插件分发（否则插件包
// 从百 KB 涨到 17MB），首次用到 TTS 时从 npm 镜像拉官方 tarball（npmmirror 国内直连，
// npmjs 兜底），解压到用户数据目录 tts-runtime/。版本锁定在常量里，升级 = 改常量（自动重下）。
// tslib 是 wasm-bz2 的运行依赖：它 require('tslib') 时从 wasm-bz2/dist 向上找 node_modules，
// 所以必须落在 tts-runtime/node_modules/tslib 这个相对位置，解压到别处找不到。
const SHERPA_VERSION = '1.13.8'
const WASM_BZ2_VERSION = '0.3.0'
const TSLIB_VERSION = '2.8.1'
const TTS_RUNTIME_VERSION = 'sherpa-onnx@' + SHERPA_VERSION + ' wasm-bz2@' + WASM_BZ2_VERSION + ' tslib@' + TSLIB_VERSION
const NPM_MIRROR = 'https://registry.npmmirror.com'
const NPM_OFFICIAL = 'https://registry.npmjs.org'
function ttsRuntimeDir() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'tts-runtime') }
// 就绪判定：版本标记一致 + 关键文件都在（.wasm 是本体，缺了就是半截安装）
function ttsRuntimeReady() {
  try {
    const root = ttsRuntimeDir()
    return fs.readFileSync(path.join(root, 'version.txt'), 'utf8').trim() === TTS_RUNTIME_VERSION &&
      fs.existsSync(path.join(root, 'sherpa-onnx', 'index.js')) &&
      fs.existsSync(path.join(root, 'sherpa-onnx', 'sherpa-onnx-wasm-nodejs.wasm')) &&
      fs.existsSync(path.join(root, 'wasm-bz2', 'wasm', 'module.wasm')) &&
      fs.existsSync(path.join(root, 'node_modules', 'tslib', 'tslib.js'))
  } catch { return false }
}
let ttsRuntimeEnsuring = null
function ensureTtsRuntime(onPhase) {
  if (ttsRuntimeReady()) return Promise.resolve(true)
  // 并发保护：一键安装与后台预热可能同时触发，只下载一次
  if (!ttsRuntimeEnsuring) {
    ttsRuntimeEnsuring = downloadTtsRuntime(onPhase).finally(() => { ttsRuntimeEnsuring = null })
  }
  return ttsRuntimeEnsuring
}
async function downloadTtsRuntime(onPhase) {
  const root = ttsRuntimeDir()
  fs.rmSync(root, { recursive: true, force: true })
  const pkgs = [
    { name: 'sherpa-onnx', file: 'sherpa-onnx-' + SHERPA_VERSION + '.tgz', dest: 'sherpa-onnx' },
    { name: '@foxglove/wasm-bz2', file: 'wasm-bz2-' + WASM_BZ2_VERSION + '.tgz', dest: 'wasm-bz2' },
    { name: 'tslib', file: 'tslib-' + TSLIB_VERSION + '.tgz', dest: path.join('node_modules', 'tslib') },
  ]
  try {
    for (const p of pkgs) {
      const tgz = path.join(root, p.file)
      const urls = [NPM_MIRROR + '/' + p.name + '/-/' + p.file, NPM_OFFICIAL + '/' + p.name + '/-/' + p.file]
      await fetchVoiceAsset(urls, tgz, (got, total) => {
        if (onPhase) onPhase(`下载运行时 ${p.name} ${(got / 1048576).toFixed(1)}MB` + (total ? ' / ' + (total / 1048576).toFixed(1) + 'MB' : '') + '...')
      })
      if (onPhase) onPhase('解压运行时 ' + p.name + '...')
      await ttsCall('/extract', { archive: tgz, destDir: path.join(root, p.dest) }, 120000)
      fs.rmSync(tgz, { force: true })
    }
  } finally {
    for (const p of pkgs) { try { fs.rmSync(path.join(root, p.file), { force: true }) } catch {} }
  }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'version.txt'), TTS_RUNTIME_VERSION)
  if (!ttsRuntimeReady()) throw new Error('语音运行时安装后校验失败')
  return true
}

async function installVoicePack(archivePath, onPhase) {
  await ensureTtsRuntime(onPhase) // 解压语音包用的 wasm-bz2 就在运行时里
  if (!fs.existsSync(archivePath)) {
    const msg = '语音包文件不存在: ' + archivePath
    writeTtsError(msg)
    throw new Error(msg)
  }
  onPhase && onPhase('解压语音包中（约 10~30 秒）...')
  // 语音包身份由归档顶层目录名决定，逐个匹配注册表
  let voice = null
  for (const v of VOICES) {
    if (path.basename(archivePath).includes(v.dir.replace('vits-piper-', ''))) { voice = v; break }
  }
  // 文件名不可靠（用户可能重命名）→ 交给子进程按顶层目录判定，这里只传全部候选
  const r = await ttsCall('/install', {
    archive: archivePath,
    targetDir: voice ? voiceDirOf(voice.id) : path.join(voicesRoot(), '_incoming'),
    espeakDir: espeakShared(),
    expectTop: voice ? voice.dir : '',
  }, 180000)
  let id = voice ? voice.id : ''
  if (!id) {
    // 文件名没匹配上：用子进程返回的顶层目录反查
    const v = VOICES.find(x => x.dir === r.topDir)
    if (!v) { fs.rmSync(path.join(voicesRoot(), '_incoming'), { recursive: true, force: true }); throw new Error('不是支持的语音包（顶层目录 ' + r.topDir + '）') }
    id = v.id
    fs.rmSync(voiceDirOf(id), { recursive: true, force: true })
    fs.renameSync(path.join(voicesRoot(), '_incoming'), voiceDirOf(id))
  }
  const vv = voiceById(id)
  if (!vv) throw new Error('安装后未找到模型文件')
  await ensureVocoder(vv, onPhase)
  if (!voiceInstalled(vv)) throw new Error('安装后未找到模型文件')
  return { id, files: r.files }
}
// matcha 架构的附属文件（各包共用一份，装在 voices/_vocoder）
async function ensureVocoder(vv, onPhase) {
  if (!vv.vocoder || fs.existsSync(vocoderPath(vv))) return
  const vd = vv.vocoder
  onPhase && onPhase('下载声码器（' + (vd.size || '') + '）...')
  await fetchVoiceAsset([VOCODER_BASE + '/' + vd.file, VOCODER_MIRROR + '/' + vd.file], vocoderPath(vv), (got, total) => {
    if (onPhase) onPhase(`下载声码器 ${(got / 1048576).toFixed(1)}MB` + (total ? ' / ' + (total / 1048576).toFixed(1) + 'MB' : '') + '...')
  })
}

/**
 * 应用内下载并安装单个语音包（不跳浏览器、不需要用户找文件再导入）。
 * 下载 → 解压 → （matcha）补声码器 → 校验，最后删掉压缩包只留解压产物。
 */
async function downloadAndInstallVoice(id, onPhase) {
  const v = voiceById(id)
  if (!v) throw new Error('未知语音包: ' + id)
  if (voiceInstalled(v)) return { id, skipped: true }
  await ensureTtsRuntime(onPhase) // 解压语音包用的 wasm-bz2 就在运行时里
  const dest = path.join(voicesRoot(), '_downloads', v.file)
  try {
    if (!fs.existsSync(dest)) {
      await fetchVoiceAsset([TTS_REL_BASE + '/' + v.file, TTS_MIRROR_BASE + '/' + v.file], dest, (got, total) => {
        if (onPhase) onPhase(`下载 ${v.file} ${(got / 1048576).toFixed(0)}MB` + (total ? ' / ' + (total / 1048576).toFixed(0) + 'MB' : '') + '...')
      })
    }
    onPhase && onPhase('解压安装中（大包需要十几秒）...')
    const r = await ttsCall('/install', { archive: dest, targetDir: voiceDirOf(v.id), espeakDir: espeakShared(), expectTop: v.dir }, 180000)
    await ensureVocoder(v, onPhase)
    if (!voiceInstalled(v)) throw new Error('安装后未找到模型文件')
    return { id, files: r.files }
  } finally {
    try { fs.rmSync(dest, { force: true }) } catch {}
  }
}

// 一键装齐推荐组合（英语 Amy + 中文 Matcha 女声），已装的自动跳过。
// 用户只按一次、全程应用内下载、装完由渲染层自动启用 —— 不用来回导入、不用挑包。
const VOICE_BUNDLE = ['en-amy', 'zh-matcha']
async function installVoiceBundle(onPhase) {
  const installed = []
  for (let i = 0; i < VOICE_BUNDLE.length; i++) {
    const v = voiceById(VOICE_BUNDLE[i])
    if (!v) continue
    if (voiceInstalled(v)) { installed.push(v.id); continue }
    const tag = `（${i + 1}/${VOICE_BUNDLE.length}）`
    await downloadAndInstallVoice(v.id, (msg) => { if (onPhase) onPhase(tag + msg) })
    installed.push(v.id)
  }
  return { installed }
}
function chooseVoicePackFile() {
  return new Promise((resolve) => {
    const r = utools.showOpenDialog({
      title: '选择下载好的语音包（.tar.bz2）',
      properties: ['openFile'],
      filters: [{ name: '语音包', extensions: ['bz2'] }],
    })
    resolve(r && r.length ? r[0] : null)
  })
}
async function openVoicePackDownload(id) {
  const v = voiceById(id)
  if (!v) throw new Error('未知语音包: ' + id)
  await openExternal(TTS_REL_BASE + '/' + v.file)
  return { ok: true, file: v.file, size: v.size }
}

async function ttsSynthesize(text, voiceId) {
  const v = voiceById(voiceId)
  if (!v) return { ok: false, reason: '未知语音包' }
  if (!voiceInstalled(v)) return { ok: false, reason: '语音包未安装' }
  try {
    await ensureTtsRuntime()
    const r = await ttsCall('/synth', { spec: voiceSpec(v), text }, 120000)
    return { ok: true, wav: r.wav, sampleRate: r.sampleRate }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

/**
 * 流式朗读：分段合成，逐段推回渲染层，首字几百毫秒就出声。
 *
 * 与 ttsSynthesize 的区别是"不等人"：整篇合成完再播，用户要对着静默等 10 秒以上；
 * 这里第一段算完立刻就能入播放队列，后面的段在播放期间陆续到达（实测生成速度约为
 * 播放速度的 2 倍，所以队列只会越攒越多，不会断）。
 * 返回 { cancel() }，用户停止或发起新朗读时调用。
 */
function ttsSpeakStream(text, voiceId, handlers) {
  const h = handlers || {}
  const v = voiceById(voiceId)
  let finished = false
  let cancelled = false
  let sr = 22050
  const fire = (name, arg) => {
    if (finished) return
    if (name === 'onDone' || name === 'onError') finished = true
    try { h[name] && h[name](arg) } catch (e) { writeTtsError('朗读回调异常: ' + e.message) }
  }
  const fail = (msg) => {
    writeTtsError(msg + (ttsStderr ? '\n--- 服务日志 ---\n' + ttsStderr : ''))
    fire('onError', new Error(msg))
  }
  const cancel = () => {
    cancelled = true
    if (ttsStreamReq) { try { ttsStreamReq.destroy() } catch {} ; ttsStreamReq = null }
  }
  if (ttsStreamReq) { try { ttsStreamReq.destroy() } catch {} ; ttsStreamReq = null }

  ;(async () => {
    try {
      if (!v) throw new Error('未知语音包')
      if (!voiceInstalled(v)) throw new Error('语音包未安装')
      await ensureTtsRuntime()
      await ensureTtsServer()
      const body = JSON.stringify({ spec: voiceSpec(v), text })
      const req = http.request({
        host: '127.0.0.1', port: TTS_PORT, path: '/synth-stream', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      })
      ttsStreamReq = req
      let buf = ''
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          let raw = ''
          res.on('data', (d) => { raw += d })
          res.on('end', () => fail('朗读失败 HTTP ' + res.statusCode + ': ' + raw.slice(0, 200)))
          return
        }
        res.setEncoding('utf8')
        res.on('data', (d) => {
          buf += d
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (!line.trim()) continue
            let msg
            try { msg = JSON.parse(line) } catch { continue }
            if (msg.t === 's') { sr = msg.sr || sr; fire('onStart', msg) }
            else if (msg.t === 'c') fire('onChunk', { pcm: msg.pcm, sr })
            else if (msg.t === 'e') fire('onDone', msg)
            else if (msg.t === 'x') fail('朗读失败: ' + msg.error)
          }
        })
        res.on('end', () => { if (!finished && !cancelled) fail('朗读流意外中断') })
      })
      req.on('error', (e) => {
        if (ttsStreamReq === req) ttsStreamReq = null
        if (!cancelled) fail('朗读请求失败: ' + e.message)
      })
      req.end(body)
    } catch (e) {
      if (!cancelled) fail('朗读失败: ' + e.message)
    }
  })()

  return { cancel }
}
// 预热：起服务并把已启用语音包的引擎先建好（首次约 3~7 秒）
function ttsWarmup(voiceIds) {
  const ids = Array.isArray(voiceIds) && voiceIds.length ? voiceIds : VOICES.filter(voiceInstalled).map(v => v.id)
  const list = ids.map(voiceById).filter(v => v && voiceInstalled(v))
  if (!list.length) return { ok: true, warmed: [] }
  ;(async () => {
    try {
      await ensureTtsRuntime()
      await ensureTtsServer()
      for (const v of list) {
        await ttsCall('/warmup', { spec: voiceSpec(v) }, 120000)
      }
    } catch (e) { writeTtsError('预热失败: ' + e.message) }
  })()
  return { ok: true, warming: list.map(v => v.id) }
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
  // 多规格模型：id 缺省一律回落默认档（1.8B Q4_K_M），老配置（storage.json 无 modelId）行为不变
  listModels(dir) { return MODELS.map((m) => ({ id: m.id, label: m.label, size: m.size, ram: m.ram, note: m.note, file: m.file, installed: modelInstalled(dir, m) })) },
  modelExists(dir, id) { return !!dir && modelInstalled(dir, modelById(id)) },
  getModelFile(dir, id) { return dir ? modelPathIn(dir, modelById(id)) : '' },
  getModelUrl(id) { return modelUrls(modelById(id))[0].url },
  // 手动下载用链接清单（ModelScope 国内直连 → hf-mirror → 官方站，逐行给复制按钮）
  modelLinks(id) {
    const m = modelById(id)
    return { rows: modelUrls(m), file: m.file, size: m.size }
  },
  openModelDir(dir, id) { utools.showItemInFolder(modelPathIn(dir, modelById(id))) },
  // 打开系统浏览器下载所选规格（ModelScope 国内直链；下载完成后点「导入模型文件」或重进插件自动检测）
  async openModelDownload(id) {
    const m = modelById(id)
    await openExternal(modelUrls(m)[0].url)
    return { ok: true, file: m.file, size: m.size, url: modelUrls(m)[0].url }
  },
  // 手动下载的文件可能落在下载目录：选文件后拷入模型目录（按文件名匹配官方档位，大小写不敏感）
  chooseModelFile() {
    return new Promise((resolve) => {
      const r = utools.showOpenDialog({
        title: '选择下载好的模型文件（.gguf）',
        properties: ['openFile'],
        filters: [{ name: '模型文件', extensions: ['gguf'] }],
      })
      resolve(r && r.length ? r[0] : null)
    })
  },
  importModelFile(src, dir) {
    if (!dir) throw new Error('请先选择模型存放目录')
    if (!fs.existsSync(src)) throw new Error('文件不存在: ' + src)
    const base = path.basename(src)
    const m = MODELS.find((x) => x.file.toLowerCase() === base.toLowerCase())
    if (!m) throw new Error('不是官方模型文件：' + base + '（支持的文件名见下载页）')
    const sz = fs.statSync(src).size
    if (sz <= 100 * 1024 * 1024) throw new Error(base + ' 只有 ' + (sz / 1048576).toFixed(0) + 'MB，疑似未下载完整')
    const dest = modelPathIn(dir, m)
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest)
    return { id: m.id, label: m.label, file: m.file }
  },
  // 预热（进插件调用）：启动/复用服务；睡眠中则唤醒，之后首译无需等待
  // onPhase(phase) 用于状态显示：'启动引擎中...' / '唤醒中...'
  async ensureModel(onPhase) {
    const mp = activeModelPath(readCfg())
    if (!mp) return { ok: false, reason: '未配置模型' }
    try {
      await ensureEngine(onPhase)
      const st0 = await probePort(FIXED_PORT)
      if (st0 && st0.up) {
        const cur = await runningModelPath(FIXED_PORT)
        if (!cur || sameModelPath(cur, mp)) { // 同模型：唤醒/等待即可
          if (st0.sleeping) {
            if (onPhase) onPhase('唤醒中...')
            await requestJson(FIXED_PORT, 'POST', '/completion', { prompt: 'Hi', n_predict: 1, cache_prompt: false }, 60000)
            return { ok: true }
          }
          if (!st0.loading) return { ok: true }
          await waitModelReady(FIXED_PORT) // 加载中(503)：等就绪
          return { ok: true }
        }
        // 端口上是别的规格：不唤醒不收养，交给 startServer 清掉重启
      }
      if (onPhase) onPhase('启动引擎中...')
      await startServer(mp)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  },
  // 翻译（服务可能已睡眠自动唤醒/意外退出则重启，失败后重试一次）
  async translate(text, settings) {
    const mp = (settings && settings.modelPath) || activeModelPath(readCfg())
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
  // TTS 本地语音朗读：语音包列表/安装/卸载/合成/下载链接
  voicePackInfo,
  chooseVoicePackFile,
  installVoicePack,
  downloadAndInstallVoice,
  installVoiceBundle,
  removeVoicePack,
  openVoicePackDownload,
  ttsSynthesize,
  ttsSpeakStream,
  ttsWarmup,
  readTtsErrorLog,
  clearTtsErrorLog,
  ttsErrorLogPath,
}
