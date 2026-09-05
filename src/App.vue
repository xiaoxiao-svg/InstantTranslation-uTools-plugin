<template>
  <div class="container">
    <!-- 引擎安装（v0.4.0 外置：插件包不内置引擎，三端首次使用单独安装一次） -->
    <div v-if="!engineReady" class="card full-card">
      <div class="cfg">
        <template v-if="engineData && engineData.target">
          <h3>首次使用需安装推理引擎（{{ engineData.target.label }}，{{ engineData.target.size }}）</h3>
          <p class="desc">引擎是本地翻译运行的核心，与模型一样只需安装一次；插件包因此不含引擎，可做到 KB 级体积，Win/Mac/Linux 三端通用。</p>
          <div class="cfg-actions">
            <button class="btn primary" :disabled="engineBusy" @click="installEngine">下载引擎</button>
            <button class="btn ghost" :disabled="engineBusy" @click="importEngine">导入安装包</button>
          </div>
          <div v-if="engineBusy" class="progress">
            <div class="progress-bar"><div class="fill" style="width:100%"></div></div>
            <span class="progress-text">{{ engineStatus }}</span>
          </div>
          <p v-else-if="engineStatus" class="progress-text copy-hint">{{ engineStatus }}</p>
          <div v-if="engineError" class="err-box">
            <p class="err-title">引擎安装失败</p>
            <p class="err-msg">{{ engineError }}</p>
            <p class="err-hint">用浏览器打开下方任一链接即可下载，下载完成后点"导入安装包"选择该文件；完整错误见 uTools 用户数据目录 utools-hy-mt2/last-engine-error.txt</p>
          </div>
          <p class="links-title">手动下载（任选一个链接，浏览器打开，复制链接用右侧按钮）：</p>
          <div class="link-row" v-for="(u, i) in engineData.mirrors" :key="i">
            <span class="link-txt">{{ u }}</span>
            <button class="btn ghost sm" @click="copyLink(u)">复制</button>
          </div>
          <p class="links-note">下载后回插件点「导入安装包」选该文件（.zip / .tar.gz）即可，无需手动解压；镜像链接为加速通道，官方直连不通时使用。</p>
        </template>
        <template v-else>
          <h3>当前平台暂不支持</h3>
          <p class="desc">插件支持 Windows / macOS / Linux，当前环境：{{ engineData && engineData.platform }}。可等待后续版本适配。</p>
        </template>
      </div>
      <div class="tips">
        <div class="tips-title"><span class="bulb">💡</span>说明</div>
        <div class="tip">引擎为 llama.cpp 官方构建 v{{ engineVersion }}（GPU 加速：Windows Vulkan / macOS Metal，无独显自动回退 CPU）。</div>
        <div class="tip">引擎存放在 uTools 用户数据目录 utools-hy-mt2/engine，删除后重新打开插件会重新引导安装。</div>
        <div class="tip">Linux 需要较新的系统库（glibc 2.35+，Ubuntu 22.04 / Debian 12 / Arch 等均可）。</div>
      </div>
    </div>

    <!-- 模型配置（首次使用 / 更换规格共用；等高页面，不拉伸窗口） -->
    <div v-else-if="!modelReady" class="card full-card">
      <div class="cfg">
        <div class="cfg-head">
          <h3>选择翻译模型</h3>
          <button v-if="configBack" class="btn ghost sm" @click="backToMain">返回</button>
        </div>
        <p class="desc">官方全家桶任选其一：1.8B 最快够用，7B 更强，30B-A3B 质量最佳。同一目录可存多个规格，之后在设置里随时切换。</p>
        <div class="model-list">
          <div v-for="m in models" :key="m.id" class="model-item" :class="{on: pickId===m.id}" @click="pickId=m.id">
            <span class="mi-radio"></span>
            <span class="mi-main">
              <span class="mi-name">{{ m.label }}
                <span v-if="m.installed" class="mi-badge ok">已安装</span>
                <span v-else-if="m.id==='1.8b-q4'" class="mi-badge">推荐</span>
              </span>
              <span class="mi-meta" :title="m.ram">{{ m.size }} · {{ m.note }}</span>
            </span>
          </div>
        </div>
        <div class="cfg-actions">
          <button class="btn ghost" @click="chooseDir">选择目录</button>
          <button class="btn ghost" :disabled="importing" @click="importModel">导入模型文件</button>
          <button class="btn primary" :disabled="downloading || !pickId" @click="startDownload">
            {{ picked && picked.installed ? '启用所选模型' : '下载所选模型' }}
          </button>
        </div>
        <div v-if="downloading" class="progress">
          <div class="progress-bar"><div class="fill" style="width:100%"></div></div>
          <span class="progress-text">{{ progressText }}</span>
        </div>
        <p v-if="pickFile" class="path">{{ pickFile }}</p>
        <template v-if="modelLinks">
          <p class="links-title">手动下载（官方站直链打不开时用镜像链接）：</p>
          <div class="link-row" v-for="(u, i) in [modelLinks.mirror, modelLinks.official]" :key="i">
            <span class="link-txt">{{ u }}</span>
            <button class="btn ghost sm" @click="copyModelLink(u)">复制</button>
          </div>
          <p class="links-note">下载完成后点「导入模型文件」选择该文件（{{ modelLinks.file }}），无需手动挪动目录。</p>
          <p v-if="copyHint" class="progress-text copy-hint">{{ copyHint }}</p>
        </template>
      </div>
      <div class="tips">
        <div class="tips-title"><span class="bulb">💡</span>说明</div>
        <div class="tip">支持 35 种语言互译（Hy-MT2 官方语种）。首次启动引擎约 10 秒，之后毫秒~秒级响应。</div>
        <div class="tip">翻译服务闲置 5 分钟自动睡眠（内存降至 ~60MB），再翻译自动唤醒。</div>
        <div class="tip">7B / 30B-A3B 质量更高但更吃内存（悬停各档位可见内存需求），30B-A3B 建议 16GB 内存以上。</div>
      </div>
    </div>

    <!-- ============ 主界面：输入 / 工具栏（中线）/ 输出，上下完全对称 ============ -->
    <template v-else-if="view==='main'">
      <!-- 输入卡（上半） -->
      <div class="card io-card">
        <div class="text-zone">
          <textarea
            v-model="input" maxlength="5000" spellcheck="false" autofocus
            placeholder="请输入要翻译的内容, 您最多可输入 5000 个字符."
            @keydown.ctrl.enter.prevent="translate" @keydown.ctrl.delete.prevent="clearAll"
          ></textarea>
          <span class="count">{{ input.length }}/5000</span>
        </div>
        <div class="row actions">
          <select class="lang" v-model="srcLang" title="源语言">
            <option value="auto">{{ autoLabel }}</option>
            <option v-for="l in LANGS" :key="l.code" :value="l.code">{{ l.name }}</option>
          </select>
          <button class="btn ghost sm" :disabled="!input" @click="speakInput()">
            <svg viewBox="0 0 24 24" class="ic"><path d="M11 5L6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12"/></svg>朗读
          </button>
          <button class="btn ghost sm" :disabled="!input" @click="copyText(input)">
            <svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制
          </button>
          <span class="spacer"></span>
          <button class="btn ghost sm" :disabled="!input && !result" @click="clearAll">
            <svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>清空内容
          </button>
        </div>
      </div>

      <!-- 工具栏（中线） -->
      <div class="card bar">
        <button class="btn primary sm" :disabled="busy || !input.trim() || (srcLang !== 'auto' && srcLang === tgtLang)" @click="translate">
          <svg viewBox="0 0 24 24" class="ic"><path d="M4 7h13m0 0l-3-3m3 3l-3 3M20 17H7m0 0l3-3m-3 3l3 3"/></svg>{{ busy ? '翻译中...' : '翻译' }}
        </button>
        <button class="btn ghost sm" @click="view='history'">
          <svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>历史记录
        </button>
        <span class="spacer"></span>
        <span class="status" :class="modelFailed ? 'warn' : 'ok'"><i></i>{{ statusText }}</span>
        <button class="btn ghost sm" @click="view='settings'">
          <svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5"/><circle cx="15" cy="17" r="2.5"/></svg>设置
        </button>
      </div>

      <!-- 输出卡（下半，与输入卡同构对称） -->
      <div class="card io-card">
        <div class="text-zone">
          <template v-if="result">
            <div class="result-scroll">
              <div class="result" :class="{err: result.startsWith('翻译失败')}">{{ result }}</div>
            </div>
          </template>
          <div v-else class="placeholder-zone">
            <div class="ph-line">翻译结果将显示在这里</div>
            <div class="ph-sub">【Ctrl + Enter】翻译　【Ctrl + Delete】清空　译文自动存入历史</div>
          </div>
        </div>
        <div class="row actions">
          <select class="lang" v-model="tgtLang" title="目标语言">
            <option v-for="l in LANGS" :key="l.code" :value="l.code">{{ l.name }}</option>
          </select>
          <button class="btn ghost sm" :disabled="!result || result.startsWith('翻译失败')" @click="speak(result, tgtLang)">
            <svg viewBox="0 0 24 24" class="ic"><path d="M11 5L6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>朗读
          </button>
          <button class="btn ghost sm" :disabled="!result || result.startsWith('翻译失败')" @click="copyText(result)">
            <svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制结果
          </button>
          <span class="spacer"></span>
          <label class="switch-label" @click.prevent="autoCopy = !autoCopy">
            <span class="muted-label">自动复制结果</span>
            <span class="switch" :class="{on: autoCopy}"><i></i></span>
          </label>
        </div>
      </div>
    </template>

    <!-- ============ 二级界面：设置 / 历史记录（与主界面等高，不拉伸窗口） ============ -->
    <template v-else>
      <div class="card full-card overlay-card">
        <div class="overlay-head">
          <button class="btn ghost sm" @click="view='main'">
            <svg viewBox="0 0 24 24" class="ic"><path d="M15 5l-7 7 7 7"/></svg>返回
          </button>
          <span class="panel-title">{{ view==='settings' ? '设置' : '历史记录' }} <span class="muted" v-if="view==='history' && history.length">({{ history.length }})</span></span>
          <span class="spacer"></span>
          <button v-if="view==='history' && history.length" class="btn ghost sm" @click="clearHistory">清空历史</button>
        </div>
        <div class="overlay-body">
          <!-- 历史 -->
          <template v-if="view==='history'">
            <div v-if="!history.length" class="empty">暂无历史记录，翻译后自动保存（最多保留 50 条）</div>
            <div v-else class="hist-list">
              <div v-for="(h, i) in history" :key="h.ts + '-' + i" class="hist-item" @click="restoreHist(h)">
                <div class="hist-texts">
                  <div class="hist-src">{{ h.src }}</div>
                  <div class="hist-dst">{{ h.dst }}</div>
                </div>
                <button class="hist-del" title="删除此条" @click.stop="deleteHist(i)">
                  <svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
                </button>
              </div>
            </div>
          </template>
          <!-- 设置 -->
          <template v-else>
            <div class="set-row">
              <span class="set-label">翻译风格</span>
              <div class="seg">
                <button v-for="s in ['日常','正式','简洁']" :key="s" :class="{on: cfg.style===s}" @click="setStyle(s)">{{ s }}</button>
              </div>
            </div>
            <div class="set-row">
              <span class="set-label">自动复制结果</span>
              <span class="spacer"></span>
              <span class="switch" :class="{on: autoCopy}" @click="autoCopy = !autoCopy"><i></i></span>
            </div>
            <div class="set-row">
              <span class="set-label">术语表</span>
              <span class="muted">每行一条，格式: 术语=译文（对全部语向生效）</span>
            </div>
            <textarea class="terms" v-model="termsText" rows="4" placeholder="AI=人工智能&#10;CPU=处理器" @change="saveTerms"></textarea>
            <div class="set-row model-path">
              <span class="path"><span class="mi-label">{{ activeModelLabel }}</span><br>{{ modelFile }}</span>
              <button class="btn ghost sm" @click="changeModel">更换模型</button>
            </div>
            <div v-if="modelFailed && failReason" class="err-box">
              <p class="err-title">引擎异常</p>
              <p class="err-msg">{{ failReason }}</p>
              <p class="err-hint">完整错误已写入 uTools 用户数据目录 utools-hy-mt2/last-engine-error.txt</p>
            </div>
            <div class="footnote">
              <p>· 源语言默认自动检测：输入即识别，识别为中文时目标自动切英语，其余默认译中文。</p>
              <p>· 首次启动引擎约 10 秒；闲置 5 分钟自动睡眠（内存降至 ~60MB），再翻译自动唤醒约 3 秒。</p>
              <p>· 意大利语/印尼语等无独特字符的语种可能识别为英语，需要时手动固定源语言。</p>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'

const p = window.preload

// 窗口高度：保持 uTools 默认高度（不再 setExpendHeight 抬窗，v0.4.7）。
// 页面 height:100vh 精确填满窗口实际高度（544/560/自定义均可），永不出滚动条

// ---- 语种表（与 translate-server.mjs 的 LANGS 保持同一批 code；name 用于界面与 prompt 中文名）----
const LANGS = [
  { code: 'en', name: '英语', tts: 'en-US' },
  { code: 'zh', name: '中文（简体）', tts: 'zh-CN' },
  { code: 'ja', name: '日语', tts: 'ja-JP' },
  { code: 'ko', name: '韩语', tts: 'ko-KR' },
  { code: 'fr', name: '法语', tts: 'fr-FR' },
  { code: 'de', name: '德语', tts: 'de-DE' },
  { code: 'es', name: '西班牙语', tts: 'es-ES' },
  { code: 'pt', name: '葡萄牙语', tts: 'pt-PT' },
  { code: 'it', name: '意大利语', tts: 'it-IT' },
  { code: 'ru', name: '俄语', tts: 'ru-RU' },
  { code: 'ar', name: '阿拉伯语', tts: 'ar-SA' },
  { code: 'th', name: '泰语', tts: 'th-TH' },
  { code: 'vi', name: '越南语', tts: 'vi-VN' },
  { code: 'id', name: '印尼语', tts: 'id-ID' },
  { code: 'ms', name: '马来语', tts: 'ms-MY' },
  { code: 'tl', name: '菲律宾语', tts: 'fil-PH' },
  { code: 'tr', name: '土耳其语', tts: 'tr-TR' },
  { code: 'hi', name: '印地语', tts: 'hi-IN' },
  { code: 'pl', name: '波兰语', tts: 'pl-PL' },
  { code: 'cs', name: '捷克语', tts: 'cs-CZ' },
  { code: 'nl', name: '荷兰语', tts: 'nl-NL' },
  { code: 'uk', name: '乌克兰语', tts: 'uk-UA' },
  { code: 'fa', name: '波斯语', tts: 'fa-IR' },
  { code: 'he', name: '希伯来语', tts: 'he-IL' },
  { code: 'ur', name: '乌尔都语', tts: 'ur-PK' },
  { code: 'bn', name: '孟加拉语', tts: 'bn-BD' },
  { code: 'ta', name: '泰米尔语', tts: 'ta-IN' },
  { code: 'te', name: '泰卢固语', tts: 'te-IN' },
  { code: 'gu', name: '古吉拉特语', tts: 'gu-IN' },
  { code: 'mr', name: '马拉地语', tts: 'mr-IN' },
  { code: 'kk', name: '哈萨克语', tts: 'kk-KZ' },
  { code: 'mn', name: '蒙古语', tts: 'mn-MN' },
  { code: 'ug', name: '维吾尔语', tts: 'ug-CN' },
  { code: 'bo', name: '藏语', tts: 'bo-CN' },
  { code: 'yue', name: '粤语', tts: 'zh-HK' },
  { code: 'zh-Hant', name: '中文（繁体）', tts: 'zh-TW' },
]
const ttsOf = (code) => (LANGS.find(l => l.code === code) || {}).tts || 'en-US'
const langName = (code) => (LANGS.find(l => l.code === code) || {}).name || code
const isZh = (code) => code === 'zh' || code === 'zh-Hant' || code === 'yue'

// ---- 语言自动检测（启发式，纯前端零依赖）----
// 思路：独特文字系统直接判定 → 汉字简繁区分 → 阿拉伯/西里尔字母按特征字符细分 → 拉丁语种按书写特征猜，无线索默认英语。
// 局限：意大利/荷兰/印尼/马来等无独特字符的拉丁语种会落到英语，需要时手动固定源语言。
function detectLang(text) {
  const t = (text || '').trim()
  if (!t) return 'en'
  const has = (re) => re.test(t)
  const cnt = (re) => (t.match(re) || []).length
  if (cnt(/[\u0f00-\u0fff]/g) > 0) return 'bo'
  if (cnt(/[\u3040-\u30ff]/g) > 0) return 'ja'   // 假名（汉字前判，日文汉字不误判）
  if (cnt(/[\uac00-\ud7af]/g) > 0) return 'ko'
  if (cnt(/[\u0900-\u097f]/g) > 0) return 'hi'
  if (cnt(/[\u0980-\u09ff]/g) > 0) return 'bn'
  if (cnt(/[\u0b80-\u0bff]/g) > 0) return 'ta'
  if (cnt(/[\u0c00-\u0c7f]/g) > 0) return 'te'
  if (cnt(/[\u0a80-\u0aff]/g) > 0) return 'gu'
  if (cnt(/[\u0590-\u05ff]/g) > 0) return 'he'
  if (cnt(/[\u0e00-\u0e7f]/g) > 0) return 'th'
  if (cnt(/[\u4e00-\u9fff]/g) > 0) {
    if (has(/[語譯學國體機術醫點書還進遠動員愛樂萬與專業區歲舉覺聽廳寫頭馬鳥龍車貝見風飛購開關門島灣產豐廣]/)) return 'zh-Hant'
    return 'zh'
  }
  if (cnt(/[\u0600-\u06ff\u0750-\u077f]/g) > 0) {
    if (has(/[\u06af\u0686\u067e\u0698]/)) return 'fa'   // گ چ پ ژ
    if (has(/[\u0679\u0688\u0691\u06ba\u06be\u06d2]/)) return 'ur' // ٹ ڈ ڑ ں ھ ے
    if (has(/[\u06cb\u06d0\u06ad]/)) return 'ug'          // ۋ ې ڭ
    return 'ar'
  }
  if (cnt(/[\u0400-\u04ff]/g) > 0) {
    if (has(/[\u0492\u049a\u04a2\u04b0\u04d8\u04e8]/)) return 'kk' // ҚҒҢҰӘӨ等
    if (has(/[\u0406\u0407\u0404\u0490]/)) return 'uk'             // І Ї Є Ґ
    if (has(/[\u04e8\u04ae]/) && !/\u044b/.test(t)) return 'mn'    // Ө Ү
    return 'ru'
  }
  if (has(/[\u01b0\u01a1\u0111\u1ea0-\u1ef9]/)) return 'vi'
  if (has(/[ąćęłńśźż]/)) return 'pl'
  if (has(/[ěůřč]/)) return 'cs'
  if (has(/[\u0131\u011f\u015f]/)) return 'tr'
  if (has(/[ñ¿¡]/)) return 'es'
  if (has(/[ãõ]/)) return 'pt'
  if (has(/[äöüß]/)) return 'de'
  if (has(/[çéèêàùœ]/)) return 'fr'
  return 'en'
}

const cfg = reactive(Object.assign({ style: '日常', terms: {}, autoCopy: false, srcLang: 'auto', tgtLang: 'zh' }, p.getConfig() || {}))
if (cfg.srcLang === 'en') cfg.srcLang = 'auto' // 旧版默认固定英语，统一升级为自动检测
const modelDir = ref(cfg.modelDir || null)
const modelFile = ref(modelDir.value ? p.getModelFile(modelDir.value, cfg.modelId) : '')
const modelReady = ref(false)
const modelFailed = ref(false)
const downloading = ref(false)
const progressText = ref('')
// 多参数规格（preload MODELS 注册表驱动；cfg.modelId 指定当前档位，缺省回落 1.8B Q4_K_M）
const models = ref([])
const pickId = ref(cfg.modelId || '1.8b-q4')
const modelLinks = ref(null)
const configBack = ref(false) // 设置页「更换模型」进来时显示返回按钮，可不切换原样退出
const importing = ref(false)
const copyHint = ref('')
const statusText = ref('检查模型...')
const failReason = ref('')
// 引擎安装（v0.4.0 外置：包内无引擎，首次使用时按平台引导安装）
const engineReady = ref(false)
const engineData = ref(null)
const engineVersion = ref('')
const engineBusy = ref(false)
const engineStatus = ref('')
const engineError = ref('')
const input = ref('')
const result = ref('')
const busy = ref(false)
const view = ref('main') // main | history | settings（后两者为二级界面，与主界面等高）
const autoCopy = ref(!!cfg.autoCopy)
const srcLang = ref(cfg.srcLang || 'auto')
const tgtLang = ref(cfg.tgtLang || 'zh')
const autoLabel = ref('自动检测')
const history = ref([])
const termsText = ref(Object.keys(cfg.terms || {}).map(k => k + '=' + cfg.terms[k]).join('\n'))

// ---- 历史记录（本地文件 userData/utools-hy-mt2/storage.json，经 preload 读写）----
// ---- 历史记录（本地文件 userData/utools-hy-mt2/storage.json，经 preload 读写）----
function loadHistory() {
  const s = p.readStore()
  const list = s.history || []
  // 兼容旧版字段 {en, zh, t} → {src, dst, ts}
  history.value = list.map(h => ({
    src: h.src || h.en || '', dst: h.dst || h.zh || '',
    srcLang: h.srcLang || 'en', tgtLang: h.tgtLang || 'zh', ts: h.ts || h.t || Date.now(),
  }))
}
function pushHistory(src, dst, srcUsed, tgtUsed) {
  if (!src || !dst) return
  const list = history.value.filter(h => h.src !== src || h.dst !== dst)
  list.unshift({ src, dst, srcLang: srcUsed || 'auto', tgtLang: tgtUsed || tgtLang.value, ts: Date.now() })
  list.length = Math.min(list.length, 50)
  history.value = list
  persistHistory(list)
}
function deleteHist(i) {
  history.value.splice(i, 1)
  persistHistory(history.value)
}
function persistHistory(list) {
  p.writeStore({ history: JSON.parse(JSON.stringify(list)) })
}
function clearHistory() {
  history.value = []
  persistHistory([])
}
function restoreHist(h) {
  input.value = h.src
  result.value = h.dst
  srcLang.value = h.srcLang || srcLang.value
  tgtLang.value = h.tgtLang || tgtLang.value
  view.value = 'main'
}

// ---- 通用操作 ----
const READY_TEXT = '模型就绪'
function flashStatus(text) {
  statusText.value = text
  setTimeout(() => { if (statusText.value === text) statusText.value = READY_TEXT }, 1200)
}
function copyText(t) {
  if (!t) return
  utools.copyText(t)
  flashStatus('已复制 ✓')
}
function speak(text, langCode) {
  if (!text || !window.speechSynthesis) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = ttsOf(langCode)
  u.rate = 1
  window.speechSynthesis.speak(u)
}
function clearAll() {
  input.value = ''
  result.value = ''
  window.speechSynthesis && window.speechSynthesis.cancel()
}

// ---- 翻译 ----
async function translate() {
  const text = input.value.trim()
  if (!text || busy.value) return
  // 自动检测：输入即识别源语言；与目标撞车时按惯例翻转目标（中文源→英语，其他源→中文）
  let srcUsed = srcLang.value
  if (srcUsed === 'auto') {
    srcUsed = detectLang(text)
    autoLabel.value = `自动检测（${langName(srcUsed)}）`
  }
  let tgtUsed = tgtLang.value
  if (srcUsed === tgtUsed) {
    tgtUsed = isZh(srcUsed) ? 'en' : 'zh'
    tgtLang.value = tgtUsed // watch 会持久化
  }
  busy.value = true
  try {
    const settings = { style: cfg.style, terms: cfg.terms, srcLang: srcUsed, tgtLang: tgtUsed, modelPath: modelFile.value }
    const r = await p.translate(text, settings)
    if (input.value.trim()) {
      // 等待期间源内容被清空则丢弃过期译文，不回填不进历史
      result.value = r
      pushHistory(text, r, srcUsed, tgtUsed)
      if (autoCopy.value && r) utools.copyText(r)
    }
  } catch (e) {
    result.value = '翻译失败: ' + e.message
    statusText.value = '翻译失败'
    modelFailed.value = true
  }
  busy.value = false
}

// 输入朗读：自动模式下按实时检测的语言发音
function speakInput() {
  if (!input.value) return
  speak(input.value, srcLang.value === 'auto' ? detectLang(input.value) : srcLang.value)
}

// 自动模式下输入变化实时更新检测标签（300ms 防抖）；删光源内容时译文同步清空、朗读停止
let detectTimer = null
watch(input, (v) => {
  if (!v.trim()) {
    clearTimeout(detectTimer)
    result.value = ''
    if (srcLang.value === 'auto') autoLabel.value = '自动检测'
    window.speechSynthesis && window.speechSynthesis.cancel()
    return
  }
  if (srcLang.value !== 'auto') return
  clearTimeout(detectTimer)
  detectTimer = setTimeout(() => {
    autoLabel.value = `自动检测（${langName(detectLang(v))}）`
  }, 300)
})
watch(srcLang, (v) => {
  cfg.srcLang = v
  persistCfg()
  if (v === 'auto' && input.value.trim()) autoLabel.value = `自动检测（${langName(detectLang(input.value))}）`
})

// ---- 设置 ----
function persistCfg() { p.saveConfig(cfg) }
function setStyle(s) { cfg.style = s; persistCfg() }
function saveTerms() {
  cfg.terms = {}
  termsText.value.split(/\n|,|，/).forEach(pair => {
    const [k, v] = pair.split('=')
    if (k && v && k.trim() && v.trim()) cfg.terms[k.trim()] = v.trim()
  })
  persistCfg()
}
watch(autoCopy, (v) => { cfg.autoCopy = v; persistCfg() })
watch(tgtLang, (v) => { cfg.tgtLang = v; persistCfg() })

// ---- 模型配置（多参数规格：同一目录可共存多个 GGUF，激活哪个由 cfg.modelId 决定）----
const picked = computed(() => models.value.find((m) => m.id === pickId.value))
const pickFile = computed(() => (modelDir.value && pickId.value) ? p.getModelFile(modelDir.value, pickId.value) : '')
const activeModelLabel = computed(() => {
  const m = models.value.find((x) => x.id === (cfg.modelId || '1.8b-q4'))
  return m ? m.label : '1.8B · Q4_K_M'
})
function refreshModels() {
  models.value = p.listModels(modelDir.value || '')
  if (!cfg.modelId) { // 老配置升级（无 modelId）：指向第一个已装规格，通常就是原有的 1.8B Q4_K_M
    const inst = models.value.find((m) => m.installed)
    if (inst) pickId.value = inst.id
  }
}
async function checkModel() {
  modelReady.value = !!modelDir.value && p.modelExists(modelDir.value, cfg.modelId)
  if (modelDir.value) modelFile.value = p.getModelFile(modelDir.value, cfg.modelId)
  refreshModels()
}
async function chooseDir() {
  const dir = await p.chooseModelDir()
  if (dir) {
    modelDir.value = dir
    cfg.modelDir = dir
    await p.saveConfig(cfg)
    await checkModel()
    if (modelReady.value) preloadModel()
  }
}
// 进插件即后台预热引擎：用户输入期间模型加载完成，点翻译时无需再等
async function preloadModel() {
  modelFailed.value = false
  const t0 = Date.now()
  statusText.value = '预热中'
  const timer = setInterval(() => { statusText.value = `预热中 ${Math.round((Date.now() - t0) / 1000)}s` }, 500)
  try {
    const r = await p.ensureModel((phase) => { statusText.value = phase })
    clearInterval(timer)
    if (r.ok) { statusText.value = READY_TEXT }
    else { statusText.value = '预热失败'; modelFailed.value = true; failReason.value = r.reason || '未知' }
  } catch (e) {
    clearInterval(timer)
    statusText.value = '预热失败'
    modelFailed.value = true
    failReason.value = e.message
  }
}
async function startDownload() {
  if (downloading.value || !pickId.value) return
  // 所选规格已装好 → 直接启用，无需下载
  if (picked.value && picked.value.installed) return activateModel(pickId.value)
  if (!modelDir.value) {
    // 与引擎一致：按钮随时可点；未选模型目录则先弹目录选择，选中后再开浏览器
    const dir = await p.chooseModelDir()
    if (!dir) return
    modelDir.value = dir
    cfg.modelDir = dir
    await p.saveConfig(cfg)
    refreshModels()
  }
  cfg.modelId = pickId.value // 记住正在下载的规格：重进插件时 checkModel 检查的就是它
  await p.saveConfig(cfg)
  downloading.value = true
  try {
    const r = await p.openModelDownload(pickId.value) // 系统浏览器下载（hf-mirror 直链）
    modelLinks.value = p.modelLinks(pickId.value)
    progressText.value = '已在系统浏览器打开下载（' + (r.size || '') + '）。下载完成后点「导入模型文件」选择该文件，或重新进入插件自动识别'
  } catch (e) {
    alert('无法打开浏览器: ' + e.message)
  }
  downloading.value = false
}
// 激活所选规格（已装才可进）：切规格时停掉旧服务，新规格由预热按需拉起
async function activateModel(id) {
  const switching = !!cfg.modelId && cfg.modelId !== id
  pickId.value = id
  cfg.modelId = id
  await p.saveConfig(cfg)
  modelLinks.value = null
  if (!modelDir.value || !p.modelExists(modelDir.value, id)) return
  modelFile.value = p.getModelFile(modelDir.value, id)
  modelReady.value = true
  view.value = 'main'
  configBack.value = false
  loadHistory()
  if (switching) p.stopServer()
  preloadModel()
}
// 手动导入：浏览器下载通常落在"下载"目录，选文件后由 preload 拷入模型目录并激活
async function importModel() {
  if (importing.value) return
  if (!modelDir.value) {
    const dir = await p.chooseModelDir()
    if (!dir) return
    modelDir.value = dir
    cfg.modelDir = dir
    await p.saveConfig(cfg)
    refreshModels()
  }
  const f = await p.chooseModelFile()
  if (!f) return
  importing.value = true
  try {
    const r = p.importModelFile(f, modelDir.value)
    await activateModel(r.id)
  } catch (e) {
    alert('导入失败: ' + e.message)
  }
  importing.value = false
}
function changeModel() {
  // 不清 modelDir 也不停服务：列表里可秒切已装规格，点「返回」原样恢复
  configBack.value = true
  modelReady.value = false
  refreshModels()
}
function backToMain() {
  modelReady.value = p.modelExists(modelDir.value, cfg.modelId)
  view.value = 'settings' // 从设置页进入的，返回后仍回设置页
}
function copyModelLink(u) {
  utools.copyText(u)
  copyHint.value = '链接已复制 ✓'
  setTimeout(() => { if (copyHint.value === '链接已复制 ✓') copyHint.value = '' }, 1500)
}

// ---- 引擎安装（进入插件第一步：引擎就绪后才进入模型配置/主界面）----
function initFlow() {
  const info = p.engineInfo()
  engineData.value = info
  engineVersion.value = info.version || ''
  engineReady.value = info.installed
  if (!info.installed) return // 停在引擎安装卡
  checkModel().then(() => {
    if (modelReady.value) {
      loadHistory()
      preloadModel() // 进插件即预热；服务常驻复用时这里毫秒级返回
    }
  })
}
async function installEngine() {
  engineError.value = ''
  try {
    const r = await p.openEngineDownload()
    engineStatus.value = '已调用系统浏览器打开下载页（' + (r.size || '') + '）。浏览器下载完成后点「导入安装包」选择该文件；官方链接打不开时，复制下方镜像链接到浏览器'
  } catch (e) {
    engineError.value = e.message
  }
}
async function importEngine() {
  engineBusy.value = true
  engineError.value = ''
  const f = await p.chooseEngineFile()
  if (!f) { engineBusy.value = false; return }
  engineStatus.value = '解析安装包...'
  try {
    await p.installEngineFromFile(f, (phase) => { engineStatus.value = phase })
    engineReady.value = true
    initFlow()
  } catch (e) {
    engineError.value = e.message
  }
  engineBusy.value = false
}
function copyLink(u) {
  utools.copyText(u)
  engineStatus.value = '链接已复制 ✓'
  setTimeout(() => {
    if (engineStatus.value === '链接已复制 ✓') engineStatus.value = ''
  }, 1500)
}

initFlow()

// 文字匹配（over）入口：选中文字呼出 uTools 进入插件 → 自动回填并翻译。
// 坑（v0.3.6 遗留，v0.4.4 修，v0.4.9 扩展到运行时派生）：uTools 把关键字输入也塞进 payload——
// 输入"翻译"+Enter 时 payload 就是"翻译"二字，会被当成待翻译文本回填。
// 规则：payload 等于任一进入关键字（来自 plugin.json cmds，preload 派生）一律视为"进入插件"而非
// "翻译文本"，清空处理；其余非空文本（选中文字/关键字后剩余文本）才回填翻译。
// uTools 后台保留页面（webview 不销毁），重进必须重置，否则残留上次的输入/译文
const ENTRY_KEYWORDS = new Set((p.entryKeywords && p.entryKeywords()) || ['翻译', 'fy'])
try {
  utools.onPluginEnter(({ code, payload }) => {
    view.value = 'main'
    let text = ''
    if (code === 'translate' && typeof payload === 'string') text = payload.trim()
    if (text && !ENTRY_KEYWORDS.has(text)) {
      result.value = ''
      input.value = text
      if (modelReady.value) translate()
    } else {
      clearAll()
    }
  })
} catch {}
</script>

<style>
:root { --blue: #4a6bfb; --blue-d: #3f5ef0; --ink: #1f2329; --sub: #6b7280; --faint: #9ca3af; --line: #e4e7ed; --soft: #f5f6f8; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  background: #f4f4f4;
  color: var(--ink);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  height: 100%;
  overflow: hidden;
}
/* 跟随 uTools 主题（暗色时 prefers-color-scheme: dark 生效） */
@media (prefers-color-scheme: dark) {
  body { background: #303133; }
}
/* 高度自适应：填满 uTools 窗口实际高度（默认 544/560），切视图高度不变故窗口不拉伸 */
.container { padding: 16px; max-width: 800px; margin: 0 auto; height: 100vh; min-height: 460px; display: flex; flex-direction: column; gap: 12px; }
.card {
  background: #fff; border-radius: 10px; padding: 14px 16px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
}
.full-card { flex: 1; min-height: 0; }

/* ---- 按钮体系 ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 34px; padding: 0 14px;
  border: none; border-radius: 6px; cursor: pointer;
  font-size: 13px; font-family: inherit; line-height: 1; white-space: nowrap;
  transition: background .15s, border-color .15s, color .15s;
}
.btn.sm { height: 30px; padding: 0 12px; font-size: 12.5px; }
.btn .ic { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.btn.primary { background: var(--blue); color: #fff; font-weight: 500; }
.btn.primary:hover:not(:disabled) { background: var(--blue-d); }
.btn.primary:disabled { background: #b9c6fd; cursor: not-allowed; }
.btn.ghost { background: #fff; border: 1px solid var(--line); color: #4e5969; }
.btn.ghost:hover:not(:disabled) { border-color: #c6cbd4; background: #fafbfc; }
.btn.ghost:disabled { background: var(--soft); border-color: var(--soft); color: #c0c4cc; cursor: not-allowed; }
.row { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }

/* ---- 对称双卡（输入/输出同构） ---- */
.io-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.text-zone {
  flex: 1; min-height: 0; position: relative;
  border: 1px solid var(--line); border-radius: 8px; background: #fff;
  transition: border-color .15s, box-shadow .15s; overflow: hidden;
}
.text-zone:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(74, 107, 251, .1); }
.text-zone textarea {
  width: 100%; height: 100%; display: block; resize: none; border: none; background: transparent;
  padding: 12px 14px 30px; font-size: 14px; line-height: 1.75;
  font-family: inherit; color: var(--ink);
}
.text-zone textarea::placeholder { color: #a8abb2; }
.text-zone textarea:focus { outline: none; }
.count { position: absolute; right: 12px; bottom: 10px; font-size: 12px; color: #a8abb2; pointer-events: none; }
.actions { margin-top: 10px; flex: none; }

/* 输出区与输入区同构 */
.result-scroll { height: 100%; overflow-y: auto; padding: 12px 14px; }
.result { font-size: 14.5px; line-height: 1.9; white-space: pre-wrap; word-break: break-word; }
.result.err { color: #e64545; }
.placeholder-zone { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.ph-line { font-size: 13.5px; color: var(--faint); }
.ph-sub { font-size: 12px; color: #c0c4cc; }

/* ---- 工具栏（中线） ---- */
.bar { flex: none; height: 48px; padding-top: 0; padding-bottom: 0; display: flex; align-items: center; gap: 10px; }
.status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sub); white-space: nowrap; }
.status i { width: 7px; height: 7px; border-radius: 50%; background: #22a35f; flex: none; }
.status.warn i { background: #e6772e; }

/* ---- 语言选择器（卡片底栏左侧，对称镜像） ---- */
.lang {
  appearance: none; -webkit-appearance: none;
  height: 30px; padding: 0 26px 0 12px; max-width: 130px;
  border: 1px solid var(--line); border-radius: 6px; background-color: #fff;
  font-size: 12.5px; font-family: inherit; color: #4e5969; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  transition: border-color .15s;
}
.lang:hover { border-color: #c6cbd4; }
.lang:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(74, 107, 251, .1); }

/* ---- 二级界面（设置/历史）：与主界面等高，内部滚动 ---- */
.overlay-card { display: flex; flex-direction: column; }
.overlay-head { display: flex; align-items: center; gap: 12px; flex: none; }
.overlay-body { flex: 1; min-height: 0; overflow-y: auto; margin-top: 12px; }
.panel-title { font-weight: 600; font-size: 14px; }
.muted { color: var(--faint); font-weight: 400; font-size: 12px; }
.empty { padding: 40px 0; text-align: center; font-size: 13px; color: var(--faint); background: var(--soft); border-radius: 8px; }
.hist-list { display: flex; flex-direction: column; }
.hist-item { display: flex; align-items: center; gap: 10px; padding: 12px 6px; border-bottom: 1px solid #f0f2f5; cursor: pointer; transition: background .12s; }
.hist-item:last-child { border-bottom: none; }
.hist-item:hover { background: #fafbfc; }
.hist-texts { flex: 1; min-width: 0; }
.hist-src { font-size: 12.5px; color: var(--faint); margin-bottom: 4px; word-break: break-all; line-height: 1.5; }
.hist-dst { font-size: 13.5px; line-height: 1.6; word-break: break-all; }
.hist-del {
  flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px; background: transparent; color: #c0c4cc; cursor: pointer;
  opacity: 0; transition: opacity .12s, background .12s, color .12s;
}
.hist-item:hover .hist-del { opacity: 1; }
.hist-del:hover { background: #fdecec; color: #e64545; }
.hist-del .ic { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }

/* ---- 设置 ---- */
.set-row { display: flex; align-items: center; min-height: 46px; gap: 16px; }
.set-label { font-size: 13.5px; flex: none; width: 110px; }
.seg { display: inline-flex; background: var(--soft); border-radius: 6px; padding: 3px; }
.seg button {
  border: none; background: transparent; color: var(--sub);
  height: 28px; padding: 0 18px; border-radius: 4px; cursor: pointer;
  font-size: 13px; font-family: inherit; transition: all .15s;
}
.seg button.on { background: #fff; color: var(--blue); font-weight: 600; box-shadow: 0 1px 2px rgba(16,24,40,.08); }
.terms {
  width: 100%; min-height: 90px; border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 14px; font-size: 13px; line-height: 1.8; resize: none; display: block;
  font-family: inherit; color: var(--ink);
}
.terms:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(74,107,251,.1); }
.model-path { border-top: 1px solid #f0f2f5; margin-top: 6px; padding-top: 12px; min-height: 0; }
.path { font-size: 12px; color: var(--faint); word-break: break-all; line-height: 1.6; flex: 1; margin-right: 12px; }
.footnote { margin-top: 12px; padding-top: 10px; border-top: 1px solid #f0f2f5; }
.footnote p { font-size: 12px; color: var(--faint); line-height: 2; }
.err-box { margin-top: 12px; padding: 10px 14px; background: #fdf0f0; border: 1px solid #f5c2c2; border-radius: 8px; }
.err-title { font-size: 12.5px; font-weight: 600; color: #d23f3f; margin-bottom: 4px; }
.err-msg { font-size: 12px; color: #a33; line-height: 1.7; word-break: break-all; white-space: pre-wrap; }
.err-hint { font-size: 11.5px; color: var(--faint); margin-top: 6px; }

/* ---- 开关 ---- */
.switch-label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.muted-label { font-size: 12.5px; color: var(--sub); }
.switch { position: relative; display: inline-block; width: 38px; height: 21px; flex: none; cursor: pointer; }
.switch i {
  position: absolute; inset: 0; background: #e4e7ed; border: 1px solid #dcdfe6;
  border-radius: 21px; transition: all .2s; box-sizing: border-box;
}
.switch i::after {
  content: ''; position: absolute; left: 2px; top: 2px;
  width: 15px; height: 15px; background: #fff; border-radius: 50%;
  transition: transform .2s; box-shadow: 0 1px 2px rgba(0,0,0,.15);
}
.switch.on i { background: var(--blue); border-color: var(--blue); }
.switch.on i::after { transform: translateX(17px); }

/* ---- 首次配置 ---- */
.cfg { min-height: 0; overflow-y: auto; } /* 下载后追加链接区等内容超高时卡内滚动，不溢出 */
.cfg h3 { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.desc { font-size: 13px; color: var(--sub); margin-bottom: 14px; }
.cfg-actions { display: flex; gap: 10px; }
.progress { margin-top: 14px; }
.progress-bar { height: 6px; background: #eef0f4; border-radius: 3px; overflow: hidden; }
.fill { height: 100%; background: var(--blue); border-radius: 3px; transition: width .2s; }
.progress-text { display: block; margin-top: 6px; font-size: 12px; color: var(--faint); }
.cfg .path { display: block; margin-top: 12px; font-size: 12px; color: var(--faint); word-break: break-all; }

/* ---- 模型规格选择（配置卡） ---- */
.cfg-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.model-list { margin: 4px 0 14px; display: flex; flex-direction: column; gap: 6px; max-height: 224px; overflow-y: auto; }
.model-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; transition: border-color .15s, background .15s; flex: none; }
.model-item:hover { border-color: #c6cbd4; background: #fafbfc; }
.model-item.on { border-color: var(--blue); background: #f5f7ff; }
.mi-radio { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid #c0c4cc; flex: none; position: relative; }
.model-item.on .mi-radio { border-color: var(--blue); }
.model-item.on .mi-radio::after { content: ''; position: absolute; inset: 2.5px; border-radius: 50%; background: var(--blue); }
.mi-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mi-name { font-size: 13.5px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.mi-meta { font-size: 12px; color: var(--faint); }
.mi-badge { font-size: 11px; font-weight: 400; color: var(--sub); background: var(--soft); border-radius: 4px; padding: 1px 6px; flex: none; }
.mi-badge.ok { color: #1f7a4d; background: #e8f5ee; }
.mi-label { font-size: 13px; color: var(--ink); font-weight: 600; }

/* ---- 引擎安装卡（v0.4.0：手动下载链接 + 镜像） ---- */
.links-title { margin-top: 14px; font-size: 12.5px; color: var(--sub); }
.copy-hint { margin-top: 10px; }
.link-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.link-txt {
  flex: 1; min-width: 0;
  font-size: 11.5px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; /* 链接单行显示，超出省略号 */
  line-height: 1.8;
}
.links-note { margin-top: 10px; font-size: 12px; color: var(--faint); line-height: 1.8; }
.full-card { display: flex; flex-direction: column; justify-content: center; }
.full-card.overlay-card { justify-content: flex-start; }
.tips { background: var(--soft); border-radius: 8px; padding: 14px 20px; margin-top: 16px; }
.tips-title { display: flex; align-items: center; gap: 6px; color: var(--blue); font-weight: 600; margin-bottom: 8px; font-size: 13.5px; }
.bulb { font-size: 14px; }
.tip { font-size: 13px; color: var(--sub); line-height: 2; }

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-thumb { background: #d4d7de; border-radius: 4px; }
::-webkit-scrollbar-track { background: transparent; }
</style>
