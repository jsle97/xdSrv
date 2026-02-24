import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import { Writable } from 'node:stream'
import {
  xdSrv, xdLRU, xdRedis, xdCookie, xdValidate, xdEventBus, xdWebSocket,
  escapeAny, safeText, safeAttr, safeUrlAttr,
  safeJsonStringify, safeJsonParse,
  createLogger, createAppError,
  createSecurityHeaders, createCsrfProtection, createCompressionMiddleware,
  createRateLimiter, createCorsMiddleware, createIdempotencyMiddleware,
  createHealthCheck, createGracefulShutdown, createRequestTimeout,
  createStaticFileServer,
  encryptAES256GCM, decryptAES256GCM,
  signData, verifySignature,
  generateRequestId, generateSessionId, generateContentEtag,
  errorHandler, cors, rateLimiterMiddleware,
  ERROR_CODES, LOG_LEVELS, REQUEST_METHODS, WS_READY_STATES, WS_OPCODES, DEFAULT_MIME_TYPES,
  requestContext, getRequestContext, getRequestId
} from './xdSrv.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const getFreePort = () =>
  new Promise(resolve => {
    const s = net.createServer()
    s.listen(0, () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })

const request = (port, method, path, body, extraHeaders = {}) =>
  new Promise((resolve, reject) => {
    const headers = { ...extraHeaders }
    if (body) headers['content-type'] = 'application/json'
    const opts = { hostname: '127.0.0.1', port, method, path, headers }
    const req = http.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let json
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })

// ==================== xdLRU ====================
describe('xdLRU', () => {
  it('basic CRUD', () => {
    const cache = xdLRU({ max: 10 })
    assert.strictEqual(cache.set('a', 1), true)
    assert.strictEqual(cache.get('a'), 1)
    assert.strictEqual(cache.has('a'), true)
    assert.strictEqual(cache.delete('a'), true)
    assert.strictEqual(cache.get('a'), undefined)
    assert.strictEqual(cache.has('a'), false)
    assert.strictEqual(cache.delete('a'), false)
  })

  it('max size eviction', () => {
    const cache = xdLRU({ max: 3 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)
    assert.strictEqual(cache.has('a'), false)
    assert.strictEqual(cache.get('b'), 2)
  })

  it('TTL expiration', async () => {
    const cache = xdLRU({ max: 10, ttl: 50 })
    cache.set('k', 'v')
    assert.strictEqual(cache.get('k'), 'v')
    await sleep(80)
    assert.strictEqual(cache.get('k'), undefined)
  })

  it('stats() returns correct shape', () => {
    const cache = xdLRU({ max: 10, stats: true })
    cache.set('a', 1)
    cache.get('a')
    cache.get('miss')
    const s = cache.stats()
    assert.strictEqual(typeof s.hits, 'number')
    assert.strictEqual(typeof s.misses, 'number')
    assert.strictEqual(typeof s.ratio, 'string')
    assert.strictEqual(typeof s.size, 'number')
    assert.strictEqual(s.maxSize, 10)
    assert.strictEqual(s.hits, 1)
    assert.strictEqual(s.misses, 1)
  })

  it('set returns true, delete returns boolean', () => {
    const cache = xdLRU({ max: 5 })
    assert.strictEqual(cache.set('x', 1), true)
    assert.strictEqual(cache.delete('x'), true)
    assert.strictEqual(cache.delete('x'), false)
  })

  it('clear resets everything', () => {
    const cache = xdLRU({ max: 5 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    assert.strictEqual(cache.size(), 0)
  })
})

// ==================== xdRedis ====================
describe('xdRedis', () => {
  let r
  beforeEach(() => { r = xdRedis({ max: 1000 }) })

  describe('String operations', () => {
    it('set/get', () => {
      assert.strictEqual(r.set('k', 'v'), 'OK')
      assert.strictEqual(r.get('k'), 'v')
    })
    it('incr/decr', () => {
      r.set('n', '5')
      assert.strictEqual(r.incr('n'), 6)
      assert.strictEqual(r.decr('n'), 5)
    })
    it('append', () => {
      r.set('s', 'hello')
      assert.strictEqual(r.append('s', ' world'), 11)
      assert.strictEqual(r.get('s'), 'hello world')
    })
    it('mset/mget', () => {
      r.mset({ a: '1', b: '2' })
      assert.deepStrictEqual(r.mget('a', 'b', 'c'), ['1', '2', null])
    })
    it('setnx', () => {
      assert.strictEqual(r.setnx('nx', 'val'), 1)
      assert.strictEqual(r.setnx('nx', 'val2'), 0)
      assert.strictEqual(r.get('nx'), 'val')
    })
    it('getset', () => {
      r.set('gs', 'old')
      assert.strictEqual(r.getset('gs', 'new'), 'old')
      assert.strictEqual(r.get('gs'), 'new')
    })
    it('incrby/decrby', () => {
      r.set('ib', '10')
      assert.strictEqual(r.incrby('ib', 5), 15)
      assert.strictEqual(r.decrby('ib', 3), 12)
    })
    it('incr on non-existent key', () => {
      assert.strictEqual(r.incr('fresh'), 1)
    })
  })

  describe('List operations', () => {
    it('lpush/rpush/lpop/rpop/lrange', () => {
      r.lpush('list', 'a')
      r.rpush('list', 'b')
      r.lpush('list', 'c')
      assert.deepStrictEqual(r.lrange('list', 0, -1), ['c', 'a', 'b'])
      assert.strictEqual(r.lpop('list'), 'c')
      assert.strictEqual(r.rpop('list'), 'b')
    })
    it('llen/lindex', () => {
      r.rpush('li', 'x', 'y', 'z')
      assert.strictEqual(r.llen('li'), 3)
      assert.strictEqual(r.lindex('li', 0), 'x')
      assert.strictEqual(r.lindex('li', -1), 'z')
    })
    it('lpop/rpop on empty returns null', () => {
      assert.strictEqual(r.lpop('empty'), null)
      assert.strictEqual(r.rpop('empty'), null)
    })
  })

  describe('Hash operations', () => {
    it('hset/hget/hdel/hkeys/hgetall', () => {
      assert.strictEqual(r.hset('h', 'f1', 'v1'), 1)
      assert.strictEqual(r.hset('h', 'f1', 'v2'), 0)
      assert.strictEqual(r.hget('h', 'f1'), 'v2')
      r.hset('h', 'f2', 'v3')
      assert.deepStrictEqual(r.hkeys('h').sort(), ['f1', 'f2'])
      const all = r.hgetall('h')
      assert.strictEqual(all.f1, 'v2')
      assert.strictEqual(r.hdel('h', 'f1'), 1)
      assert.strictEqual(r.hget('h', 'f1'), null)
    })
    it('hvals/hlen/hexists', () => {
      r.hset('hv', 'a', '1')
      r.hset('hv', 'b', '2')
      assert.strictEqual(r.hlen('hv'), 2)
      assert.strictEqual(r.hexists('hv', 'a'), 1)
      assert.strictEqual(r.hexists('hv', 'c'), 0)
      assert.deepStrictEqual(r.hvals('hv').sort(), ['1', '2'])
    })
    it('hmset/hincrby', () => {
      r.hmset('hm', { x: '10', y: '20' })
      assert.strictEqual(r.hget('hm', 'x'), '10')
      assert.strictEqual(r.hincrby('hm', 'x', 5), 15)
    })
  })

  describe('Set operations', () => {
    it('sadd/srem/smembers/sismember', () => {
      assert.strictEqual(r.sadd('s', 'a', 'b', 'c'), 3)
      assert.strictEqual(r.sismember('s', 'a'), 1)
      assert.strictEqual(r.sismember('s', 'z'), 0)
      assert.strictEqual(r.srem('s', 'a'), 1)
      assert.strictEqual(r.srem('s', 'a'), 0)
      assert.ok(!r.smembers('s').includes('a'))
    })
    it('scard/srandmember', () => {
      r.sadd('sc', 'x', 'y')
      assert.strictEqual(r.scard('sc'), 2)
      const rand = r.srandmember('sc')
      assert.ok(['x', 'y'].includes(rand))
    })
    it('sunion/sinter', () => {
      r.sadd('s1', 'a', 'b')
      r.sadd('s2', 'b', 'c')
      const union = r.sunion('s1', 's2').sort()
      assert.deepStrictEqual(union, ['a', 'b', 'c'])
      const inter = r.sinter('s1', 's2')
      assert.deepStrictEqual(inter, ['b'])
    })
  })

  describe('Key operations', () => {
    it('exists/del/keys/ttl/expire', () => {
      r.set('ek', 'val')
      assert.strictEqual(r.exists('ek'), true)
      assert.strictEqual(r.del('ek'), true)
      assert.strictEqual(r.exists('ek'), false)

      r.set('ek2', 'v')
      assert.strictEqual(r.ttl('ek2'), -1)
      r.expire('ek2', 10)
      assert.ok(r.ttl('ek2') > 0)

      r.set('ab', '1')
      r.set('ac', '2')
      const found = r.keys('a*').sort()
      assert.deepStrictEqual(found, ['ab', 'ac'])
    })
    it('flushAll/dbsize', () => {
      r.set('a', '1')
      r.set('b', '2')
      assert.strictEqual(r.dbsize(), 2)
      assert.strictEqual(r.flushAll(), 'OK')
      assert.strictEqual(r.dbsize(), 0)
    })
    it('persist/rename/type', () => {
      r.set('pk', 'val', { ttl: 10 })
      r.persist('pk')
      assert.strictEqual(r.ttl('pk'), -1)

      r.set('rk', 'val')
      r.rename('rk', 'rk2')
      assert.strictEqual(r.get('rk2'), 'val')
      assert.strictEqual(r.exists('rk'), false)

      r.set('tk', 'val')
      assert.strictEqual(r.type('tk'), 'string')
      r.lpush('tl', 'a')
      assert.strictEqual(r.type('tl'), 'list')
      assert.strictEqual(r.type('none'), 'none')
    })
    it('rename throws for non-existent key', () => {
      assert.throws(() => r.rename('nope', 'x'), /no such key/)
    })
  })

  describe('createRedisQueue', () => {
    it('creates queue with enqueue/stop', async () => {
      const results = []
      const q = r.createRedisQueue('q1', async (task) => { results.push(task) }, { pollInterval: 50 })
      q.enqueue({ id: 1 })
      q.enqueue({ id: 2 })
      await sleep(200)
      q.stop()
      assert.strictEqual(results.length, 2)
      assert.strictEqual(q.isRunning, false)
    })
  })
})

// ==================== xdCookie ====================
describe('xdCookie', () => {
  it('parse', () => {
    const cookies = xdCookie.parse('foo=bar; baz=qux')
    assert.strictEqual(cookies.foo, 'bar')
    assert.strictEqual(cookies.baz, 'qux')
  })

  it('parse empty', () => {
    const cookies = xdCookie.parse('')
    assert.deepStrictEqual(cookies, Object.create(null))
  })

  it('serialize', () => {
    const str = xdCookie.serialize('name', 'value', { httpOnly: true, path: '/' })
    assert.ok(str.includes('name=value'))
    assert.ok(str.includes('HttpOnly'))
    assert.ok(str.includes('Path=/'))
  })

  it('set/get/has', () => {
    const cookies = xdCookie.parse('test=123')
    assert.strictEqual(xdCookie.get(cookies, 'test'), '123')
    assert.strictEqual(xdCookie.has(cookies, 'test'), true)
    assert.strictEqual(xdCookie.has(cookies, 'nope'), false)
  })

  it('set/setAll/clear on response mock', () => {
    const hdrs = {}
    const res = {
      getHeader: k => hdrs[k],
      setHeader: (k, v) => { hdrs[k] = v }
    }
    xdCookie.set(res, 'a', '1')
    assert.ok(Array.isArray(hdrs['Set-Cookie']))
    xdCookie.setAll(res, { b: '2', c: '3' })
    assert.ok(hdrs['Set-Cookie'].length >= 3)
    xdCookie.clear(res, 'a')
  })

  it('setEncrypted / getEncrypted', () => {
    const secret = 'test-secret-key-123'
    const hdrs = {}
    const res = {
      getHeader: k => hdrs[k],
      setHeader: (k, v) => { hdrs[k] = v }
    }
    xdCookie.setEncrypted(res, 'enc', 'secret-data', secret)
    const setCookieArr = hdrs['Set-Cookie']
    const cookieStr = setCookieArr[setCookieArr.length - 1]
    const parsed = xdCookie.parse(cookieStr)
    const decrypted = xdCookie.getEncrypted(parsed, 'enc', secret)
    assert.strictEqual(decrypted, 'secret-data')
  })

  it('getEncrypted returns null for missing cookie', () => {
    const cookies = xdCookie.parse('')
    assert.strictEqual(xdCookie.getEncrypted(cookies, 'missing', 'secret'), null)
  })
})

// ==================== Encryption ====================
describe('Encryption', () => {
  it('encryptAES256GCM / decryptAES256GCM roundtrip', () => {
    const secret = 'my-secret'
    const cipher = encryptAES256GCM('hello world', secret)
    assert.strictEqual(typeof cipher, 'string')
    assert.strictEqual(cipher.split('.').length, 3)
    const plain = decryptAES256GCM(cipher, secret)
    assert.strictEqual(plain, 'hello world')
  })

  it('decryptAES256GCM returns null for invalid data', () => {
    assert.strictEqual(decryptAES256GCM('invalid', 'key'), null)
    assert.strictEqual(decryptAES256GCM('a.b.c', 'key'), null)
  })

  it('signData / verifySignature', () => {
    const sig = signData('payload', 'secret')
    assert.strictEqual(typeof sig, 'string')
    assert.strictEqual(verifySignature('payload', sig, 'secret'), true)
    assert.strictEqual(verifySignature('tampered', sig, 'secret'), false)
  })
})

// ==================== Escaping ====================
describe('Escaping', () => {
  it('safeText escapes HTML', () => {
    const result = safeText('<script>alert("xss")</script>')
    assert.ok(!result.includes('<script>'))
    assert.ok(result.includes('&lt;'))
  })

  it('safeAttr escapes attribute values', () => {
    const result = safeAttr('class', '" onclick="alert(1)')
    assert.ok(result.startsWith('class="'))
    assert.ok(result.includes('&quot;'))
  })

  it('safeUrlAttr blocks javascript protocol', () => {
    const result = safeUrlAttr('href', 'javascript:alert(1)')
    assert.ok(result.includes('about:blank'))
  })

  it('safeUrlAttr allows http(s)', () => {
    const result = safeUrlAttr('href', 'https://example.com')
    assert.ok(result.includes('https://example.com'))
  })

  it('escapeAny handles all contexts', () => {
    assert.strictEqual(typeof escapeAny('<b>bold</b>'), 'string')
    assert.ok(escapeAny('<b>', { context: 'htmlContent' }).includes('&lt;'))
    assert.strictEqual(typeof escapeAny('test', { context: 'jsString' }), 'string')
    assert.strictEqual(typeof escapeAny('test', { context: 'urlComponent' }), 'string')
  })

  it('escapeAny with null/undefined', () => {
    assert.strictEqual(escapeAny(null), '')
    assert.strictEqual(escapeAny(undefined), '')
  })
})

// ==================== safeJsonStringify / safeJsonParse ====================
describe('safeJsonStringify / safeJsonParse', () => {
  it('handles circular references', () => {
    const obj = { a: 1 }
    obj.self = obj
    const result = safeJsonStringify(obj)
    assert.ok(result.includes('[Circular]'))
  })

  it('handles bigint', () => {
    const result = safeJsonStringify({ n: BigInt(123) })
    assert.ok(result.includes('123'))
  })

  it('safeJsonParse returns null for invalid JSON', () => {
    assert.strictEqual(safeJsonParse('not json'), null)
    assert.strictEqual(safeJsonParse(''), null)
    assert.strictEqual(safeJsonParse(123), null)
  })

  it('safeJsonParse parses valid JSON', () => {
    assert.deepStrictEqual(safeJsonParse('{"a":1}'), { a: 1 })
  })
})

// ==================== createLogger ====================
describe('createLogger', () => {
  it('creates logger with all methods', () => {
    const logger = createLogger({ level: 'TRACE' })
    assert.strictEqual(typeof logger.trace, 'function')
    assert.strictEqual(typeof logger.debug, 'function')
    assert.strictEqual(typeof logger.info, 'function')
    assert.strictEqual(typeof logger.warn, 'function')
    assert.strictEqual(typeof logger.error, 'function')
    assert.strictEqual(typeof logger.fatal, 'function')
  })

  it('respects log level filtering', () => {
    let written = ''
    const output = new Writable({ write(chunk, _, cb) { written += chunk.toString(); cb() } })
    const logger = createLogger({ level: 'ERROR', format: 'json', output })
    logger.info('should not appear')
    logger.error('should appear')
    assert.ok(!written.includes('should not appear'))
    assert.ok(written.includes('should appear'))
  })

  it('redacts sensitive keys', () => {
    let written = ''
    const output = new Writable({ write(chunk, _, cb) { written += chunk.toString(); cb() } })
    const logger = createLogger({ level: 'INFO', format: 'json', output })
    logger.info('test', { password: '123', user: 'bob' })
    assert.ok(written.includes('[REDACTED]'))
    assert.ok(written.includes('bob'))
  })

  it('child() creates child logger', () => {
    let written = ''
    const output = new Writable({ write(chunk, _, cb) { written += chunk.toString(); cb() } })
    const logger = createLogger({ level: 'INFO', format: 'json', output })
    const child = logger.child({ service: 'test-svc' })
    child.info('from child')
    assert.ok(written.includes('test-svc'))
  })

  it('text and json formats', () => {
    let text = ''
    const textOut = new Writable({ write(chunk, _, cb) { text += chunk.toString(); cb() } })
    const tl = createLogger({ level: 'INFO', format: 'text', output: textOut })
    tl.info('msg')
    assert.ok(text.includes('INFO'))
    assert.ok(text.includes('msg'))

    let json = ''
    const jsonOut = new Writable({ write(chunk, _, cb) { json += chunk.toString(); cb() } })
    const jl = createLogger({ level: 'INFO', format: 'json', output: jsonOut })
    jl.info('msg2')
    const parsed = JSON.parse(json.trim())
    assert.strictEqual(parsed.message, 'msg2')
    assert.strictEqual(parsed.level, 'INFO')
  })
})

// ==================== createAppError ====================
describe('createAppError', () => {
  it('creates error with status, code, details', () => {
    const err = createAppError('NOT_FOUND', { details: { id: 1 } })
    assert.strictEqual(err.status, 404)
    assert.strictEqual(err.code, 'NOT_FOUND')
    assert.deepStrictEqual(err.details, { id: 1 })
    assert.ok(err instanceof Error)
  })

  it('uses ERROR_CODES templates', () => {
    const err = createAppError('BAD_REQUEST')
    assert.strictEqual(err.status, 400)
    assert.strictEqual(err.message, 'Bad Request')
  })

  it('falls back to INTERNAL for unknown code', () => {
    const err = createAppError('UNKNOWN_CODE')
    assert.strictEqual(err.status, 500)
  })
})

// ==================== xdValidate ====================
describe('xdValidate', () => {
  it('validates required', () => {
    const result = xdValidate.validate({}, { name: { required: true } })
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some(e => e.includes('required')))
  })

  it('validates string type', () => {
    const result = xdValidate.validate({ name: 123 }, { name: { type: 'string' } })
    assert.strictEqual(result.valid, false)
  })

  it('validates number type', () => {
    const result = xdValidate.validate({ age: 'abc' }, { age: { type: 'number' } })
    assert.strictEqual(result.valid, false)
  })

  it('validates email', () => {
    const good = xdValidate.validate({ e: 'a@b.com' }, { e: { type: 'email' } })
    assert.strictEqual(good.valid, true)
    const bad = xdValidate.validate({ e: 'not-email' }, { e: { type: 'email' } })
    assert.strictEqual(bad.valid, false)
  })

  it('validates url', () => {
    const good = xdValidate.validate({ u: 'https://example.com' }, { u: { type: 'url' } })
    assert.strictEqual(good.valid, true)
    const bad = xdValidate.validate({ u: 'not a url' }, { u: { type: 'url' } })
    assert.strictEqual(bad.valid, false)
  })

  it('validates uuid', () => {
    const good = xdValidate.validate({ id: '550e8400-e29b-41d4-a716-446655440000' }, { id: { type: 'uuid' } })
    assert.strictEqual(good.valid, true)
    const bad = xdValidate.validate({ id: 'not-uuid' }, { id: { type: 'uuid' } })
    assert.strictEqual(bad.valid, false)
  })

  it('validates minLength/maxLength', () => {
    const short = xdValidate.validate({ s: 'ab' }, { s: { minLength: 3 } })
    assert.strictEqual(short.valid, false)
    const long = xdValidate.validate({ s: 'abcdef' }, { s: { maxLength: 3 } })
    assert.strictEqual(long.valid, false)
    const ok = xdValidate.validate({ s: 'abc' }, { s: { minLength: 2, maxLength: 5 } })
    assert.strictEqual(ok.valid, true)
  })

  it('validates min/max', () => {
    const low = xdValidate.validate({ n: 2 }, { n: { min: 5 } })
    assert.strictEqual(low.valid, false)
    const high = xdValidate.validate({ n: 20 }, { n: { max: 10 } })
    assert.strictEqual(high.valid, false)
  })

  it('validates pattern', () => {
    const good = xdValidate.validate({ c: 'ABC' }, { c: { pattern: /^[A-Z]+$/ } })
    assert.strictEqual(good.valid, true)
    const bad = xdValidate.validate({ c: 'abc' }, { c: { pattern: /^[A-Z]+$/ } })
    assert.strictEqual(bad.valid, false)
  })

  it('validates oneOf', () => {
    const good = xdValidate.validate({ r: 'admin' }, { r: { oneOf: ['admin', 'user'] } })
    assert.strictEqual(good.valid, true)
    const bad = xdValidate.validate({ r: 'root' }, { r: { oneOf: ['admin', 'user'] } })
    assert.strictEqual(bad.valid, false)
  })

  it('validates with custom validator', () => {
    const result = xdValidate.validate({ v: 'abc' }, {
      v: { custom: (val) => val.startsWith('a') ? true : 'must start with a' }
    })
    assert.strictEqual(result.valid, true)

    const fail = xdValidate.validate({ v: 'xyz' }, {
      v: { custom: (val) => val.startsWith('a') ? true : 'must start with a' }
    })
    assert.strictEqual(fail.valid, false)
  })

  it('validates with sanitize function', () => {
    const result = xdValidate.validate({ s: '  hello  ' }, {
      s: { sanitize: v => v.trim() }
    })
    assert.strictEqual(result.valid, true)
    assert.strictEqual(result.data.s, 'hello')
  })

  it('returns {valid, errors, data}', () => {
    const result = xdValidate.validate({ n: 'test' }, { n: { type: 'string' } })
    assert.strictEqual(typeof result.valid, 'boolean')
    assert.ok(Array.isArray(result.errors))
    assert.strictEqual(typeof result.data, 'object')
  })
})

// ==================== xdEventBus ====================
describe('xdEventBus', () => {
  it('subscribe/publish', async () => {
    const bus = xdEventBus()
    let received = null
    bus.subscribe('test', (envelope) => { received = envelope.data })
    bus.publish('test', { msg: 'hi' })
    await sleep(10)
    assert.deepStrictEqual(received, { msg: 'hi' })
  })

  it('unsubscribe', async () => {
    const bus = xdEventBus()
    let count = 0
    const id = bus.subscribe('ev', () => { count++ })
    bus.publish('ev', {})
    await sleep(10)
    assert.strictEqual(count, 1)
    bus.unsubscribe(id)
    bus.publish('ev', {})
    await sleep(10)
    assert.strictEqual(count, 1)
  })

  it('once handler', async () => {
    const bus = xdEventBus()
    let count = 0
    bus.once('once-ev', () => { count++ })
    bus.publish('once-ev', {})
    bus.publish('once-ev', {})
    await sleep(20)
    assert.strictEqual(count, 1)
  })

  it('wildcard * event', async () => {
    const bus = xdEventBus()
    let received = null
    bus.subscribe('*', (envelope) => { received = envelope.event })
    bus.publish('custom', {})
    await sleep(10)
    assert.strictEqual(received, 'custom')
  })

  it('clear()', () => {
    const bus = xdEventBus()
    bus.subscribe('a', () => {})
    bus.subscribe('b', () => {})
    bus.clear()
    assert.strictEqual(bus.listenerCount, 0)
  })

  it('clear(event) clears specific event', () => {
    const bus = xdEventBus()
    bus.subscribe('a', () => {})
    const bId = bus.subscribe('b', () => {})
    bus.clear('a')
    assert.strictEqual(bus.listenerCount, 1)
  })

  it('listenerCount', () => {
    const bus = xdEventBus()
    bus.subscribe('x', () => {})
    bus.subscribe('y', () => {})
    assert.strictEqual(bus.listenerCount, 2)
  })
})

// ==================== createSecurityHeaders ====================
describe('createSecurityHeaders', () => {
  it('default headers', () => {
    const sh = createSecurityHeaders()
    assert.ok(sh.headers['x-frame-options'])
    assert.ok(sh.headers['referrer-policy'])
    assert.ok(sh.headers['x-content-type-options'])
  })

  it('custom options', () => {
    const sh = createSecurityHeaders({ frameOptions: 'DENY', referrerPolicy: 'no-referrer' })
    assert.strictEqual(sh.headers['x-frame-options'], 'DENY')
    assert.strictEqual(sh.headers['referrer-policy'], 'no-referrer')
  })

  it('HSTS header', () => {
    const sh = createSecurityHeaders({ hsts: { maxAge: 31536000, includeSubDomains: true, preload: true } })
    const hsts = sh.headers['strict-transport-security']
    assert.ok(hsts.includes('max-age=31536000'))
    assert.ok(hsts.includes('includeSubDomains'))
    assert.ok(hsts.includes('preload'))
  })

  it('CSP header', () => {
    const sh = createSecurityHeaders({ csp: { 'default-src': "'self'", 'script-src': "'none'" } })
    assert.ok(sh.headers['content-security-policy'].includes("default-src 'self'"))
  })

  it('apply() method', () => {
    const sh = createSecurityHeaders()
    const hdrs = {}
    const res = { setHeader: (k, v) => { hdrs[k] = v } }
    sh.apply(res)
    assert.ok(hdrs['x-frame-options'])
  })

  it('middleware() function', () => {
    const sh = createSecurityHeaders()
    const hdrs = {}
    const res = { setHeader: (k, v) => { hdrs[k] = v } }
    let called = false
    sh.middleware({}, res, () => { called = true })
    assert.ok(called)
    assert.ok(hdrs['x-frame-options'])
  })
})

// ==================== createCsrfProtection ====================
describe('createCsrfProtection', () => {
  it('generateToken / verifyToken', () => {
    const csrf = createCsrfProtection({ secret: 'test-secret' })
    const token = csrf.generateToken()
    assert.strictEqual(typeof token, 'string')
    assert.ok(token.includes('.'))
    assert.strictEqual(csrf.verifyToken(token), true)
    assert.strictEqual(csrf.verifyToken('invalid'), false)
  })

  it('middleware allows safe methods', () => {
    const csrf = createCsrfProtection({ secret: 'test' })
    let nextCalled = false
    csrf.middleware(
      { method: 'GET', headers: {}, cookies: {}, query: {} },
      {
        status: () => ({ json: () => {} }),
        getHeader: () => undefined,
        setHeader: () => {}
      },
      () => { nextCalled = true }
    )
    assert.ok(nextCalled)
  })

  it('middleware blocks unsafe methods without token', () => {
    const csrf = createCsrfProtection({ secret: 'test' })
    let blocked = false
    csrf.middleware(
      { method: 'POST', headers: {}, cookies: {}, query: {}, body: {} },
      {
        status: () => ({ json: () => { blocked = true } }),
        getHeader: () => undefined,
        setHeader: () => {}
      },
      () => {}
    )
    assert.ok(blocked)
  })
})

// ==================== createCompressionMiddleware ====================
describe('createCompressionMiddleware', () => {
  it('creates callable middleware', () => {
    const mw = createCompressionMiddleware()
    assert.strictEqual(typeof mw, 'function')
  })
})

// ==================== createRateLimiter ====================
describe('createRateLimiter', () => {
  it('sliding window allows requests within limit', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 5 })
    const hdrs = {}
    const res = {
      setHeader: (k, v) => { hdrs[k] = v },
      status: () => ({ json: () => {} })
    }
    let passed = 0
    for (let i = 0; i < 5; i++) {
      limiter({ ip: '1.2.3.4' }, { ...res, setHeader: (k, v) => { hdrs[k] = v } }, () => { passed++ })
    }
    assert.strictEqual(passed, 5)
  })

  it('sliding window blocks when exceeded', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 2 })
    let blocked = false
    const makeRes = () => ({
      setHeader: () => {},
      status: (code) => {
        if (code === 429) blocked = true
        return { json: () => {} }
      }
    })
    limiter({ ip: 'a' }, makeRes(), () => {})
    limiter({ ip: 'a' }, makeRes(), () => {})
    limiter({ ip: 'a' }, makeRes(), () => {})
    assert.ok(blocked)
  })

  it('token bucket algorithm', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 3, algorithm: 'token-bucket' })
    let passed = 0
    const res = { setHeader: () => {}, status: () => ({ json: () => {} }) }
    for (let i = 0; i < 3; i++) {
      limiter({ ip: 'tb' }, { ...res }, () => { passed++ })
    }
    assert.strictEqual(passed, 3)
  })

  it('skip function', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, skip: (req) => req.skipMe })
    let passed = 0
    const res = { setHeader: () => {}, status: () => ({ json: () => {} }) }
    limiter({ ip: 'x', skipMe: true }, res, () => { passed++ })
    limiter({ ip: 'x', skipMe: true }, res, () => { passed++ })
    assert.strictEqual(passed, 2)
  })

  it('custom keyGenerator', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, keyGenerator: (req) => req.userId })
    let passed = 0
    const res = { setHeader: () => {}, status: () => ({ json: () => {} }) }
    limiter({ userId: 'u1' }, res, () => { passed++ })
    limiter({ userId: 'u2' }, res, () => { passed++ })
    assert.strictEqual(passed, 2)
  })
})

// ==================== createCorsMiddleware ====================
describe('createCorsMiddleware', () => {
  it('sets CORS headers', () => {
    const mw = createCorsMiddleware()
    const hdrs = {}
    const res = {
      setHeader: (k, v) => { hdrs[k] = v },
      getHeader: (k) => hdrs[k],
      statusCode: 200,
      end: () => {}
    }
    let nextCalled = false
    mw({ headers: { origin: 'http://example.com' }, method: 'GET' }, res, () => { nextCalled = true })
    assert.ok(nextCalled)
    assert.ok(hdrs['access-control-allow-origin'])
  })

  it('OPTIONS returns 204', () => {
    const mw = createCorsMiddleware()
    const hdrs = {}
    const res = {
      setHeader: (k, v) => { hdrs[k] = v },
      getHeader: (k) => hdrs[k],
      statusCode: 200,
      end: () => {}
    }
    mw({ headers: { origin: 'http://example.com' }, method: 'OPTIONS' }, res, () => {})
    assert.strictEqual(res.statusCode, 204)
  })

  it('origin whitelist', () => {
    const mw = createCorsMiddleware({ origin: ['http://a.com', 'http://b.com'] })
    const hdrs = {}
    const res = {
      setHeader: (k, v) => { hdrs[k] = v },
      getHeader: (k) => hdrs[k],
      end: () => {}
    }
    let nextCalled = false
    mw({ headers: { origin: 'http://a.com' }, method: 'GET' }, res, () => { nextCalled = true })
    assert.ok(nextCalled)
    assert.strictEqual(hdrs['access-control-allow-origin'], 'http://a.com')
  })

  it('credentials support', () => {
    const mw = createCorsMiddleware({ credentials: true })
    const hdrs = {}
    const res = {
      setHeader: (k, v) => { hdrs[k] = v },
      getHeader: (k) => hdrs[k],
      end: () => {}
    }
    mw({ headers: { origin: 'http://example.com' }, method: 'GET' }, res, () => {})
    assert.strictEqual(hdrs['access-control-allow-credentials'], 'true')
  })
})

// ==================== createIdempotencyMiddleware ====================
describe('createIdempotencyMiddleware', () => {
  it('creates middleware function', () => {
    const mw = createIdempotencyMiddleware()
    assert.strictEqual(typeof mw, 'function')
  })
})

// ==================== createHealthCheck ====================
describe('createHealthCheck', () => {
  it('creates health check with handler', () => {
    const hc = createHealthCheck()
    assert.strictEqual(typeof hc.handler, 'function')
    assert.strictEqual(hc.path, '/health')
  })

  it('addCheck / removeCheck', () => {
    const hc = createHealthCheck()
    hc.addCheck('db', () => ({ ok: true }))
    hc.removeCheck('db')
  })

  it('runChecks returns status', async () => {
    const hc = createHealthCheck({ checks: { mem: () => true } })
    const result = await hc.runChecks()
    assert.strictEqual(result.status, 'ok')
    assert.ok(result.timestamp)
    assert.ok(result.checks.mem)
  })

  it('runChecks reports degraded on failure', async () => {
    const hc = createHealthCheck({
      checks: {
        failing: () => { throw new Error('down') }
      }
    })
    const result = await hc.runChecks()
    assert.strictEqual(result.status, 'degraded')
    assert.strictEqual(result.checks.failing.status, 'error')
  })
})

// ==================== Constants ====================
describe('Constants', () => {
  it('ERROR_CODES has expected keys', () => {
    assert.ok(ERROR_CODES.BAD_REQUEST)
    assert.ok(ERROR_CODES.UNAUTHORIZED)
    assert.ok(ERROR_CODES.NOT_FOUND)
    assert.ok(ERROR_CODES.INTERNAL)
    assert.ok(ERROR_CODES.TOO_MANY_REQUESTS)
  })

  it('LOG_LEVELS has expected values', () => {
    assert.strictEqual(LOG_LEVELS.TRACE, 0)
    assert.strictEqual(LOG_LEVELS.DEBUG, 1)
    assert.strictEqual(LOG_LEVELS.INFO, 2)
    assert.strictEqual(LOG_LEVELS.WARN, 3)
    assert.strictEqual(LOG_LEVELS.ERROR, 4)
    assert.strictEqual(LOG_LEVELS.FATAL, 5)
    assert.strictEqual(LOG_LEVELS.SILENT, 6)
  })

  it('REQUEST_METHODS', () => {
    assert.strictEqual(REQUEST_METHODS.GET, 'GET')
    assert.strictEqual(REQUEST_METHODS.POST, 'POST')
    assert.strictEqual(REQUEST_METHODS.DELETE, 'DELETE')
    assert.strictEqual(REQUEST_METHODS.PATCH, 'PATCH')
    assert.strictEqual(REQUEST_METHODS.OPTIONS, 'OPTIONS')
  })

  it('WS_READY_STATES / WS_OPCODES', () => {
    assert.strictEqual(WS_READY_STATES.CONNECTING, 0)
    assert.strictEqual(WS_READY_STATES.OPEN, 1)
    assert.strictEqual(WS_READY_STATES.CLOSING, 2)
    assert.strictEqual(WS_READY_STATES.CLOSED, 3)
    assert.strictEqual(WS_OPCODES.TEXT, 0x1)
    assert.strictEqual(WS_OPCODES.BINARY, 0x2)
    assert.strictEqual(WS_OPCODES.CLOSE, 0x8)
    assert.strictEqual(WS_OPCODES.PING, 0x9)
    assert.strictEqual(WS_OPCODES.PONG, 0xA)
  })

  it('DEFAULT_MIME_TYPES', () => {
    assert.ok(DEFAULT_MIME_TYPES.html.includes('text/html'))
    assert.ok(DEFAULT_MIME_TYPES.css.includes('text/css'))
    assert.ok(DEFAULT_MIME_TYPES.js.includes('javascript'))
    assert.ok(DEFAULT_MIME_TYPES.json.includes('application/json'))
    assert.ok(DEFAULT_MIME_TYPES.png.includes('image/png'))
  })
})

// ==================== Utility functions ====================
describe('Utility functions', () => {
  it('generateRequestId() returns string', () => {
    const id = generateRequestId()
    assert.strictEqual(typeof id, 'string')
    assert.ok(id.length > 0)
  })

  it('generateSessionId() returns string', () => {
    const id = generateSessionId()
    assert.strictEqual(typeof id, 'string')
    assert.ok(id.length > 0)
  })

  it('generateContentEtag() returns string', () => {
    const etag = generateContentEtag('hello world')
    assert.strictEqual(typeof etag, 'string')
    assert.ok(etag.startsWith('"'))
  })

  it('getRequestContext() returns object', () => {
    const ctx = getRequestContext()
    assert.strictEqual(typeof ctx, 'object')
  })

  it('getRequestId() returns null outside context', () => {
    assert.strictEqual(getRequestId(), null)
  })

  it('requestContext.run provides context', () => {
    requestContext.run({ requestId: 'test-123' }, () => {
      assert.strictEqual(getRequestId(), 'test-123')
      const ctx = getRequestContext()
      assert.strictEqual(ctx.requestId, 'test-123')
    })
  })
})

// ==================== HTTP Server (xdSrv.createApp) ====================
describe('HTTP Server (xdSrv.createApp)', () => {
  let app, port

  before(async () => {
    port = await getFreePort()
    app = xdSrv.createApp({
      logs: false,
      spa: false,
      rateLimit: false,
      cors: false,
      gracefulShutdown: false,
      healthCheck: { path: '/health' }
    })

    app.get('/hello', (req, res) => res.json({ msg: 'hello' }))
    app.post('/echo', (req, res) => res.json(req.body))
    app.put('/put', (req, res) => res.json({ method: 'PUT' }))
    app.delete('/del', (req, res) => res.json({ method: 'DELETE' }))
    app.patch('/patch', (req, res) => res.json({ method: 'PATCH' }))
    app.get('/user/:id', (req, res) => res.json({ id: req.params.id }))
    app.get('/query', (req, res) => res.json(req.query))
    app.get('/text', (req, res) => res.html('<h1>Hello</h1>'))
    app.get('/send-str', (req, res) => res.send('plain text'))
    app.get('/redirect', (req, res) => res.redirect('/hello'))

    const authMiddleware = (req, res, next) => {
      req.authed = true
      next()
    }
    app.get('/guarded', authMiddleware, (req, res) => res.json({ authed: req.authed }))

    app.all('/any-method', (req, res) => res.json({ method: req.method }))

    app.get('/protocol', (req, res) => res.json({ protocol: req.protocol, originalUrl: req.originalUrl }))

    app.get('/set-cookie', (req, res) => {
      res.cookie('test', 'val', { httpOnly: true })
      res.json({ ok: true })
    })
    app.get('/clear-cookie', (req, res) => {
      res.clearCookie('test')
      res.json({ ok: true })
    })

    app.use((req, res, next) => {
      res.setHeader('x-custom', 'middleware')
      next()
    })

    await new Promise(resolve => app.listen(port, resolve))
  })

  after(async () => {
    await new Promise((resolve, reject) => {
      app.server.close(err => err ? reject(err) : resolve())
    })
  })

  it('GET route', async () => {
    const res = await request(port, 'GET', '/hello')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.msg, 'hello')
  })

  it('POST route', async () => {
    const res = await request(port, 'POST', '/echo', { data: 'test' })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.data, 'test')
  })

  it('PUT route', async () => {
    const res = await request(port, 'PUT', '/put', {})
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.method, 'PUT')
  })

  it('DELETE route', async () => {
    const res = await request(port, 'DELETE', '/del')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.method, 'DELETE')
  })

  it('PATCH route', async () => {
    const res = await request(port, 'PATCH', '/patch', {})
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.method, 'PATCH')
  })

  it('route parameters', async () => {
    const res = await request(port, 'GET', '/user/42')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.id, '42')
  })

  it('query string', async () => {
    const res = await request(port, 'GET', '/query?foo=bar&n=1')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.foo, 'bar')
  })

  it('middleware', async () => {
    const res = await request(port, 'GET', '/hello')
    assert.strictEqual(res.headers['x-custom'], 'middleware')
  })

  it('route-level middleware', async () => {
    const res = await request(port, 'GET', '/guarded')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.authed, true)
  })

  it('app.all registers for all methods', async () => {
    const g = await request(port, 'GET', '/any-method')
    assert.strictEqual(g.json.method, 'GET')
    const p = await request(port, 'POST', '/any-method', {})
    assert.strictEqual(p.json.method, 'POST')
  })

  it('app.getRoutes() returns route map', () => {
    const routes = app.getRoutes()
    assert.ok(routes.GET.includes('/hello'))
    assert.ok(routes.POST.includes('/echo'))
    assert.ok(routes.PATCH.includes('/patch'))
  })

  it('res.json', async () => {
    const res = await request(port, 'GET', '/hello')
    assert.ok(res.headers['content-type'].includes('application/json'))
  })

  it('res.html', async () => {
    const res = await request(port, 'GET', '/text')
    assert.ok(res.headers['content-type'].includes('text/html'))
    assert.ok(res.text.includes('<h1>Hello</h1>'))
  })

  it('res.send', async () => {
    const res = await request(port, 'GET', '/send-str')
    assert.ok(res.text.includes('plain text'))
  })

  it('res.redirect', async () => {
    const res = await request(port, 'GET', '/redirect')
    assert.strictEqual(res.status, 302)
    assert.strictEqual(res.headers.location, '/hello')
  })

  it('res.cookie / res.clearCookie', async () => {
    const set = await request(port, 'GET', '/set-cookie')
    assert.ok(set.headers['set-cookie'])
    const clear = await request(port, 'GET', '/clear-cookie')
    assert.ok(clear.headers['set-cookie'])
  })

  it('req.protocol, req.originalUrl', async () => {
    const res = await request(port, 'GET', '/protocol')
    assert.strictEqual(res.json.protocol, 'http')
    assert.strictEqual(res.json.originalUrl, '/protocol')
  })

  it('404 response', async () => {
    const res = await request(port, 'GET', '/nonexistent-route')
    assert.strictEqual(res.status, 404)
  })

  it('health check endpoint', async () => {
    const res = await request(port, 'GET', '/health')
    assert.strictEqual(res.status, 200)
    assert.ok(res.json.status)
    assert.ok(res.json.timestamp)
  })

  it('app.server is accessible', () => {
    assert.ok(app.server)
    assert.strictEqual(typeof app.server.address, 'function')
    assert.strictEqual(app.server.address().port, port)
  })

  it('app.logger exists', () => {
    assert.ok(app.logger)
    assert.strictEqual(typeof app.logger.info, 'function')
  })

  it('app.eventBus exists', () => {
    assert.ok(app.eventBus)
    assert.strictEqual(typeof app.eventBus.publish, 'function')
  })

  it('app.sessionStore exists', () => {
    assert.ok(app.sessionStore)
  })

  it('app.healthCheck exists', () => {
    assert.ok(app.healthCheck)
  })
})

// ==================== CORS via HTTP server ====================
describe('CORS via HTTP', () => {
  let app, port

  before(async () => {
    port = await getFreePort()
    app = xdSrv.createApp({
      logs: false,
      spa: false,
      rateLimit: false,
      cors: true,
      gracefulShutdown: false,
      healthCheck: false
    })
    app.get('/cors-test', (req, res) => res.json({ ok: true }))
    await new Promise(resolve => app.listen(port, resolve))
  })

  after(async () => {
    await new Promise((resolve, reject) => {
      app.server.close(err => err ? reject(err) : resolve())
    })
  })

  it('sets CORS headers on response', async () => {
    const res = await request(port, 'GET', '/cors-test', null, { origin: 'http://example.com' })
    assert.ok(res.headers['access-control-allow-origin'])
  })
})
