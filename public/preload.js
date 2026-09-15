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
const { downloadFile } = require('./download.js')

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

// ---- TTS 本地语音朗读（sherpa-onnx 原生运行时 + 语音包按需安装）----
// 运行时外置下载：sherpa-onnx-node（原生 NAPI 绑定，onnxruntime CPU 多线程）+ 当前平台
// 二进制包，npmmirror 直连；比旧 WASM 构建快数倍且支持多线程，Kokoro 82M 才跑得动。
// espeak-ng-data 各语音包内容完全相同 → 只存一份共享（省 17MB/包）。
//
// 音色选型（原生 fp32 实测，18 核机 / 8 线程；实时率 = 音频时长 ÷ 合成耗时）：
//   Kokoro v1.1-zh    1.41x 实时（长文稳态） —— 103 音色（55 中文女声 + 45 中文男声 + 3 英语），
//                                                质量同级开源最佳，作旗舰多语种包
//   Matcha zh-en      2.85x 实时（WASM 时代实测，原生更快）—— 轻量中文备选（127MB）
//   piper en/华燕     2.16x 实时 —— 轻量备选；韵律平但胜在小
//   Kokoro int8       0.4x 实时（本机原生无 VNNI 内核，反比 fp32 慢 3 倍）—— 弃
//   MeloTTS/Kokoro(WASM) ≤0.22x —— 旧 WASM 运行时的历史结论，随运行时换血作废
// 注意：espeak-ng 在 Windows 上打不开含中文的路径（UTF-8 进 ANSI fopen 全乱），
// 语音服务子进程以 voices 为工作目录、所有引擎路径一律用相对路径规避。
const TTS_REL_BASE = 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
const TTS_MIRROR_BASE = 'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
const VOCODER_BASE = 'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models'
const VOCODER_MIRROR = 'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models'
// Kokoro 多语种包的 sid→名字对照（官方 fixed 表：sid 0~2 英/英音，3~57 中文女声，58~102 中文男声）
const KOKORO_ZF = ['zf_001','zf_002','zf_003','zf_004','zf_005','zf_006','zf_007','zf_008','zf_017','zf_018','zf_019','zf_021','zf_022','zf_023','zf_024','zf_026','zf_027','zf_028','zf_032','zf_036','zf_038','zf_039','zf_040','zf_042','zf_043','zf_044','zf_046','zf_047','zf_048','zf_049','zf_051','zf_059','zf_060','zf_067','zf_070','zf_071','zf_072','zf_073','zf_074','zf_075','zf_076','zf_077','zf_078','zf_079','zf_083','zf_084','zf_085','zf_086','zf_087','zf_088','zf_090','zf_092','zf_093','zf_094','zf_099']
const KOKORO_ZM = ['zm_009','zm_010','zm_011','zm_012','zm_013','zm_014','zm_015','zm_016','zm_020','zm_025','zm_029','zm_030','zm_031','zm_033','zm_034','zm_035','zm_037','zm_041','zm_045','zm_050','zm_052','zm_053','zm_054','zm_055','zm_056','zm_057','zm_058','zm_061','zm_062','zm_063','zm_064','zm_065','zm_066','zm_068','zm_069','zm_080','zm_081','zm_082','zm_089','zm_091','zm_095','zm_096','zm_097','zm_098','zm_100']
const KOKORO_EN = ['af_maple','af_sol','bf_vale']
function kokoroCatalog() {
  const g = (names, start, group, label) => names.map((name, i) => ({ sid: start + i, name, group, label }))
  return [
    ...g(KOKORO_EN, 0, 'en', '英语'),
    ...g(KOKORO_ZF, 3, 'zh-f', '中文女声'),
    ...g(KOKORO_ZM, 58, 'zh-m', '中文男声'),
  ]
}
// 各语言在 Kokoro 里的默认音色（zh → zf_001，en → af_maple）
const KOKORO_DEFAULT_SID = { zh: 3, en: 0 }
const VOICES = [
  {
    id: 'kokoro-v1_1', kind: 'kokoro', label: 'Kokoro 多语种', size: '348MB', flagship: true,
    file: 'kokoro-multi-lang-v1_1.tar.bz2', dir: 'kokoro-multi-lang-v1_1', model: 'model.onnx',
    lexicons: ['lexicon-zh.txt', 'lexicon-us-en.txt', 'lexicon-gb-en.txt'],
    ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'],
  },
  { id: 'en-amy', lang: 'en', kind: 'vits', label: '英语 · Amy 女声', size: '64MB',
    file: 'vits-piper-en_US-amy-medium.tar.bz2', dir: 'vits-piper-en_US-amy-medium', model: 'en_US-amy-medium.onnx' },
  { id: 'en-ryan', lang: 'en', kind: 'vits', label: '英语 · Ryan 男声', size: '64MB',
    file: 'vits-piper-en_US-ryan-medium.tar.bz2', dir: 'vits-piper-en_US-ryan-medium', model: 'en_US-ryan-medium.onnx' },
  { id: 'zh-matcha', lang: 'zh', kind: 'matcha', label: '中文 · 女声 自然', size: '127MB',
    file: 'matcha-icefall-zh-en.tar.bz2', dir: 'matcha-icefall-zh-en', model: 'model-steps-3.onnx',
    lexicon: 'lexicon.txt', ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'],
    // size 是总下载量：语音包 75MB + 声码器 51MB（装完自动下）
    vocoder: { file: 'vocos-16khz-univ.onnx', size: '51MB' } },
  { id: 'zh-huayan', lang: 'zh', kind: 'vits', label: '中文 · 华燕 女声', size: '64MB',
    file: 'vits-piper-zh_CN-huayan-medium.tar.bz2', dir: 'vits-piper-zh_CN-huayan-medium', model: 'zh_CN-huayan-medium.onnx' },
]
function voicesRoot() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'voices') }
function espeakShared() { return path.join(voicesRoot(), '_espeak') }
function voiceDirOf(id) { return path.join(voicesRoot(), id) }
function voiceById(id) { return VOICES.find(v => v.id === id) }
function vocoderPath(v) { return path.join(voicesRoot(), '_vocoder', path.basename(v.vocoder.file)) }
// 装了模型还不够：kokoro 要 voices.bin + 包内私有 espeak 数据，matcha 架构必须连声码器一起就位
function voiceInstalled(v) {
  try {
    if (!fs.existsSync(path.join(voiceDirOf(v.id), v.model))) return false
    if (v.kind === 'kokoro') {
      if (!fs.existsSync(path.join(voiceDirOf(v.id), 'voices.bin'))) return false
      if (!fs.existsSync(path.join(voiceDirOf(v.id), '_espeak', 'phontab'))) return false
    }
    if (v.vocoder && !fs.existsSync(vocoderPath(v))) return false
    return true
  } catch { return false }
}
// 引擎配置：vits / matcha / kokoro 字段不同，统一在这里拼，子进程只认 spec。
// 路径全部相对 voices 根目录 —— 语音服务子进程以该目录为 cwd（espeak-ng 在 Windows
// 上读不了非 ASCII 路径，绝对路径里只要带中文用户名/桌面等就崩，相对路径天然避开）。
function voiceSpec(v) {
  const d = v.id
  const espeak = '_espeak'
  const dataDir = fs.existsSync(path.join(voicesRoot(), espeak)) ? espeak : ''
  if (v.kind === 'kokoro') {
    return {
      kind: 'kokoro',
      model: d + '/' + v.model,
      voices: d + '/voices.bin',
      tokens: d + '/tokens.txt',
      lexicon: (v.lexicons || []).map(f => d + '/' + f).join(','),
      // espeak 用包内私有目录，不吃共享 _espeak：旧轻量包留下的可能是 7MB 子集，
      // 安装时的"已存在跳过"会让 Kokoro 缺文件（它需要完整 17MB 版）
      dataDir: d + '/_espeak',
      ruleFsts: (v.ruleFsts || []).map(f => d + '/' + f).join(','),
    }
  }
  if (v.kind === 'matcha') {
    return {
      kind: 'matcha',
      acousticModel: d + '/' + v.model,
      vocoder: '_vocoder/' + path.basename(v.vocoder.file),
      lexicon: d + '/' + (v.lexicon || 'lexicon.txt'),
      tokens: d + '/tokens.txt',
      dataDir,
      ruleFsts: (v.ruleFsts || []).map(f => d + '/' + f).join(','),
    }
  }
  return { kind: 'vits', model: d + '/' + v.model, tokens: d + '/tokens.txt', dataDir }
}
function voicePackInfo() {
  return {
    voices: VOICES.map(v => ({ ...v, installed: voiceInstalled(v) })),
    espeakReady: fs.existsSync(espeakShared()),
    runtimeReady: ttsRuntimeReady(),
    kokoroVoices: kokoroCatalog(),
    kokoroDefaultSid: KOKORO_DEFAULT_SID,
  }
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
    // cwd 必须真实存在，spawn 才能起进程（首次使用时 voices 目录还没建过）
    fs.mkdirSync(voicesRoot(), { recursive: true })
    ttsProc = spawn(process.execPath, [script, String(TTS_PORT), voicesRoot(), espeakShared(), ttsRuntimeDir()], {
      env: Object.assign({}, process.env || {}, { ELECTRON_RUN_AS_NODE: '1' }),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      // cwd 固定在 voices 根：spec 里的模型路径全部相对这里（espeak-ng 读不了非 ASCII 路径）
      cwd: voicesRoot(),
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
// 应用内下载（与模型/引擎同一套 download.js）：多镜像自动换源 + Range 断点续传 +
// 背压 + 进度回调，Kokoro 这种 348MB 的大包中途断网也能接着下，不用从头来。
// 返回 { cancel() }，界面可中断（.part 保留供下次续传）。
function voiceDownload(urls, dest, onProgress) {
  let cancelled = false
  const promise = downloadFile(urls, dest, {
    onProgress: (p) => {
      if (onProgress) {
        onProgress(p.received, p.total, p.speed)
      }
    },
    aborted: () => cancelled,
  })
  return { promise, cancel: () => { cancelled = true } }
}

// ---- 语音合成运行时（外置）----
// 原生 sherpa-onnx-node 不随插件分发（win 平台二进制解压 22MB，全平台塞进来插件包要破百 MB），
// 首次用到 TTS 时从 npm 镜像拉官方 tarball（npmmirror 国内直连，npmjs 兜底）解压到
// tts-runtime/。版本锁定在常量里，升级 = 改常量（自动重下）。
// 平台二进制必须落在 sherpa-onnx-node/node_modules/sherpa-onnx-<平台>-<架构>/ ——
// 绑定层 addon.js 按该相对位置 require 平台 .node。
// wasm-bz2 + tslib 仍要装：语音包是 tar.bz2，解压靠它（合成本身已不用 WASM）。
// tslib 是 wasm-bz2 的运行依赖：它 require('tslib') 时从 wasm-bz2/dist 向上找 node_modules，
// 所以必须落在 tts-runtime/node_modules/tslib 这个相对位置，解压到别处找不到。
const SHERPA_NODE_VERSION = '1.13.8'
const WASM_BZ2_VERSION = '0.3.0'
const TSLIB_VERSION = '2.8.1'
const TTS_RUNTIME_VERSION = 'sherpa-onnx-node@' + SHERPA_NODE_VERSION + ' wasm-bz2@' + WASM_BZ2_VERSION + ' tslib@' + TSLIB_VERSION
const NPM_MIRROR = 'https://registry.npmmirror.com'
const NPM_OFFICIAL = 'https://registry.npmjs.org'
function ttsRuntimeDir() { return path.join(utools.getPath('userData'), 'utools-hy-mt2', 'tts-runtime') }
// 当前平台对应的原生二进制包名（sherpa-onnx npm 的平台包命名规则）
function sherpaPlatformPkg() {
  const p = process.platform, a = process.arch
  const plat = p === 'win32' ? 'win' : p
  if ((p === 'win32' || p === 'linux' || p === 'darwin') && (a === 'x64' || a === 'arm64')) {
    return 'sherpa-onnx-' + plat + '-' + a
  }
  return '' // 其余平台无官方原生包，TTS 不可用（界面会提示）
}
// 就绪判定：版本标记一致 + 关键文件都在（平台 .node 是本体，缺了就是半截安装）
function ttsRuntimeReady() {
  try {
    const root = ttsRuntimeDir()
    const pkg = sherpaPlatformPkg()
    if (!pkg) return false
    return fs.readFileSync(path.join(root, 'version.txt'), 'utf8').trim() === TTS_RUNTIME_VERSION &&
      fs.existsSync(path.join(root, 'sherpa-onnx-node', 'non-streaming-tts.js')) &&
      fs.existsSync(path.join(root, 'sherpa-onnx-node', 'node_modules', pkg, 'sherpa-onnx.node')) &&
      fs.existsSync(path.join(root, 'wasm-bz2', 'wasm', 'module.wasm')) &&
      fs.existsSync(path.join(root, 'node_modules', 'tslib', 'tslib.js'))
  } catch { return false }
}
let ttsRuntimeEnsuring = null
function ensureTtsRuntime(onPhase) {
  if (ttsRuntimeReady()) return Promise.resolve(true)
  const pkg = sherpaPlatformPkg()
  if (!pkg) return Promise.reject(new Error('当前平台（' + process.platform + '/' + process.arch + '）暂无语音运行时'))
  // 并发保护：一键安装与后台预热可能同时触发，只下载一次
  if (!ttsRuntimeEnsuring) {
    ttsRuntimeEnsuring = downloadTtsRuntime(onPhase).finally(() => { ttsRuntimeEnsuring = null })
  }
  return ttsRuntimeEnsuring
}
async function downloadTtsRuntime(onPhase) {
  const root = ttsRuntimeDir()
  fs.rmSync(root, { recursive: true, force: true })
  const pkg = sherpaPlatformPkg()
  const pkgs = [
    { name: 'sherpa-onnx-node', file: 'sherpa-onnx-node-' + SHERPA_NODE_VERSION + '.tgz', dest: 'sherpa-onnx-node' },
    { name: pkg, file: pkg + '-' + SHERPA_NODE_VERSION + '.tgz', dest: path.join('sherpa-onnx-node', 'node_modules', pkg) },
    { name: '@foxglove/wasm-bz2', file: 'wasm-bz2-' + WASM_BZ2_VERSION + '.tgz', dest: 'wasm-bz2' },
    { name: 'tslib', file: 'tslib-' + TSLIB_VERSION + '.tgz', dest: path.join('node_modules', 'tslib') },
  ]
  for (const p of pkgs) {
    const tgz = path.join(root, p.file)
    const dl = voiceDownload(
      [NPM_MIRROR + '/' + p.name + '/-/' + p.file, NPM_OFFICIAL + '/' + p.name + '/-/' + p.file],
      tgz,
      (got, total) => {
        if (onPhase) onPhase(`下载运行时 ${p.name} ${(got / 1048576).toFixed(1)}MB` + (total ? ' / ' + (total / 1048576).toFixed(1) + 'MB' : '') + '...')
      })
    await dl.promise
    if (onPhase) onPhase('解压运行时 ' + p.name + '...')
    await ttsCall('/extract', { archive: tgz, destDir: path.join(root, p.dest) }, 120000)
    fs.rmSync(tgz, { force: true }) // 解压成功才删包，失败留着（.part 还能续传补齐）
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
    espeakDir: voice && voice.kind === 'kokoro' ? path.join(voiceDirOf(voice.id), '_espeak') : espeakShared(),
    expectTop: voice ? voice.dir : '',
  }, voice && voice.kind === 'kokoro' ? 600000 : 180000)
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
  await ensureVocoder(vv, { onPhase })
  if (!voiceInstalled(vv)) throw new Error('安装后未找到模型文件')
  return { id, files: r.files }
}
// matcha 架构的附属文件（各包共用一份，装在 voices/_vocoder）
async function ensureVocoder(vv, opts) {
  const onPhase = opts && opts.onPhase
  if (!vv.vocoder || fs.existsSync(vocoderPath(vv))) return
  const vd = vv.vocoder
  onPhase && onPhase('下载声码器（' + (vd.size || '') + '）...')
  const dl = voiceDownload([VOCODER_BASE + '/' + vd.file, VOCODER_MIRROR + '/' + vd.file], vocoderPath(vv), (got, total) => {
    if (onPhase) onPhase(`下载声码器 ${(got / 1048576).toFixed(1)}MB` + (total ? ' / ' + (total / 1048576).toFixed(1) + 'MB' : '') + '...')
  })
  await dl.promise
}

/**
 * 应用内下载并安装单个语音包（不跳浏览器、不需要用户找文件再导入）。
 * 下载（多镜像 + 断点续传）→ 解压 → （matcha）补声码器 → 校验，最后删掉压缩包只留解压产物。
 */
async function downloadAndInstallVoice(id, opts) {
  const onPhase = opts && opts.onPhase
  const onProgress = opts && opts.onProgress
  const v = voiceById(id)
  if (!v) throw new Error('未知语音包: ' + id)
  if (voiceInstalled(v)) return { id, skipped: true }
  await ensureTtsRuntime(onPhase) // 解压语音包用的 wasm-bz2 就在运行时里
  const dest = path.join(voicesRoot(), '_downloads', v.file)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    if (!fs.existsSync(dest)) {
      const dl = voiceDownload([TTS_REL_BASE + '/' + v.file, TTS_MIRROR_BASE + '/' + v.file], dest, (got, total) => {
        if (onPhase) onPhase(`下载 ${v.file} ${(got / 1048576).toFixed(0)}MB` + (total ? ' / ' + (total / 1048576).toFixed(0) + 'MB' : '') + '...')
        if (onProgress) onProgress(got, total)
      })
      if (opts && opts.getCancel) opts.getCancel(() => dl.cancel())
      await dl.promise
    } else if (onPhase) {
      onPhase('发现上次未装完的下载，直接解压安装...')
    }
    onPhase && onPhase('解压安装中（Kokoro 大包约 1~2 分钟，轻量包十几秒）...')
    const r = await ttsCall('/install', { archive: dest, targetDir: voiceDirOf(v.id), espeakDir: v.kind === 'kokoro' ? path.join(voiceDirOf(v.id), '_espeak') : espeakShared(), expectTop: v.dir }, 600000)
    await ensureVocoder(v, { onPhase })
    if (!voiceInstalled(v)) throw new Error('安装后未找到模型文件')
    return { id, files: r.files }
  } finally {
    try { fs.rmSync(dest, { force: true }) } catch {}
  }
}

// 一键启用 = 只装旗舰 Kokoro 多语种包（103 音色一次到位），已装的自动跳过。
// 用户只按一次：运行时 + 语音包全程应用内下载，装完由渲染层自动选默认音色并预热。
const VOICE_BUNDLE = ['kokoro-v1_1']
async function installVoiceBundle(opts) {
  const installed = []
  for (let i = 0; i < VOICE_BUNDLE.length; i++) {
    const v = voiceById(VOICE_BUNDLE[i])
    if (!v) continue
    if (voiceInstalled(v)) { installed.push(v.id); continue }
    const tag = VOICE_BUNDLE.length > 1 ? `（${i + 1}/${VOICE_BUNDLE.length}）` : ''
    const o = opts || {}
    await downloadAndInstallVoice(v.id, {
      onPhase: (msg) => { if (o.onPhase) o.onPhase(tag + msg) },
      onProgress: (got, total) => { if (o.onProgress) o.onProgress(got, total) },
      getCancel: o.getCancel,
    })
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

// 语音引用："包id" 或 "包id:sid"（kokoro 一包多音色，sid 选具体人）
function parseVoiceRef(ref) {
  const s = String(ref || '')
  const i = s.indexOf(':')
  return { id: i < 0 ? s : s.slice(0, i), sid: i < 0 ? undefined : Number(s.slice(i + 1)) || 0 }
}

async function ttsSynthesize(text, voiceRef) {
  const { id, sid } = parseVoiceRef(voiceRef)
  const v = voiceById(id)
  if (!v) return { ok: false, reason: '未知语音包' }
  if (!voiceInstalled(v)) return { ok: false, reason: '语音包未安装' }
  try {
    await ensureTtsRuntime()
    const r = await ttsCall('/synth', { spec: voiceSpec(v), text, sid: sid || 0 }, 120000)
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
function ttsSpeakStream(text, voiceRef, handlers) {
  const h = handlers || {}
  const { id, sid } = parseVoiceRef(voiceRef)
  const v = voiceById(id)
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
      const body = JSON.stringify({ spec: voiceSpec(v), text, sid: sid || 0 })
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
// 预热：起服务并把已启用语音包的引擎先建好（原生 kokoro 首次约 3.5 秒）。
// 入参可以是 "包id" 或 "包id:sid"（预热只到引擎加载，sid 不影响引擎键）。
function ttsWarmup(voiceRefs) {
  const refs = Array.isArray(voiceRefs) && voiceRefs.length ? voiceRefs : VOICES.filter(voiceInstalled).map(v => v.id)
  const list = refs.map(r => voiceById(parseVoiceRef(r).id)).filter((v, i, a) => v && voiceInstalled(v) && a.indexOf(v) === i)
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
