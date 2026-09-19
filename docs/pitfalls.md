# 踩坑记录（Pitfalls）

> 本文件沉淀「即译」插件开发过程中踩过的坑与关键结论。**任何开发者 / AI 助手在改动对应模块前，先读对应章节。**
> 发现新坑请随手补录，格式：现象 → 根因 → 修复 → 教训。
> Git 协作与发布纪律见上级 `AGENTS.md` 与本文第 8 节速查，本文只管技术坑。

## 1. 下载链路（download.js / 应用内直下）

- **ModelScope 的 LFS CDN（cdn-lfs-cn-1）拒绝无 User-Agent 的请求，回 403**。curl 默认带 UA 所以能通，Node `https.get` 默认不发 UA 必挂 → download.js 固定携带浏览器 UA。换下载源/加源时先实测这一条。
- **ModelScope 对 Range 超界回 500 而非 416** → 续传兜底必须是"同源重试后再清 `.part` 从头下"，只认 416 会卡死。
- **加速镜像可用性会漂移**：ghfast.top 曾长期推荐、2026-09 实测已挂（超时/断连）；gh-proxy.com 直出 CDN 且支持 206 续传。引擎源顺序 gh-proxy → ghfast → GitHub 官方，**自动换源是刚需不是锦上添花**。
- 镜像速度波动极大（实测 15.9MB 下载过 ~12 分钟），超时与文案不要按理想速度设计；断点续传是保底体验。
- 完整性校验按内容做：magic（gguf=`GGUF`、zip=`PK\x03\x04`、gzip=`\x1f\x8b`）+ 大小下限；校验类失败清 `.part` 直接换下一源（重试同源无意义）。
- 大文件必须处理背压（`res.pause()` / `drain` 后 resume），GB 级下载不做会内存暴涨。
- 新增进 dist 的手写 JS 必须登记 `scripts/strip-comments.cjs` 的 `TARGETS`，否则注释全量进 dist。

## 2. 引擎解压（engine-unpack.js）

- **tar 的符号链接/硬链接条目（typeflag '1'/'2'）必须落地**。mac 官方包的 dylib 全是版本化链接（`libllama-common.0.dylib → libllama-common.0.3.0.dylib`，且有链式 `libllama.dylib → libllama.0.dylib → 实体`），跳过链接条目则 `llama-server` 启动即报 `dyld: no such file`。链接可能先于实体出现且存在链式 → **主循环只收集、结尾多轮补链至收敛**；无 symlink 特权（Windows 未开开发者模式 EPERM）时退化为拷贝实体。
- **路径比较前必须 `path.resolve` 统一分隔符**（直接拿带正斜杠的 dest 做 startsWith 比对会全量误判越界）。
- 防 `../` 穿越：含 `..` 的条目一律拒绝（有回归测试）。
- mac 包结构：`llama-server` 仅 33KB 动态壳，运行依赖同目录 dylib 全家（impl 8.9MB 等）——**全量解压是刻意设计**，挑文件装会断依赖链，包才 10.6MB 无裁剪收益。Linux 包 0 个符号链接（`.so` 为实体文件）。
- zip 走 EOCD→central directory→inflateRawSync；tar 走 gunzip + 512 块解析 + 顶层目录剥离（mac/linux 包带 `llama-bXXXX/` 一层）。

## 3. macOS 平台差异（「Windows 测过」≠ 跨平台 OK）

以下两起都是 Windows 完全零症状、只有 mac 用户能踩到的坑：

- **文件对话框 filters 写多段扩展名（`.tar.gz`）选不到文件**：macOS 的 NSOpenPanel 把扩展名映射成 UTType 严格匹配（electron#23316），没有 Windows `*.gz` 的通配语义；且拆多组会让默认组匹配不到。**规则：filters 用单段扩展名单组并集，必带 `{ extensions: ['*'] }`「全部文件」兜底组**。
- **首次冷启动 15-16s 属正常预期**：插件的"预热"只等 `/health` 返回 modelLoaded，不含推理；4-5s 是温热复用（Windows 冷启动也要 ~11s）。mac 首次多出 dyld 加载 + AMFI 签名验证 + Metal 首次管线编译。**判别是否真回退 CPU**：问用户翻译一句几秒——1s 级 = GPU 正常；5-10s/句 = 回退，查引擎日志 `load_tensors: offloaded N/N layers to GPU`。
- 隐患：若 uTools 以 Rosetta（x64）模式运行，`process.arch` 返回 x64 → 会误装 `macos-x64` 引擎（依赖 AVX2，Rosetta 不支持）→ 性能崩或起不来。收到 mac 反馈先核对 `engineInfo.platform` 应为 `darwin/arm64`。
- 浏览器下载再解压的产物带 `com.apple.quarantine` 属性，首次执行触发 Gatekeeper 扫描；插件内 fs 写出的文件不带该属性（应用内直下天然规避）。

## 4. uTools 平台（preload）

- preload 运行时为 Node 16 + Electron 22（uTools 7.8 真机实测），uTools 升级会变——重要结论先注入 `process.versions` 探测再下结论。
- preload 是 **CommonJS，不可混淆/压缩/打包**；顶层 `utools` 全局尚未注入（undefined），utools API 只能在函数/回调里调用。
- **关键字进入 payload 陷阱**：用户输入"翻译"+Enter 时，uTools 把关键字本身当 payload 传入（over 特性与关键字共用 code）。规则：payload 等于任一进入关键字 → 视为"进入插件"清空处理；其余非空文本（over 选中文本等）才回填翻译。
- uTools 后台保留 webview：重进插件会残留上次会话内容 → `onPluginEnter` 无 payload 时重置界面。
- 推理服务生命周期：常驻 + `--sleep-idle-seconds` 闲置睡眠（内存归零），唤醒 ~4s；固定端口探测复用。
- `child_process` 在 preload 可用；**spawn 成败不能同步检查 `child.pid`**（完成前恒为 undefined），只能靠 error 事件 + health 轮询；闭包引用后声明的变量注意 TDZ。

## 5. 翻译链路（llama-server / prompt）

- 必须走 `/v1/chat/completions`（服务端自动套 GGUF 内嵌官方对话模板）；**勿用裸 `/completion`**——无模板会不知道何时停、复读循环。
- prompt 用官方模板；术语块、风格句按官方格式；生成参数用官方值（temp 0.7 / top_p 0.6 / top_k 20 / repeat_penalty 1.05）。
- 翻译无状态：不复用前缀缓存（`cache_prompt: false`）。历史教训：对话式 session 累积历史会让无状态翻译越翻越慢（30~60s 级），任何带历史的调用方式都要警惕。
- 模型只认标准 GGUF；1.25bit 440MB 版需要未合并的 STQ kernel（PR#22836），stock llama.cpp 拒载，勿用。
- 引擎版本固定为 llama.cpp nightly 某 tag（`ENG_VERSION` 常量），升级只改一处；llama.cpp 已取消稳定版，`latest` 无二进制资产。

## 6. 构建与打包

- **dist 是唯一交付物**：改 `public/` 或 `src/` 后必须重新 build；build 前先杀残留 llama-server 进程（cwd 在 dist 内会锁目录 EPERM）。
- `scripts/strip-comments.cjs` 用状态机剥注释：脚本必须 `.cjs`、其自身注释禁含 `*/`；不改行数、不压缩。
- Windows PowerShell `Compress-Archive` 打的 zip 条目用反斜杠，跨平台解压有坑 → 用 python zipfile（正斜杠 + UTF-8）。
- dist 已退出 git 跟踪（.gitignore）；交付从 tag 导出或直接给 dist。
- UI 自测方法：dist 里放临时 `_preview.html`（mock `window.preload`/`window.utools`）+ 静态服务 + 浏览器截图核对全部视图态，通过后删除再交付。**坑：mock 会随 preload API 演进过期，重测前按当前 API 面重建；`fill('')` 清输入是空操作，必须原生 setter + input 合成事件；build 会清掉预览文件。**

## 7. 存储与配置

- 配置 + 历史存 `userData/utools-hy-mt2/storage.json`（透明可备份）；utools.db 已完全弃用。
- 测存储类改动必须断言 store 内容，不能只看 UI——UI 生效不代表写盘（踩过：UI 删除生效但存储静默没写）。
- 引擎装在 `userData/utools-hy-mt2/engine`（`version.txt` 标记版本，与常量不符即引导重装）；模型目录由用户选择，多规格可共存。

## 8. Git / 发布纪律（速查）

- **版本号必须用户确认后才 bump**，开发期一律不动版本号；版本提交必打 tag；不自动 push，push 先询问；精确 staging 不用 `git add -A`；不 amend 已推送 commit。
- **代码/任务改动先建分支**（`类型-简短描述`），验收后等用户表态再合并或丢弃；纯文档、无关紧要文件（logo 等）可直接提交主干。
- commit 格式 `类型: 描述`（feat/fix/docs/refactor）。
- 本地构建/测试通 ≠ 跨平台可用：mac 专属坑 Windows 全零症状（见第 3 节），跨平台改动必须用真实平台包验证。
