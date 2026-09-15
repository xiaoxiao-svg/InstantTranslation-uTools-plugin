/**
 * 模板表达式引用的标识符必须能在 <script setup> 里找到定义。
 * Vue 编译器不做这层检查——模板里写了不存在的函数/变量，构建照常通过，
 * 到渲染时才炸 TypeError（2026-09-15 voiceOf 事故：重写语音设置时删了函数、模板还在用，
 * 真机点开设置页才暴露）。本检查卡在构建链最前面，防再犯。
 *
 * 原理：抽出模板里的插值与指令表达式，剥掉字符串/属性访问后抓标识符，
 * 对照 script 顶层定义 + v-for 局部变量 + 全局白名单。
 * 已知盲区（可接受，宁可漏报不误报）：对象字面量键名与三元分支共用"后跟冒号"特征，
 * 跟在冒号后的标识符不判缺失——真缺了也要靠人工复核本脚本输出。
 */
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.vue'), 'utf8')
const tplStart = src.indexOf('<template>')
const tplEnd = src.lastIndexOf('</template>')
const tpl = src.slice(tplStart + 10, tplEnd)
const script = src.slice(src.indexOf('<script setup>') + 14, src.lastIndexOf('</script>'))

const GLOBALS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', '$event', '$refs', '$el', '$emit', '$props',
])

// v-for 局部变量（v item / (a, b) in list / (v, i) in list）
const locals = new Set()
for (const m of tpl.matchAll(/v-for="\(?\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*))?\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)?\s+(?:in|of)\s/g)) {
  for (const g of m.slice(1)) if (g) locals.add(g)
}

// script 顶层定义：函数、const/let/var、import
const defined = new Set()
for (const m of script.matchAll(/^\s*(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm)) defined.add(m[1])
for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) defined.add(m[1])
for (const m of script.matchAll(/^\s*import\s+[^;'"]*?\{([^}]*)\}/gm)) {
  for (const part of m[1].split(',')) {
    const n = part.trim().split(/\s+as\s+/).pop()
    if (n) defined.add(n)
  }
}
for (const m of script.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from/gm)) defined.add(m[1])

// 收集表达式：插值 + 常用指令的值
const exprs = []
for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.push(m[1])
for (const m of tpl.matchAll(/(?:v-if|v-else-if|v-show|v-for|v-html|v-model(?::[\w-]+)?|:[\w.-]+|@[\w.-]+)="([^"]*)"/g)) exprs.push(m[1])

const unknown = new Set()
for (const e of exprs) {
  let cleaned = e.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ').replace(/\?\./g, '.')
  // 剥属性/方法访问 foo.bar、a.b.c（前缀是标识符/右括号/数字才视为访问；数字字面量 3.2 一并吞掉无害）
  for (let prev = null; prev !== cleaned; ) {
    prev = cleaned
    cleaned = cleaned.replace(/[A-Za-z0-9_$)\]]\s*\.\s*[A-Za-z_$][\w$]*/g, (s) => s[0])
  }
  for (const m of cleaned.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0]
    if (defined.has(id) || GLOBALS.has(id) || locals.has(id)) continue
    if (id === 'in' || id === 'of' || id === 'typeof') continue
    // 后跟冒号 → 多半是对象字面量的键（三元分支会被一并放过，接受）
    if (/^\s*:/.test(cleaned.slice(m.index + id.length))) continue
    // 紧跟 { 之后 → 键名
    if (/\{\s*$/.test(cleaned.slice(0, m.index))) continue
    unknown.add(id)
  }
}

if (unknown.size) {
  console.error('[check-template] 模板引用了 script 里没有的定义（渲染时会是 undefined / TypeError）：')
  for (const u of [...unknown].sort()) console.error('  - ' + u)
  process.exit(1)
}
console.log('[check-template] 模板 ' + exprs.length + ' 个表达式的标识符全部有定义 ✓')
