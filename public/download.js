/**
 * 大文件流式下载（纯 Node 零依赖，uTools preload Node 16 可用）
 * 模型 gguf（1~17GB）应用内直下：不再跳浏览器 + 手动导入。
 *   - 301/302/303/307/308 重定向跟随 ≤5 跳（ModelScope / hf-mirror 的 resolve 均跳 CDN）
 *   - Range 断点续传：先写 dest.part，续传配 Range 头；服务器回 200（不支持 Range）则重头；
 *     416（.part 异常超大）删 .part 重来（受 hop 上限保护）
 *   - 背压：写盘跟不上时 res.pause()，drain 后 resume（GB 级文件必须，否则内存暴涨）
 *   - 进度回调节流 ~300ms；aborted() 为 true 随时取消（含空闲等待期），.part 保留供下次续传
 *   - 完成后校验总长 / 大小下限 / 魔数，通过才原子改名到 dest
 * 单源最多试 3 次（网络错误同源续传重试），仍败则换下一源（跨源续传：同一官方文件的镜像字节一致）
 */
const fs = require('fs')
const https = require('https')

function partPath(dest) { return dest + '.part' }
const ABORT = () => Object.assign(new Error('已取消'), { code: 'aborted' })

// 单次请求：跟随重定向并落盘。resolve({ size }) 表示整个文件完成
function fetchToFile(url, part, startByte, opts) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      // ModelScope 的 LFS CDN（cdn-lfs-cn-1）对无 User-Agent 的请求回 403，Node 默认不发 UA，必须补
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ...(startByte > 0 ? { Range: 'bytes=' + startByte + '-' } : {}),
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        return resolve({ redirect: new URL(res.headers.location, url).href })
      }
      if (res.statusCode === 416) return resolve({ reset: true }) // .part 超全长：删掉重来
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const append = res.statusCode === 206 && startByte > 0
      const base = append ? startByte : 0
      const len = parseInt(res.headers['content-length'] || '0', 10) || 0
      const total = len ? base + len : 0
      if (append && total && startByte >= total) { // .part 已达全长：续传头多余，直接走校验
        res.resume()
        return resolve({ size: startByte, total })
      }
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' })
      let received = base
      let lastT = Date.now()
      let lastB = base
      let done = false
      out.on('error', (e) => { if (!done) { done = true; res.destroy(); reject(e) } })
      res.on('error', (e) => { if (!done) { done = true; out.destroy(); reject(e) } })
      out.on('drain', () => { if (!done) res.resume() })
      res.on('data', (buf) => {
        if (done) return
        if (opts.aborted && opts.aborted()) {
          done = true; res.destroy(); out.destroy()
          return reject(ABORT())
        }
        received += buf.length
        if (!out.write(buf)) res.pause()
        const now = Date.now()
        if (opts.onProgress && now - lastT > 300) {
          const speed = (received - lastB) / ((now - lastT) / 1000)
          lastT = now; lastB = received
          opts.onProgress({ received, total, speed: Math.max(0, speed) })
        }
      })
      res.on('end', () => {
        if (done) return
        done = true
        out.end(() => {
          const size = fs.statSync(part).size
          if (total && size !== total) return reject(new Error('文件不完整：' + size + '/' + total + ' 字节'))
          if (opts.onProgress) opts.onProgress({ received: size, total: size, speed: 0, done: true })
          resolve({ size })
        })
      })
    })
    req.setTimeout(opts.idleMs || 30000, () => {
      req.destroy(opts.aborted && opts.aborted() ? ABORT() : new Error('连接空闲超时（' + ((opts.idleMs || 30000) / 1000) + 's 无数据）'))
    })
    req.on('error', (e) => reject(e))
  })
}

async function downloadFile(urls, dest, opts) {
  opts = opts || {}
  const part = partPath(dest)
  const list = Array.isArray(urls) ? urls : [urls]
  let lastErr = null
  for (const url of list) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (opts.aborted && opts.aborted()) throw ABORT()
      let start = 0
      try { start = fs.existsSync(part) ? fs.statSync(part).size : 0 } catch { start = 0 }
      if (attempt === 2 && start > 0) {
        // 最后一搏：同源两次续传均败（如 CDN 对该 Range 异常回 5xx），清 .part 从头来
        try { fs.unlinkSync(part) } catch {}
        start = 0
      }
      try {
        let cur = url
        for (let hop = 0; hop < 5; hop++) {
          const r = await fetchToFile(cur, part, start, opts)
          if (r.redirect) { cur = r.redirect; continue }
          if (r.reset) { try { fs.unlinkSync(part) } catch {}; start = 0; continue }
          // 完成：内容校验后原子改名
          if (opts.minSize && r.size < opts.minSize) throw new Error('文件 ' + (r.size / 1048576).toFixed(0) + 'MB，小于预期下限，疑似不完整')
          if (opts.magic) {
            const fd = fs.openSync(part, 'r')
            const head = Buffer.alloc(opts.magic.length)
            fs.readSync(fd, head, 0, head.length, 0)
            fs.closeSync(fd)
            if (head.toString('latin1') !== opts.magic) throw new Error('文件内容校验失败（非 ' + opts.magic + ' 格式）')
          }
          fs.renameSync(part, dest)
          return { size: r.size }
        }
        throw new Error('重定向次数过多')
      } catch (e) {
        if (e && e.code === 'aborted') throw e
        lastErr = e
        // 校验类错误（不完整/格式不对）续传无意义：清掉 .part 直接换下一源
        if (/不完整|校验失败|小于预期/.test(e.message)) {
          try { fs.unlinkSync(part) } catch {}
          break
        }
      }
    }
  }
  throw lastErr || new Error('所有下载源均失败')
}

module.exports = { downloadFile, partPath }
