
const zlib = require('zlib')
const path = require('path')

let stripTop = null 


function unpackZip(buf, dest) {
  
  let eocd = -1
  const tailStart = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= tailStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('无效的 zip 文件（未找到目录结尾）')
  const cdCount = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  let p = cdOffset
  let count = 0
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录条目损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    let name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (!(flags & 0x800)) name = buf.toString('latin1', p + 46, p + 46 + nameLen) 
    const safe = normalizePath(name, dest)
    
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip local header 损坏: ' + name)
    const lNameLen = buf.readUInt16LE(lho + 26)
    const lExtraLen = buf.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let out
    if (method === 0) out = raw 
    else if (method === 8) out = zlib.inflateRawSync(raw) 
    else throw new Error('不支持的压缩方式(method ' + method + '): ' + name)
    if (safe && !/\/$/.test(name)) {
      require('fs').mkdirSync(path.dirname(safe), { recursive: true })
      require('fs').writeFileSync(safe, out)
      count++
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  if (count === 0) throw new Error('zip 内没有可安装的文件')
}


function unpackTarGz(buf, dest) {
  const data = zlib.gunzipSync(buf)
  let off = 0
  let count = 0
  while (off + 512 <= data.length) {
    const h = data.subarray(off, off + 512)
    const nameRaw = h.subarray(0, 100)
    const sizeStr = h.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim()
    const type = String.fromCharCode(h[156])
    const prefix = h.subarray(345, 500)
    let name = nameRaw.toString('utf8').replace(/\0.*$/, '')
    const pre = prefix.toString('utf8').replace(/\0.*$/, '')
    if (!name) {
      if (data.subarray(off, off + 512).every((b) => b === 0)) break 
      off += 512
      continue
    }
    if (pre) name = pre + '/' + name
    const size = parseInt(sizeStr, 8) || 0
    const body = data.subarray(off + 512, off + 512 + size)
    
    if (type === '0' || type === '\0' || type === '7') {
      const safe = normalizePath(name, dest)
      if (safe) {
        require('fs').mkdirSync(path.dirname(safe), { recursive: true })
        require('fs').writeFileSync(safe, body)
        count++
      }
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  if (count === 0) throw new Error('tar.gz 内没有可安装的文件')
}


function normalizePath(name, dest) {
  const raw = name.split('/')
  const parts = []
  for (const s of raw) {
    if (s === '..') return null 
    if (s && s !== '.') parts.push(s)
  }
  if (parts.length === 0) return null
  if (stripTop && parts[0] === stripTop) parts.shift()
  const base = path.resolve(dest) 
  const full = path.join(base, ...parts)
  if (full !== base && !full.startsWith(base + path.sep)) return null 
  return full
}


function unpackArchive(archivePath, dest) {
  const fs = require('fs')
  const buf = fs.readFileSync(archivePath)
  const low = archivePath.toLowerCase()
  fs.mkdirSync(dest, { recursive: true })
  stripTop = null
  if (low.endsWith('.zip')) {
    unpackZip(buf, dest)
  } else if (low.endsWith('.tar.gz') || low.endsWith('.tgz')) {
    
    const gz = zlib.gunzipSync(buf)
    const probe = gz.subarray(0, 512)
    const nm = probe.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').split('/')[0]
    if (nm) stripTop = nm
    unpackTarGz(buf, dest)
  } else {
    throw new Error('不支持的安装包格式（需要 .zip 或 .tar.gz）: ' + archivePath)
  }
}

module.exports = { unpackArchive }