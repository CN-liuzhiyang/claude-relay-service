/**
 * UTF-8 流式乱码探针（只记录，不改变转发行为）
 *
 * 用来区分下游看到的 U+FFFD 乱码是哪来的：
 * - split：上游数据块在一个多字节字符中间被切断，逐块 chunk.toString() 会把这个字符解坏（CRS 自己的问题）
 * - upstream_fffd：上游原始字节里已经带着 U+FFFD（EF BF BD），说明上游/模型传过来就是坏的
 */

const REPLACEMENT_BYTES = Buffer.from([0xef, 0xbf, 0xbd])

// 返回 buf 末尾不完整 UTF-8 序列的字节数（0 表示结尾完整）
function incompleteTailLength(buf) {
  const len = buf.length
  // UTF-8 最长 4 字节，只需往回看最多 3 个字节找起始字节
  for (let i = 1; i <= Math.min(3, len); i++) {
    const byte = buf[len - i]
    if ((byte & 0xc0) === 0x80) {
      continue // 续字节，继续往前找
    }
    let need = 1
    if ((byte & 0xe0) === 0xc0) {
      need = 2
    } else if ((byte & 0xf0) === 0xe0) {
      need = 3
    } else if ((byte & 0xf8) === 0xf0) {
      need = 4
    }
    return need > i ? i : 0
  }
  return 0
}

function hex(buf) {
  return buf.toString('hex').replace(/(..)/g, '$1 ').trim()
}

function createUtf8StreamProbe(logger, context = {}) {
  let pendingTail = null
  let prevChunkTail = Buffer.alloc(0)

  return function inspect(chunk) {
    try {
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
        return
      }

      if (pendingTail) {
        logger.warn('🔤 [UTF8-PROBE] split: 多字节字符被切在两个数据块之间，逐块解码会产生乱码', {
          ...context,
          prevTailHex: hex(pendingTail.bytes),
          nextHeadHex: hex(chunk.subarray(0, 4)),
          joined: Buffer.concat([pendingTail.bytes, chunk.subarray(0, 4)]).toString('utf8'),
          before: pendingTail.textBefore,
          after: chunk.subarray(0, 60).toString('utf8')
        })
        pendingTail = null
      }

      // 跨块拼接上一块末尾 2 字节，避免 EF BF BD 本身被切开时漏检
      const scan = Buffer.concat([prevChunkTail, chunk])
      const idx = scan.indexOf(REPLACEMENT_BYTES)
      if (idx !== -1) {
        logger.warn('🔤 [UTF8-PROBE] upstream_fffd: 上游原始字节里已经含有 U+FFFD', {
          ...context,
          around: scan.subarray(Math.max(0, idx - 60), idx + 30).toString('utf8'),
          aroundHex: hex(scan.subarray(Math.max(0, idx - 9), idx + 12))
        })
      }
      prevChunkTail = chunk.subarray(Math.max(0, chunk.length - 2))

      const tailLen = incompleteTailLength(chunk)
      if (tailLen > 0) {
        pendingTail = {
          bytes: Buffer.from(chunk.subarray(chunk.length - tailLen)),
          textBefore: chunk
            .subarray(Math.max(0, chunk.length - tailLen - 60), chunk.length - tailLen)
            .toString('utf8')
        }
      }
    } catch (err) {
      logger.debug('UTF8-PROBE error:', err.message)
    }
  }
}

module.exports = { incompleteTailLength, createUtf8StreamProbe }
