/**
 * 构建后清理 dist 中手写 JS 的注释（preload.js / engine-unpack.js 源码直拷，注释会全量进 dist）。
 * 只用状态机剥离注释，不做任何代码转换（不改行数、不压缩、不混淆）：
 *   - 字符串（单双引号、反引号）、模板串、正则字面量内部的注释标记一律不碰
 *   - 正则开头按上下文启发式判断（前 token 为标识符/数字/闭括号 → 除法，否则正则）
 * 源码注释完整保留在 public/ 与 src/ 下；执行后 node --check 双文件 + e2e 行为验证。
 */
const fs = require('fs')
const path = require('path')

const TARGETS = ['dist/preload.js', 'dist/engine-unpack.js', 'dist/download.js']

function isRegexStart(out) {
  const m = out.match(/(\S)\s*$/)
  if (!m) return true // 代码开头
  if (/[(\[{,:;=!&|?<>+\-*%^~]/.test(m[1])) return true
  if (/(^|\s)(return|typeof|instanceof|in|of|new|delete|void|do|else|case)$/.test(out)) return true
  return false // 标识符/数字/闭括号 → 除法
}

function strip(code) {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    const d = code[i + 1]
    if (c === '/' && d === '/') { // 行注释
      while (i < n && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') { // 块注释
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') { // 字符串
      const q = c
      out += q
      i++
      while (i < n) {
        const s = code[i]
        if (s === '\\') { out += s + (code[i + 1] || ''); i += 2; continue }
        if (s === q) { out += s; i++; break }
        if (q === '`' && s === '$' && code[i + 1] === '{') { // 模板插入表达式：透传至匹配右花括号
          out += '${'
          i += 2
          let depth = 1
          while (i < n && depth > 0) {
            const t = code[i]
            if (t === '{') depth++
            else if (t === '}') depth--
            out += t
            i++
          }
          continue
        }
        out += s
        i++
      }
      continue
    }
    if (c === '/' && isRegexStart(out)) { // 正则字面量
      out += c
      i++
      let inClass = false
      while (i < n) {
        const s = code[i]
        if (s === '\\') { out += s + (code[i + 1] || ''); i += 2; continue }
        if (s === '[') inClass = true
        else if (s === ']') inClass = false
        else if (s === '/') { if (inClass) { out += s; i++; continue } out += s; i++; break }
        else if (s === '\n') break
        out += s
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

for (const rel of TARGETS) {
  const file = path.join(__dirname, '..', rel)
  const src = fs.readFileSync(file, 'utf8')
  const cleaned = strip(src)
  fs.writeFileSync(file, cleaned, 'utf8')
  console.log('[strip-comments] ' + rel + ': ' + src.length + ' -> ' + cleaned.length + ' bytes (-' + Math.round((1 - cleaned.length / src.length) * 100) + '%)')
}