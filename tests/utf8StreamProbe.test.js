const { incompleteTailLength, createUtf8StreamProbe } = require('../src/utils/utf8StreamProbe')

const makeLogger = () => ({ warn: jest.fn(), debug: jest.fn() })

describe('utf8StreamProbe', () => {
  const duo = Buffer.from('多', 'utf8') // e5 a4 9a

  test('incompleteTailLength', () => {
    expect(incompleteTailLength(Buffer.from('abc'))).toBe(0)
    expect(incompleteTailLength(Buffer.from('有点多'))).toBe(0)
    expect(incompleteTailLength(Buffer.concat([Buffer.from('有点'), duo.subarray(0, 1)]))).toBe(1)
    expect(incompleteTailLength(Buffer.concat([Buffer.from('有点'), duo.subarray(0, 2)]))).toBe(2)
    expect(incompleteTailLength(Buffer.from('😂').subarray(0, 3))).toBe(3)
    expect(incompleteTailLength(Buffer.alloc(0))).toBe(0)
  })

  test('split 块：记录 split，不误报 upstream_fffd', () => {
    const logger = makeLogger()
    const probe = createUtf8StreamProbe(logger, { accountId: 'a' })
    const full = Buffer.from('data: {"text":"硬糖吃得有点多，一天"}\n')
    const cut = full.indexOf(duo) + 1
    probe(full.subarray(0, cut))
    probe(full.subarray(cut))
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('split')
    expect(logger.warn.mock.calls[0][1].joined).toContain('多')
  })

  test('完整块：不记录', () => {
    const logger = makeLogger()
    const probe = createUtf8StreamProbe(logger)
    probe(Buffer.from('data: {"text":"秋日西湖"}\n'))
    probe(Buffer.from('data: {"text":"桂花"}\n'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('上游自带 U+FFFD：记录 upstream_fffd（含跨块）', () => {
    const logger = makeLogger()
    const probe = createUtf8StreamProbe(logger)
    const bad = Buffer.from('有点���，一天')
    const i = bad.indexOf(Buffer.from([0xef, 0xbf, 0xbd])) + 1
    probe(bad.subarray(0, i))
    probe(bad.subarray(i))
    const kinds = logger.warn.mock.calls.map((c) => c[0])
    expect(kinds.some((k) => k.includes('upstream_fffd'))).toBe(true)
  })
})

describe('StringDecoder 修复', () => {
  test('被切开的汉字逐块解码后不再乱码', () => {
    const { StringDecoder } = require('string_decoder')
    const full = Buffer.from('然后登记文档')
    const cut = full.indexOf(Buffer.from('后')) + 1
    const naive = full.subarray(0, cut).toString() + full.subarray(cut).toString()
    expect(naive).toContain('�')
    const d = new StringDecoder('utf8')
    expect(d.write(full.subarray(0, cut)) + d.write(full.subarray(cut))).toBe('然后登记文档')
  })
})
