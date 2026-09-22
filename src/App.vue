<template>
  <div class="container">
    <!-- 引擎安装（v0.4.0 外置：插件包不内置引擎，三端首次使用单独安装一次） -->
    <div v-if="!engineReady" class="card full-card">
      <div class="cfg">
        <template v-if="engineData && engineData.target">
          <h3>首次使用需安装推理引擎（{{ engineData.target.label }}，{{ engineData.target.size }}）</h3>
          <p class="desc">引擎是本地翻译运行的核心，与模型一样只需安装一次；插件包因此不含引擎，可做到 KB 级体积，Win/Mac/Linux 三端通用。</p>
          <!-- 主流程只留「下载引擎」；导入是下载失败时的兜底，收在下方折叠区里 -->
          <div class="cfg-actions">
            <button class="btn primary" :disabled="engineBusy" @click="installEngine">下载引擎</button>
          </div>
          <div v-if="engineBusy" class="progress">
            <div class="progress-bar"><div class="fill" :style="{width: engineDlPercent + '%'}"></div></div>
            <div class="progress-row">
              <span class="progress-text">{{ engineDlText }}</span>
              <button class="btn ghost sm" @click="cancelEngineDownload">取消</button>
            </div>
          </div>
          <p v-else-if="engineStatus" class="progress-text copy-hint">{{ engineStatus }}</p>
          <div v-if="engineError" class="err-box">
            <p class="err-title">引擎安装失败</p>
            <p class="err-msg">{{ engineError }}</p>
            <p class="err-hint">可直接重试（进度已保留、自动续传）；仍失败时展开下方链接用浏览器下载，再点「导入安装包」。完整错误见 uTools 用户数据目录 utools-hy-mt2/last-engine-error.txt</p>
          </div>
          <button class="links-toggle" @click="showEngineLinks = !showEngineLinks">
            {{ showEngineLinks ? '▾' : '▸' }} 应用内下载失败？用浏览器下载这些链接，完成后点「导入安装包」
          </button>
          <template v-if="showEngineLinks">
            <div class="link-row" v-for="(r, i) in engineData.mirrors" :key="i">
              <span class="link-label">{{ r.label }}</span>
              <span class="link-txt" :title="r.url">{{ r.url }}</span>
              <button class="btn ghost sm" @click="copyLink(r.url)">复制</button>
            </div>
            <p class="links-note">下载后点下方按钮选该文件（.zip / .tar.gz）即可，无需手动解压。</p>
            <button class="btn ghost sm" :disabled="engineBusy" @click="importEngine">导入安装包</button>
          </template>
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
      <!-- 标题栏固定在滚动区外：展开长链接列表时「返回」始终可点 -->
      <div class="cfg-head">
        <h3>选择翻译模型</h3>
        <button v-if="canBack" class="btn ghost sm" @click="backToMain">
          <svg viewBox="0 0 24 24" class="ic"><path d="M15 5l-7 7 7 7"/></svg>返回
        </button>
      </div>
      <div class="cfg cfg-model">
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
          <button class="btn primary" :disabled="downloading || !pickId" @click="startDownload">
            {{ picked && picked.installed ? '启用所选模型' : '下载所选模型' }}
          </button>
          <span v-if="pickFile" class="path" :title="pickFile">{{ pickFile }}</span>
        </div>
        <div v-if="downloading" class="progress">
          <div class="progress-bar"><div class="fill" :style="{width: dlPercent + '%'}"></div></div>
          <div class="progress-row">
            <span class="progress-text">{{ dlText }}</span>
            <button class="btn ghost sm" @click="cancelDownload">取消</button>
          </div>
        </div>
        <p v-else-if="progressText" class="progress-text">{{ progressText }}</p>
        <template v-if="modelLinks">
          <button class="links-toggle" @click="showModelLinks = !showModelLinks">
            {{ showModelLinks ? '▾' : '▸' }} 应用内下载失败？用浏览器下载这些链接，完成后点「导入模型文件」
          </button>
          <template v-if="showModelLinks">
            <div class="link-row" v-for="(r, i) in modelLinks.rows" :key="i">
              <span class="link-label">{{ r.label }}</span>
              <span class="link-txt" :title="r.url">{{ r.url }}</span>
              <button class="btn ghost sm" @click="copyModelLink(r.url)">复制</button>
            </div>
            <p class="links-note">下载完成后点下方按钮选该文件（{{ modelLinks.file }}），无需手动挪动目录。</p>
            <button class="btn ghost sm" :disabled="importing" @click="importModel">导入模型文件</button>
            <p v-if="copyHint" class="progress-text copy-hint">{{ copyHint }}</p>
          </template>
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
          <select class="lang" v-model="srcLang" title="源语言" @change="onLangChange('src')">
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
          <select class="lang" v-model="tgtLang" title="目标语言" @change="onLangChange('tgt')">
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
            <!-- 术语词典：标题行与行业包按钮合并成一行，节省垂直空间（设置页要一屏放下不出滚动条） -->
            <div class="term-head">
              <span class="set-label">术语词典</span>
              <span class="muted">每行一条 术语=译文</span>
              <span class="spacer"></span>
              <button
                v-for="pk in TERM_PACKS" :key="pk.id"
                class="btn ghost sm" :class="{ on: packActive(pk.id) }"
                :title="pk.name + '：' + packCount(pk) + ' 条术语，点一下' + (packActive(pk.id) ? '取消' : '添加')"
                @click="togglePack(pk)"
              >{{ pk.name }}</button>
            </div>
            <textarea class="terms" v-model="termsText" rows="3" placeholder="AI=人工智能&#10;CPU=处理器" @change="saveTerms"></textarea>
            <div class="set-row model-path">
              <span class="path"><span class="mi-label">{{ activeModelLabel }}</span><br>{{ modelFile }}</span>
              <button class="btn ghost sm" @click="changeModel">更换模型</button>
            </div>

            <!-- 语音朗读（本地 TTS）：一键启用 = 运行时 + 中英两个轻量语音包全自动装好；未装则回退系统 TTS -->
            <div class="set-row voice-head">
              <span class="set-label">朗读语音</span>
              <span class="muted">中文华燕 · 英语 Amy，本地合成，全程应用内下载</span>
              <span class="spacer"></span>
              <!-- 旧包不再占一整行，收到这里；具体是哪些包放 title 里，鼠标悬停可见 -->
              <button v-if="legacyVoices.length" class="btn ghost sm" :disabled="!!voiceBusy"
                :title="'清理：' + legacyVoices.map(v => v.id).join('、')" @click="purgeLegacy"
              >清理旧语音包</button>
              <button v-if="!voicesAllReady" class="btn sm" :disabled="!!voiceBusy" @click="enableTts">{{ voiceBusy ? '启用中...' : '一键启用' }}</button>
            </div>
            <div v-if="voiceBusy || voiceDl" class="progress">
              <div class="progress-bar"><div class="fill" :style="{ width: voicePercent + '%' }"></div></div>
              <span class="progress-text">{{ voiceStatus }}</span>
            </div>
            <!-- 每个语言一行：系统 / 已装音色 二选一，右侧是下载·试听·删除 -->
            <div v-for="lang in ['zh','en']" :key="lang" class="set-row voice-row">
              <span class="voice-lang">{{ voiceLangLabel(lang) }}</span>
              <div class="seg">
                <button :class="{on: !voicePackMap[lang]}" @click="setVoiceFor(lang, '')">系统</button>
                <button
                  v-for="v in voiceOf(lang)" :key="v.id"
                  :disabled="!v.installed" :title="v.installed ? '' : '未安装，点右侧下载'"
                  :class="{on: voicePackMap[lang] === v.id}"
                  @click="setVoiceFor(lang, v.id)"
                >{{ v.label.split('·')[1]?.trim() || v.label }}</button>
              </div>
              <span class="spacer"></span>
              <template v-if="voiceOf(lang).length">
                <button v-if="!voiceOf(lang).some(v => v.installed)" class="btn ghost sm"
                  :disabled="!!voiceBusy" @click="downloadVoice(voiceOf(lang)[0].id)"
                >下载（{{ voiceOf(lang)[0].size }}）</button>
                <template v-else>
                  <button class="btn ghost sm" :disabled="!!voiceBusy || previewBusy === lang" @click="previewVoice(lang)">{{ previewBusy === lang ? '合成中...' : '试听' }}</button>
                  <button class="btn ghost sm" :disabled="!!voiceBusy" @click="removeVoice(voiceOf(lang).find(v => v.installed).id)">删除</button>
                </template>
              </template>
            </div>
            <p v-if="voiceStatus && !voiceBusy && !voiceDl" class="voice-hint">{{ voiceStatus }}</p>
            <div v-if="voiceError" class="err-box">
              <p class="err-title">语音包操作失败</p>
              <p class="err-msg">{{ voiceError }}</p>
              <div class="err-actions">
                <button class="btn ghost sm" @click="copyTtsLog">复制详细日志</button>
                <span class="err-hint">把日志发我即可定位问题</span>
              </div>
            </div>

            <div v-if="modelFailed && failReason" class="err-box">
              <p class="err-title">引擎异常</p>
              <p class="err-msg">{{ failReason }}</p>
              <p class="err-hint">完整错误已写入 uTools 用户数据目录 utools-hy-mt2/last-engine-error.txt</p>
            </div>
            <div class="footnote">
              <p>· 源语言默认自动检测（识别为中文时目标自动切英语）；无独特字符的语种可能识别为英语，可手动固定。</p>
              <p>· 引擎首次启动约 10 秒；闲置 5 分钟自动睡眠（内存降至 ~60MB），再翻译自动唤醒约 3 秒。</p>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { TERM_PACKS } from './term-packs.js'

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
// 语种检测：按 Unicode 字符范围判断，零依赖零延迟。
// 已知取舍：拉丁语系（英/法/德/西/葡/意…）共用一套字母，这里一律落到 'en'。
//
// 别再试着让本地 Hy-MT2 来判断语种（2026-09 实测过）：它是翻译指令微调的模型，
// 问答姿势完全不认 —— 试了 4 种问法（含官方文档那种 "# 任务目标" 句式），最好也只有
// 4/8，多数情况它直接动手翻译正文。而且翻译本身用不到源语言（发给模型的 prompt 只带
// 目标语言，源语言由模型自己判断），检测结果只影响界面显示的语言名，不值得为它加
// 0.6 秒延迟。真要提升准确率，上专门的检测库（ELD / franc），别绕回模型这条路。
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
    // 繁体特征字：出现任意一个就能断定是繁体（这些字的简体写法不同）。
    // 表要尽量全 —— 漏一个字的代价就是把繁体误判成简体（2026-09 实测「今天天氣不錯」就栽了，
    // 「氣」「錯」当时都不在表里）。按日常高频差异字铺开，宁多勿少。
    if (has(/[們這來個說國會對時過學點電見車門馬鳥氣錯問題間關話語請謝東樂書買賣頭發體醫術華漢龍風飛義議讓認識與專業區歲舉覺聽廳寫灣產豐廣機萬愛員動進遠還經給統紅級約結絕綠線練組終億價僅從眾優幣師幫帶張開陽隊際陸陳險隨難雲響頁預領顧顯飯餓館駕騎驗鬥魚鮮鳴麗黃黨齊齒龜]/)) return 'zh-Hant'
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
const dlPercent = ref(0) // 应用内下载进度（进度条百分比）
const dlText = ref('') // 应用内下载进度文本（已下/总量 · 速度）
// 多参数规格（preload MODELS 注册表驱动；cfg.modelId 指定当前档位，缺省回落 1.8B Q4_K_M）
const models = ref([])
const pickId = ref(cfg.modelId || '1.8b-q4')
const modelLinks = ref(null)
const configBack = ref(false) // 从设置页「更换模型」进来：返回时回设置页（否则回主界面）
const prevModelId = ref('') // 进入模型配置前的规格，返回时优先恢复
// 可回退目标：优先上次用的规格，其次列表里任一已装规格；一个都没有（真·首次使用）时不给返回按钮
const fallbackModelId = computed(() => {
  if (prevModelId.value && p.modelExists(modelDir.value, prevModelId.value)) return prevModelId.value
  const inst = models.value.find((m) => m.installed)
  return inst ? inst.id : ''
})
const canBack = computed(() => !!fallbackModelId.value)
const importing = ref(false)
const copyHint = ref('')
const showModelLinks = ref(false) // 手动链接默认折叠：展开时会把配置卡撑出滚动条
const showEngineLinks = ref(false)
const statusText = ref('检查模型...')
const failReason = ref('')
// 引擎安装（v0.4.0 外置：包内无引擎，首次使用时按平台引导安装）
const engineReady = ref(false)
const engineData = ref(null)
const engineVersion = ref('')
const engineBusy = ref(false)
const engineStatus = ref('')
const engineError = ref('')
const engineDlPercent = ref(0) // 引擎应用内下载进度
const engineDlText = ref('')
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

// ---- 语音包（本地 TTS 朗读；按语言选用，未装则回退系统 TTS）----
const voiceList = ref([])
const voicePackMap = ref(Object.assign({ en: '', zh: '' }, cfg.voicePackMap || {})) // 语言 → 语音包 id
const legacyVoices = ref([])     // 旧版本遗留的语音包目录（Kokoro/Matcha 等），等用户点清理
const voiceBusy = ref('')        // 正在安装/卸载的语音包 id；非空即"忙碌中"
const voiceDl = ref(false)       // 语音包下载进行中（决定进度条显示）
const voicePercent = ref(0)      // 下载百分比，来自 preload 上报的字节数
const previewBusy = ref('')      // 正在试听的语言
const voiceStatus = ref('')
const voiceError = ref('')

// 校验历史配置：两种情况都要清掉引用 —— 包已不在注册表（换代移除），或包还在但本地没装
// （换代后还没重下）。留着的话朗读会静默退回系统 TTS，界面上却仍高亮着那个音色，
// 用户只会觉得"朗读坏了"，而且找不到原因
function migrateVoiceCfg() {
  const next = {}
  let changed = false
  for (const lang of ['zh', 'en']) {
    const id = voicePackMap.value[lang]
    if (id && !voiceList.value.some(v => v.id === id && v.installed)) { next[lang] = ''; changed = true }
  }
  if (changed) {
    voicePackMap.value = Object.assign({}, voicePackMap.value, next)
    cfg.voicePackMap = Object.assign({}, voicePackMap.value)
    persistCfg()
  }
  delete cfg.kokoroSid // Kokoro 已移除，这个字段没用了
}

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
// ---- 朗读：本地语音包流式播放（边合成边出声），未安装/失败回退系统 TTS ----
// 语音包按语言匹配：装了英语包就朗读英语、装了中文包就朗读中文（两个包都是单说话人）
function localVoiceFor(langCode) {
  if (!langCode) return null
  const packId = voicePackMap.value[langCode]
  if (!packId) return null
  const v = voiceList.value.find(x => x.id === packId)
  if (!v || !v.installed) return null
  return { v, sid: 0, ref: v.id }
}

// 播放走 Web Audio 而不是 <audio>：分段到达的音频要首尾相接不留缝，
// <audio> 每段都得重新加载解码，段间必然有间隙；Web Audio 能把每段排在前一段的
// 结束时刻上（采样级对齐），听感是一条连续的话，而不是一顿一顿的拼接。
let audioCtx = null
let speakGain = null
let playCursor = 0        // 下一段该排到的时刻（AudioContext 时间轴）
let activeNodes = []
let speakSession = 0      // 每次朗读自增；异步回调靠它判断自己是否已过期
let currentStream = null

function stopSpeaking() {
  speakSession++
  if (currentStream) { try { currentStream.cancel() } catch (e) {} ; currentStream = null }
  for (const n of activeNodes) { try { n.stop() } catch (e) {} }
  activeNodes = []
  playCursor = 0
  window.speechSynthesis && window.speechSynthesis.cancel()
}

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    audioCtx = new AC()
    speakGain = audioCtx.createGain()
    speakGain.connect(audioCtx.destination)
  }
  return audioCtx
}

// base64(16bit PCM) → Float32，按到达顺序排进播放队列
function enqueuePcm(b64, sampleRate) {
  const ctx = ensureAudio()
  if (!ctx) return
  const bin = atob(b64)
  const n = bin.length >> 1
  const f32 = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2)
    if (v & 0x8000) v -= 0x10000        // 16bit 补码 → 有符号
    f32[i] = v / 32768
  }
  const buf = ctx.createBuffer(1, n, sampleRate || 22050)
  buf.copyToChannel(f32, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(speakGain)
  // 首段留 60ms 调度余量（排到 past 会被直接丢弃）；其后紧贴上一段结尾
  const at = Math.max(ctx.currentTime + 0.06, playCursor)
  src.start(at)
  playCursor = at + buf.duration
  activeNodes.push(src)
  src.onended = () => { activeNodes = activeNodes.filter(x => x !== src) }
}

// base64(WAV) → 掐掉 44 字节标准头后按 PCM 入队（试听用；流式朗读不走这里）
function enqueueWav(b64, sampleRate) {
  const bin = atob(b64)
  enqueuePcm(btoa(bin.slice(44)), sampleRate)
}

function speakSystem(text, langCode) {
  if (!window.speechSynthesis) return
  const u = new SpeechSynthesisUtterance(text)
  u.lang = ttsOf(langCode)
  u.rate = 1
  window.speechSynthesis.speak(u)
}

async function speak(text, langCode) {
  if (!text) return
  stopSpeaking()
  const session = speakSession
  const v = localVoiceFor(langCode)
  if (v && p.ttsSpeakStream && ensureAudio()) {
    try { if (audioCtx.state === 'suspended') await audioCtx.resume() } catch (e) {}
    let got = false
    statusText.value = '合成中...'
    currentStream = p.ttsSpeakStream(text, v.ref, {
      onChunk(m) {
        if (session !== speakSession) return
        if (!got) { got = true; statusText.value = '朗读中...' }
        enqueuePcm(m.pcm, m.sr)
      },
      onDone() { if (session !== speakSession) return; statusText.value = READY_TEXT },
      onError() {
        if (session !== speakSession) return
        currentStream = null
        // 已经出过声就不再回退系统朗读，否则会从头再念一遍
        if (!got) { flashStatus('本地语音不可用，已用系统朗读'); speakSystem(text, langCode) }
        else statusText.value = READY_TEXT
      },
    })
    return
  }
  speakSystem(text, langCode)
}
function clearAll() {
  input.value = ''
  result.value = ''
  stopSpeaking()
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
    stopSpeaking()
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

// 源与目标撞车时自动翻转对端 —— 翻译成同一种语言没有意义。
// 只处理"改动的那一侧"触发的撞车：源选自动检测时不算撞车（真实语种要等翻译时才识别出来）。
// 翻转规则与 translate() 里那段保持一致：中文 ↔ 英语，其余 → 中文，
// 这样非中英语种撞车时也有个确定去向，不会出现两边都留在同一个语种上。
// 只改 ref 就够，上面两个 watch 负责写回配置。
function onLangChange(side) {
  if (srcLang.value === 'auto') return
  if (side === 'src') {
    if (srcLang.value !== tgtLang.value) return
    tgtLang.value = isZh(srcLang.value) ? 'en' : 'zh'
  } else {
    if (tgtLang.value !== srcLang.value) return
    srcLang.value = isZh(tgtLang.value) ? 'en' : 'zh'
  }
}

// ---- 设置 ----
function persistCfg() { p.saveConfig(cfg) }
function setStyle(s) { cfg.style = s; persistCfg() }
const termsObjToText = (obj) => Object.keys(obj || {}).map(k => k + '=' + obj[k]).join('\n')
function saveTerms() {
  cfg.terms = {}
  termsText.value.split(/\n|,|，/).forEach(pair => {
    const [k, v] = pair.split('=')
    if (k && v && k.trim() && v.trim()) cfg.terms[k.trim()] = v.trim()
  })
  persistCfg()
}
// ---- 预置术语包（AI/编程/医学/金融/法律，一键添加/移除）----
// 判定"已启用"= 该包全部术语都已在表中；移除只删本包条目，不动用户自己写的
function packCount(pk) { return Object.keys(pk.terms).length }
function packActive(id) {
  const pk = TERM_PACKS.find(x => x.id === id)
  if (!pk) return false
  const t = cfg.terms || {}
  return Object.keys(pk.terms).every(k => t[k] === pk.terms[k])
}
function togglePack(pk) {
  const t = Object.assign({}, cfg.terms || {})
  if (packActive(pk.id)) Object.keys(pk.terms).forEach(k => { delete t[k] })
  else Object.assign(t, pk.terms)
  cfg.terms = t
  termsText.value = termsObjToText(t)
  persistCfg()
}
watch(autoCopy, (v) => { cfg.autoCopy = v; persistCfg() })
watch(tgtLang, (v) => { cfg.tgtLang = v; persistCfg() })

// ---- 语音包管理（本地 TTS 朗读；模型按需下载，espeak 数据各包共享只存一份）----
// 某语言的语音包列表
function voiceOf(lang) { return voiceList.value.filter(v => v.lang === lang) }
// 中英都有装好的包 = 一键启用按钮可以收起来
const voicesAllReady = computed(() => ['zh', 'en'].every(l => voiceOf(l).some(v => v.installed)))
const mbText = (n) => (n / 1048576).toFixed(0) + 'MB'
function refreshVoices() {
  try {
    const info = p.voicePackInfo ? p.voicePackInfo() : { voices: [] }
    voiceList.value = info.voices || []
    legacyVoices.value = info.legacy || []
    migrateVoiceCfg()
    // 后台预热已启用的语音包（引擎加载要时间，预热后点朗读即出音）
    if (p.ttsWarmup) {
      const ids = Object.values(voicePackMap.value).filter(Boolean)
      if (ids.length) setTimeout(() => { try { p.ttsWarmup(ids) } catch {} }, 1500)
    }
  } catch { voiceList.value = [] }
}
// 选择某语言的朗读语音包；'' = 用系统 TTS
function setVoiceFor(lang, id) {
  voicePackMap.value = Object.assign({}, voicePackMap.value, { [lang]: id })
  cfg.voicePackMap = Object.assign({}, voicePackMap.value)
  persistCfg()
  // 切换到某个语音包时立即预热，避免首次朗读等引擎加载
  if (id && p.ttsWarmup) setTimeout(() => { try { p.ttsWarmup([id]) } catch {} }, 100)
}
// 一键启用：运行时 + 中英两个轻量包全自动（断点续传 → 解压 → 校验 → 选默认 → 预热），
// 用户只按一次，其余全是插件自己完成 —— "几乎无感"就指这条路。
async function enableTts() {
  voiceError.value = ''
  voiceBusy.value = 'bundle'
  voiceDl.value = true
  voicePercent.value = 0
  voiceStatus.value = '准备安装...'
  try {
    await p.installVoiceBundle({
      onPhase: (phase) => { voiceStatus.value = phase },
      onProgress: (got, total) => { if (total) voicePercent.value = Math.min(99, Math.round(got / total * 100)) },
    })
    refreshVoices()
    // 装完即用：该语言还没选过语音包就自动切过去
    for (const lang of ['zh', 'en']) {
      if (!voicePackMap.value[lang]) {
        const v = voiceOf(lang).find(x => x.installed)
        if (v) setVoiceFor(lang, v.id)
      }
    }
    voicePercent.value = 100
    voiceStatus.value = '语音朗读已启用 ✓'
  } catch (e) { voiceError.value = e.message }
  voiceDl.value = false
  voiceBusy.value = ''
}
// 单个语音包下载安装（下载→解压→盖戳，不跳浏览器）
async function downloadVoice(id) {
  voiceError.value = ''
  voiceBusy.value = id
  voiceDl.value = true
  voicePercent.value = 0
  try {
    await p.downloadAndInstallVoice(id, {
      onPhase: (phase) => { voiceStatus.value = phase },
      onProgress: (got, total) => { if (total) voicePercent.value = Math.min(99, Math.round(got / total * 100)) },
    })
    voicePercent.value = 100
    voiceStatus.value = '安装完成 ✓'
    refreshVoices()
    const v = voiceList.value.find(x => x.id === id)
    if (v && v.lang && !voicePackMap.value[v.lang]) setVoiceFor(v.lang, v.id)
  } catch (e) { voiceError.value = e.message }
  voiceDl.value = false
  voiceBusy.value = ''
}
// 音色试听：合成一句固定台词（中英各一句），走同一套 Web Audio 队列播放
async function previewVoice(lang) {
  if (previewBusy.value) return
  const v = voiceOf(lang).find(x => x.installed)
  if (!v) return
  previewBusy.value = lang
  voiceError.value = ''
  const line = lang === 'zh'
    ? '你好，这是本地语音朗读的效果，不用联网也能读得很自然。'
    : 'Hello, this is how the local voice sounds. It works entirely offline.'
  try {
    stopSpeaking()
    const session = speakSession
    const r = await p.ttsSynthesize(line, v.id)
    // 合成期间用户可能已经点了正文朗读；这次试听的结果过期，塞进队列会跟正文叠着播
    if (session !== speakSession) return
    if (!r.ok) throw new Error(r.reason || '合成失败')
    enqueueWav(r.wav, r.sampleRate)
    // 不再往下方写"试听中..."：按钮自己会变成"合成中..."，下面再冒一行反而突兀
  } catch (e) { voiceError.value = e.message }
  // 必须走 finally：上面那条 return 是"试听结果已过期"的早退路径，跳过复位的话
  // previewBusy 会一直停着，按钮卡在"合成中..."，两个语言的试听全被锁死
  finally { previewBusy.value = '' }
}
function removeVoice(id) {
  try {
    p.removeVoicePack(id)
    // 若删的正是当前启用的，退回系统 TTS
    const next = Object.assign({}, voicePackMap.value)
    for (const k of Object.keys(next)) if (next[k] === id) next[k] = ''
    voicePackMap.value = next
    cfg.voicePackMap = Object.assign({}, next)
    persistCfg()
    refreshVoices()
    voiceStatus.value = '已删除'
  } catch (e) { voiceError.value = e.message }
}
// 清理旧版本遗留的语音包目录（Kokoro / Matcha 等，动辄几百 MB）——
// 只清不在注册表里的目录，当前在用的包不受影响
function purgeLegacy() {
  try {
    const r = p.purgeLegacyVoices()
    voiceStatus.value = r.removed.length
      ? `已清理 ${r.removed.length} 个旧语音包，释放 ${mbText(r.freed)}`
      : '没有可清理的旧语音包'
    refreshVoices()
  } catch (e) { voiceError.value = e.message }
}
const voiceLangLabel = (l) => (l === 'en' ? '英语' : l === 'zh' ? '中文' : l)
// 复制语音服务详细日志（含子进程 stderr），便于用户回报问题
function copyTtsLog() {
  try {
    const log = (p.readTtsErrorLog && p.readTtsErrorLog()) || ''
    const pathHint = (p.ttsErrorLogPath && p.ttsErrorLogPath()) || ''
    const text = log
      ? log + '\n--- 日志文件路径 ---\n' + pathHint
      : '（暂无详细日志）' + (pathHint ? '\n' + pathHint : '')
    utools.copyText(text)
    voiceStatus.value = '详细日志已复制到剪贴板，可直接粘贴发送'
  } catch (e) { voiceStatus.value = '复制失败: ' + e.message }
}

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
  if (picked.value && picked.installed) return activateModel(pickId.value)
  if (!modelDir.value) {
    // 与引擎一致：按钮随时可点；未选模型目录则先弹目录选择，选中后再开始下载
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
  dlPercent.value = 0
  dlText.value = '连接下载源...'
  try {
    // 应用内直下（ModelScope→hf-mirror→官方，断点续传），完成即自动激活
    await p.downloadModel(modelDir.value, pickId.value, (pr) => {
      dlPercent.value = pr.total ? Math.min(99, Math.floor(pr.received / pr.total * 100)) : 0
      const mb = (n) => (n / 1048576).toFixed(1) + 'MB'
      dlText.value = mb(pr.received) + (pr.total ? ' / ' + mb(pr.total) + '（' + dlPercent.value + '%）' : '')
        + (pr.speed ? ' · ' + (pr.speed / 1048576).toFixed(1) + 'MB/s' : '')
    })
    refreshModels()
    await activateModel(pickId.value)
  } catch (e) {
    if (e.code === 'aborted') {
      progressText.value = '已取消下载，进度已保留，下次点「下载所选模型」自动续传'
    } else {
      progressText.value = '下载失败: ' + e.message + '（进度已保留可重试；也可用下方链接浏览器下载后导入）'
      modelLinks.value = p.modelLinks(pickId.value) // 失败时给出手动链接兜底
    }
  }
  downloading.value = false
}
function cancelDownload() { p.cancelModelDownload() }
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
  prevModelId.value = cfg.modelId // 记住进来前的规格：返回时恢复（下载新规格会改写 cfg.modelId）
  modelReady.value = false
  refreshModels()
  // 上次下载没下完：提示点下载即自动续传
  const part = modelDir.value ? p.modelPartInfo(modelDir.value, pickId.value) : 0
  if (part > 0 && !p.modelExists(modelDir.value, pickId.value)) {
    progressText.value = '上次下载未完成（已有 ' + (part / 1048576).toFixed(0) + 'MB），选好规格点「下载所选模型」自动续传'
  }
}
function backToMain() {
  // 返回 = 放弃本次更换（含未完成的下载意图），恢复上次可用规格。
  // 必须存在一个能用的规格才有返回的意义：优先进页前记下的那个，其次列表里任一已装规格
  // （场景：下载了新规格但没导入就退出插件，重进时 cfg.modelId 指向未安装档，
  //  此时若不给返回，用户只能手动选回旧档再点「启用所选模型」才能离开——不合逻辑）
  const id = fallbackModelId.value
  if (!id) return
  cfg.modelId = id
  pickId.value = id
  modelLinks.value = null
  progressText.value = ''
  p.saveConfig(cfg)
  modelFile.value = p.getModelFile(modelDir.value, id)
  modelReady.value = true
  const dest = configBack.value ? 'settings' : 'main'
  configBack.value = false
  prevModelId.value = ''
  view.value = dest
  if (dest === 'main') loadHistory()
  preloadModel() // 恢复后确保服务按该规格就绪（已在跑则毫秒级返回）
}
function copyModelLink(u) {
  utools.copyText(u)
  copyHint.value = '链接已复制 ✓'
  setTimeout(() => { if (copyHint.value === '链接已复制 ✓') copyHint.value = '' }, 1500)
}

// ---- 引擎安装（进入插件第一步：引擎就绪后才进入模型配置/主界面）----
function initFlow() {
  refreshVoices() // 语音包状态（朗读用，与引擎无关，进插件就查）
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
  if (engineBusy.value) return
  engineBusy.value = true
  engineError.value = ''
  engineDlPercent.value = 0
  engineDlText.value = '连接下载源...'
  try {
    // 应用内直下（镜像自动换源+断点续传）→ 自动解压安装 → 完成
    await p.downloadEngine((pr) => {
      engineDlPercent.value = pr.total ? Math.min(99, Math.floor(pr.received / pr.total * 100)) : 0
      const mb = (n) => (n / 1048576).toFixed(1) + 'MB'
      engineDlText.value = mb(pr.received) + (pr.total ? ' / ' + mb(pr.total) + '（' + engineDlPercent.value + '%）' : '')
        + (pr.speed ? ' · ' + (pr.speed / 1048576).toFixed(1) + 'MB/s' : '')
    }, (phase) => {
      if (phase === '安装引擎中...') engineDlPercent.value = 100
      engineDlText.value = phase
    })
    engineStatus.value = ''
    engineReady.value = true
    initFlow()
  } catch (e) {
    if (e.code === 'aborted') {
      engineStatus.value = '已取消下载，进度已保留，再点「下载引擎」自动续传'
    } else {
      engineError.value = e.message
    }
  }
  engineBusy.value = false
}
function cancelEngineDownload() { p.cancelEngineDownload() }
async function importEngine() {
  engineBusy.value = true
  engineError.value = ''
  engineDlPercent.value = 0
  const f = await p.chooseEngineFile()
  if (!f) { engineBusy.value = false; return }
  engineDlText.value = '解析安装包...'
  try {
    await p.installEngineFromFile(f, (phase) => {
      engineDlPercent.value = 100
      engineDlText.value = phase
    })
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
    // 语音子进程闲置 30 分钟会自退，uTools 后台保留页面又不会重跑模块顶层 —— 重进时补一次预热，
    // 否则用户隔一阵回来点朗读，撞的是 2~3 秒的冷启动
    if (p.ttsWarmup) {
      const ids = Object.values(voicePackMap.value).filter(Boolean)
      if (ids.length) setTimeout(() => { try { p.ttsWarmup(ids) } catch {} }, 300)
    }
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
/* ---- 主题变量（夜间模式跟随 uTools 主题：webview 的 prefers-color-scheme 随之切换，纯 CSS 自动响应）---- */
:root {
  color-scheme: light;
  --blue: #4a6bfb; --blue-d: #3f5ef0;
  --ink: #1f2329; --sub: #6b7280; --faint: #9ca3af; --disabled: #c0c4cc;
  --bg: transparent; --card: #fff; --soft: #f5f6f8;
  --line: #e4e7ed; --line-soft: #f0f2f5;
  --hover: #fafbfc; --hover-line: #c6cbd4;
  --btn-ghost: #4e5969; --placeholder: #a8abb2;
  --ring: rgba(74, 107, 251, .1);
  --shadow: 0 1px 2px rgba(16, 24, 40, .04);
  --seg-on: #fff; --seg-on-shadow: 0 1px 2px rgba(16, 24, 40, .08);
  --primary-disabled: #b9c6fd;
  --progress-track: #eef0f4;
  --model-on: #f5f7ff;
  --badge-ok: #1f7a4d; --badge-ok-bg: #e8f5ee;
  --danger: #e64545; --danger-title: #d23f3f; --danger-msg: #a33; --danger-bg: #fdf0f0; --danger-line: #f5c2c2; --danger-hover-bg: #fdecec;
  --switch-off: #e4e7ed; --switch-off-line: #dcdfe6;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ink: #e6e8eb; --sub: #a1a7b0; --faint: #7d8592; --disabled: #565b64;
    --bg: transparent; --card: #2a2d31; --soft: #24272b;
    --line: #3f434a; --line-soft: #353940;
    --hover: #31353b; --hover-line: #565b64;
    --btn-ghost: #c6cbd3; --placeholder: #5f6470;
    --ring: rgba(102, 130, 255, .28);
    --shadow: 0 1px 2px rgba(0, 0, 0, .2);
    --seg-on: #3d4148; --seg-on-shadow: 0 1px 2px rgba(0, 0, 0, .35);
    --primary-disabled: #414e8f;
    --progress-track: #3a3e45;
    --model-on: rgba(74, 107, 251, .18);
    --badge-ok: #63c295; --badge-ok-bg: rgba(34, 163, 95, .16);
    --danger: #ef7070; --danger-title: #ef7070; --danger-msg: #e39a9a; --danger-bg: rgba(230, 69, 69, .1); --danger-line: rgba(230, 69, 69, .32); --danger-hover-bg: rgba(230, 69, 69, .16);
    --switch-off: #3f434a; --switch-off-line: #4a4f57;
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  background: var(--bg);
  color: var(--ink);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  height: 100%;
  overflow: hidden;
}
/* 高度自适应：填满 uTools 窗口实际高度（默认 544/560），切视图高度不变故窗口不拉伸 */
.container { padding: 16px; max-width: 800px; margin: 0 auto; height: 100vh; min-height: 460px; display: flex; flex-direction: column; gap: 12px; }
.card {
  background: var(--card); border-radius: 10px; padding: 14px 16px;
  box-shadow: var(--shadow);
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
.btn.primary:disabled { background: var(--primary-disabled); cursor: not-allowed; }
.btn.ghost { background: var(--card); border: 1px solid var(--line); color: var(--btn-ghost); }
.btn.ghost:hover:not(:disabled) { border-color: var(--hover-line); background: var(--hover); }
.btn.ghost:disabled { background: var(--soft); border-color: var(--soft); color: var(--disabled); cursor: not-allowed; }
.row { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }

/* ---- 对称双卡（输入/输出同构） ---- */
.io-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.text-zone {
  flex: 1; min-height: 0; position: relative;
  border: 1px solid var(--line); border-radius: 8px; background: var(--card);
  transition: border-color .15s, box-shadow .15s; overflow: hidden;
}
.text-zone:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px var(--ring); }
.text-zone textarea {
  width: 100%; height: 100%; display: block; resize: none; border: none; background: transparent;
  padding: 12px 14px 30px; font-size: 14px; line-height: 1.75;
  font-family: inherit; color: var(--ink);
}
.text-zone textarea::placeholder { color: var(--placeholder); }
.text-zone textarea:focus { outline: none; }
.count { position: absolute; right: 12px; bottom: 10px; font-size: 12px; color: var(--placeholder); pointer-events: none; }
.actions { margin-top: 10px; flex: none; }

/* 输出区与输入区同构 */
.result-scroll { height: 100%; overflow-y: auto; padding: 12px 14px; }
.result { font-size: 14.5px; line-height: 1.9; white-space: pre-wrap; word-break: break-word; }
.result.err { color: var(--danger); }
.placeholder-zone { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.ph-line { font-size: 13.5px; color: var(--faint); }
.ph-sub { font-size: 12px; color: var(--disabled); }

/* ---- 工具栏（中线） ---- */
.bar { flex: none; height: 48px; padding-top: 0; padding-bottom: 0; display: flex; align-items: center; gap: 10px; }
.status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sub); white-space: nowrap; }
.status i { width: 7px; height: 7px; border-radius: 50%; background: #22a35f; flex: none; }
.status.warn i { background: #e6772e; }

/* ---- 语言选择器（卡片底栏左侧，对称镜像） ---- */
.lang {
  appearance: none; -webkit-appearance: none;
  height: 30px; padding: 0 26px 0 12px; max-width: 130px;
  border: 1px solid var(--line); border-radius: 6px; background-color: var(--card);
  font-size: 12.5px; font-family: inherit; color: var(--btn-ghost); cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  transition: border-color .15s;
}
.lang:hover { border-color: var(--hover-line); }
.lang:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px var(--ring); }
/* 下拉箭头是 data URI 内联 svg,无法走 CSS 变量,暗色单独换浅色版 */
@media (prefers-color-scheme: dark) {
  .lang { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23a1a7b0' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
}

/* ---- 二级界面（设置/历史）：与主界面等高，内部滚动 ---- */
.overlay-card { display: flex; flex-direction: column; }
.overlay-head { display: flex; align-items: center; gap: 12px; flex: none; }
.overlay-body { flex: 1; min-height: 0; overflow-y: auto; margin-top: 12px; }
.panel-title { font-weight: 600; font-size: 14px; }
.muted { color: var(--faint); font-weight: 400; font-size: 12px; }
.empty { padding: 40px 0; text-align: center; font-size: 13px; color: var(--faint); background: var(--soft); border-radius: 8px; }
.hist-list { display: flex; flex-direction: column; }
.hist-item { display: flex; align-items: center; gap: 10px; padding: 12px 6px; border-bottom: 1px solid var(--line-soft); cursor: pointer; transition: background .12s; }
.hist-item:last-child { border-bottom: none; }
.hist-item:hover { background: var(--hover); }
.hist-texts { flex: 1; min-width: 0; }
.hist-src { font-size: 12.5px; color: var(--faint); margin-bottom: 4px; word-break: break-all; line-height: 1.5; }
.hist-dst { font-size: 13.5px; line-height: 1.6; word-break: break-all; }
.hist-del {
  flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px; background: transparent; color: var(--disabled); cursor: pointer;
  opacity: 0; transition: opacity .12s, background .12s, color .12s;
}
.hist-item:hover .hist-del { opacity: 1; }
.hist-del:hover { background: var(--danger-hover-bg); color: var(--danger); }
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
.seg button.on { background: var(--seg-on); color: var(--blue); font-weight: 600; box-shadow: var(--seg-on-shadow); }
.terms {
  width: 100%; min-height: 68px; border: 1px solid var(--line); border-radius: 8px;
  padding: 8px 14px; font-size: 13px; line-height: 1.7; resize: none; display: block;
  font-family: inherit; color: var(--ink); background: var(--card);
}
.terms:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px var(--ring); }
.model-path { border-top: 1px solid var(--line-soft); margin-top: 4px; padding-top: 8px; min-height: 0; }

/* ---- 语音包（设置页） ---- */
.voice-head { border-top: 1px solid var(--line-soft); margin-top: 12px; padding-top: 12px; }
/* 说明文字单行省略号：再长也不许把右侧按钮挤换行（与链接折叠同一套约定） */
.voice-head .muted { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.voice-row { min-height: 40px; }
.voice-lang { font-size: 12.5px; color: var(--sub); flex: none; width: 46px; }
.seg button:disabled { color: var(--disabled); cursor: not-allowed; }
.path { font-size: 12px; color: var(--faint); word-break: break-all; line-height: 1.6; flex: 1; margin-right: 12px; }
.footnote { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.footnote p { font-size: 12px; color: var(--faint); line-height: 1.8; }
.err-box { margin-top: 12px; padding: 10px 14px; background: var(--danger-bg); border: 1px solid var(--danger-line); border-radius: 8px; }
.voice-hint { font-size: 12px; color: var(--faint); margin-top: 6px; }
.err-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.err-title { font-size: 12.5px; font-weight: 600; color: var(--danger-title); margin-bottom: 4px; }
.err-msg { font-size: 12px; color: var(--danger-msg); line-height: 1.7; word-break: break-all; white-space: pre-wrap; }
.err-hint { font-size: 11.5px; color: var(--faint); margin-top: 6px; }

/* ---- 开关 ---- */
.switch-label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.muted-label { font-size: 12.5px; color: var(--sub); }
.switch { position: relative; display: inline-block; width: 38px; height: 21px; flex: none; cursor: pointer; }
.switch i {
  position: absolute; inset: 0; background: var(--switch-off); border: 1px solid var(--switch-off-line);
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
.cfg-actions { display: flex; gap: 10px; align-items: center; }
.progress { margin-top: 14px; }
.progress-bar { height: 6px; background: var(--progress-track); border-radius: 3px; overflow: hidden; }
.fill { height: 100%; background: var(--blue); border-radius: 3px; transition: width .2s; }
.progress-text { display: block; margin-top: 6px; font-size: 12px; color: var(--faint); }
.progress .progress-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.progress .progress-row .progress-text { margin-top: 0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 模型文件路径跟在按钮行内,单行超出省略号,不再单独占行撑高配置卡(否则与模型列表出双滚动条) */
.cfg .path { flex: 1; min-width: 0; font-size: 12px; color: var(--faint); line-height: 1.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 模型配置卡：内部改用弹性布局，让模型列表吸收空间余量。
   否则「下载后多出的提示行」会把卡片撑出 20 余像素内部滚动条（用户反馈的问题 1）。 */
.cfg-model { overflow: hidden; display: flex; flex-direction: column; gap: 0; }
.cfg-model .desc { flex: none; }
.cfg-model .cfg-actions, .cfg-model .progress, .cfg-model .progress-text, .cfg-model .links-toggle { flex: none; }

/* ---- 模型规格选择（配置卡） ---- */
.cfg-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: none; }
/* 列表弹性收缩：空间够则 200px 封顶，不够则自己内部滚动，绝不把卡片撑出滚动条 */
.model-list { margin: 4px 0 14px; display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-height: 58px; max-height: 200px; overflow-y: auto; }
.model-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; transition: border-color .15s, background .15s; flex: none; }
.model-item:hover { border-color: var(--hover-line); background: var(--hover); }
.model-item.on { border-color: var(--blue); background: var(--model-on); }
.mi-radio { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--disabled); flex: none; position: relative; }
.model-item.on .mi-radio { border-color: var(--blue); }
.model-item.on .mi-radio::after { content: ''; position: absolute; inset: 2.5px; border-radius: 50%; background: var(--blue); }
.mi-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mi-name { font-size: 13.5px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.mi-meta { font-size: 12px; color: var(--faint); }
.mi-badge { font-size: 11px; font-weight: 400; color: var(--sub); background: var(--soft); border-radius: 4px; padding: 1px 6px; flex: none; }
.mi-badge.ok { color: var(--badge-ok); background: var(--badge-ok-bg); }
.mi-label { font-size: 13px; color: var(--ink); font-weight: 600; }

/* ---- 引擎安装卡（v0.4.0：手动下载链接 + 镜像） ---- */
.links-title { margin-top: 14px; font-size: 12.5px; color: var(--sub); }
.copy-hint { margin-top: 10px; }
/* 手动链接折叠开关：默认收起，避免展开时把配置卡撑出滚动条 */
.links-toggle {
  margin-top: 12px; padding: 0; border: none; background: transparent;
  color: var(--sub); font-size: 12.5px; font-family: inherit; cursor: pointer;
  display: block; text-align: left;
}
.links-toggle:hover { color: var(--blue); }
.link-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.link-label { font-size: 12px; color: var(--sub); flex: none; }
.link-txt {
  flex: 1; min-width: 0;
  font-size: 11.5px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; /* 链接单行显示，超出省略号 */
  line-height: 1.8;
}
.links-note { margin-top: 10px; font-size: 12px; color: var(--faint); line-height: 1.8; }

/* ---- 术语包（设置页一键添加） ---- */
/* 标题行 + 行业包按钮同行：设置页垂直空间紧张，合并后省一行 */
.term-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 40px; }
/* 首列与 .set-row 对齐：那边的间距是 16px，这里 gap 给 8px（行业包按钮之间也用这个值，
   不能直接改 gap），所以给标签补 8px —— 否则「每行一条 术语=译文」比上方按钮行靠左 8px */
.term-head .set-label { margin-right: 8px; }
.term-packs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.tp-hint { font-size: 12px; color: var(--faint); }
.term-packs .btn.on { border-color: var(--blue); color: var(--blue); background: var(--model-on); font-weight: 600; }
.term-head .btn.on { border-color: var(--blue); color: var(--blue); background: var(--model-on); font-weight: 600; }
.tp-note { font-size: 11.5px; color: var(--faint); margin-bottom: 8px; line-height: 1.6; }
.full-card { display: flex; flex-direction: column; justify-content: center; }
.full-card.overlay-card { justify-content: flex-start; }
.tips { background: var(--soft); border-radius: 8px; padding: 14px 20px; margin-top: 16px; flex: none; }
.tips-title { display: flex; align-items: center; gap: 6px; color: var(--blue); font-weight: 600; margin-bottom: 8px; font-size: 13.5px; }
.bulb { font-size: 14px; }
.tip { font-size: 13px; color: var(--sub); line-height: 2; }

/* ---- 滚动条（日夜统一样式，不随主题变色） ---- */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-track-piece { background-color: transparent; }
::-webkit-scrollbar-thumb { background-color: #9b97a2; border-radius: 1px; border: 1px solid #9b97a2; box-shadow: inset 0 0 6px rgba(0, 0, 0, .3); }
::-webkit-scrollbar-thumb:hover { background-color: #676e77; border: 1px solid #676e77; }
::-webkit-scrollbar-thumb:active { background-color: #4E5969; border: 1px solid #4E5969; }
::-webkit-scrollbar-corner { background-color: transparent; }
</style>
