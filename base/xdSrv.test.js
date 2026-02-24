import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  xdSrv,
  xdLRU,
  xdRedis,
  xdCookie,
  escapeAny,
  safeText,
  safeAttr,
  safeUrlAttr,
  safeTextNode,
  createProxyMiddleware,
  errorHandler,
  cors,
  rateLimiter
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

// ──────────────────────────────────────────────
// xdLRU
// ──────────────────────────────────────────────

describe('xdLRU', () => {
  it('basic get/set/has/delete', () => {
    const c = xdLRU({ max: 10, ttl: Infinity })
    c.set('a', 1)
    assert.strictEqual(c.get('a'), 1)
    assert.strictEqual(c.has('a'), true)
    c.delete('a')
    assert.strictEqual(c.get('a'), undefined)
    assert.ok(!c.has('a'))
  })

  it('clear removes all entries', () => {
    const c = xdLRU({ max: 10, ttl: Infinity })
    c.set('a', 1)
    c.set('b', 2)
    c.clear()
    assert.strictEqual(c.size, 0)
    assert.strictEqual(c.get('a'), undefined)
  })

  it('max size eviction evicts oldest', () => {
    const c = xdLRU({ max: 3, ttl: Infinity })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.set('d', 4)
    assert.ok(!c.has('a'))
    assert.strictEqual(c.get('b'), 2)
    assert.strictEqual(c.get('d'), 4)
  })

  it('TTL expiration', async () => {
    const c = xdLRU({ max: 10, ttl: 50 })
    c.set('x', 42)
    assert.strictEqual(c.get('x'), 42)
    await sleep(80)
    assert.strictEqual(c.get('x'), undefined)
  })

  it('updateAgeOnGet refreshes TTL on access', async () => {
    const c = xdLRU({ max: 10, ttl: 100, updateAgeOnGet: true })
    c.set('k', 'v')
    await sleep(60)
    assert.strictEqual(c.get('k'), 'v')
    await sleep(60)
    assert.strictEqual(c.get('k'), 'v')
    await sleep(120)
    assert.strictEqual(c.get('k'), undefined)
  })

  it('dispose callback fires on evict, delete, clear', () => {
    const log = []
    const c = xdLRU({
      max: 2,
      ttl: Infinity,
      dispose: (k, v, reason) => log.push({ k, v, reason })
    })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3) // evicts a
    assert.ok(log.some(e => e.k === 'a' && e.reason === 'evict'))
    c.delete('b')
    assert.ok(log.some(e => e.k === 'b' && e.reason === 'delete'))
    c.clear()
    assert.ok(log.some(e => e.k === 'c' && e.reason === 'delete'))
  })

  it('peek reads without touching order', () => {
    const c = xdLRU({ max: 3, ttl: Infinity })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    assert.strictEqual(c.peek('a'), 1)
    c.set('d', 4) // should evict 'a' since peek didn't touch it
    assert.ok(!c.has('a'))
  })

  it('prune removes stale entries', async () => {
    const c = xdLRU({ max: 10, ttl: 50 })
    c.set('a', 1)
    c.set('b', 2)
    await sleep(80)
    c.set('c', 3)
    c.prune()
    assert.ok(!c.has('a'))
    assert.ok(!c.has('b'))
    assert.strictEqual(c.get('c'), 3)
  })

  it('keys() returns iterator', () => {
    const c = xdLRU({ max: 10, ttl: Infinity })
    c.set('x', 1)
    c.set('y', 2)
    const keys = [...c.keys()]
    assert.ok(keys.includes('x'))
    assert.ok(keys.includes('y'))
  })

  it('size getter', () => {
    const c = xdLRU({ max: 10, ttl: Infinity })
    assert.strictEqual(c.size, 0)
    c.set('a', 1)
    assert.strictEqual(c.size, 1)
    c.set('b', 2)
    assert.strictEqual(c.size, 2)
    c.delete('a')
    assert.strictEqual(c.size, 1)
  })

  it('custom TTL per item via set options', async () => {
    const c = xdLRU({ max: 10, ttl: Infinity })
    c.set('short', 's', { ttl: 50 })
    c.set('long', 'l', { ttl: 5000 })
    await sleep(80)
    assert.strictEqual(c.get('short'), undefined)
    assert.strictEqual(c.get('long'), 'l')
  })
})

// ──────────────────────────────────────────────
// xdRedis
// ──────────────────────────────────────────────

describe('xdRedis', () => {
  let r

  beforeEach(() => {
    r = xdRedis({ max: 100 })
  })

  describe('string operations', () => {
    it('set/get', () => {
      assert.strictEqual(r.set('k', 'v'), 'OK')
      assert.strictEqual(r.get('k'), 'v')
    })

    it('get returns null for missing key', () => {
      assert.strictEqual(r.get('missing'), null)
    })

    it('incr/decr', () => {
      r.set('n', '10')
      assert.strictEqual(r.incr('n'), 11)
      assert.strictEqual(r.decr('n'), 10)
    })

    it('incr on non-existing key starts at 0', () => {
      assert.strictEqual(r.incr('fresh'), 1)
    })

    it('decr on non-existing key', () => {
      assert.strictEqual(r.decr('fresh'), -1)
    })

    it('append', () => {
      r.set('s', 'hello')
      assert.strictEqual(r.append('s', ' world'), 11)
      assert.strictEqual(r.get('s'), 'hello world')
    })

    it('append on non-existing key', () => {
      r.append('newkey', 'val')
      assert.strictEqual(r.get('newkey'), 'val')
    })

    it('incr on non-integer throws', () => {
      r.set('bad', 'abc')
      assert.throws(() => r.incr('bad'), /ERR value is not an integer/)
    })

    it('decr on non-integer throws', () => {
      r.set('bad', 'xyz')
      assert.throws(() => r.decr('bad'), /ERR value is not an integer/)
    })
  })

  describe('list operations', () => {
    it('lpush/rpush/lrange', () => {
      r.lpush('l', 'a')
      r.rpush('l', 'b')
      r.lpush('l', 'c')
      assert.deepStrictEqual(r.lrange('l', 0, -1), ['c', 'a', 'b'])
    })

    it('lpop/rpop', () => {
      r.rpush('l', 'x', 'y', 'z')
      assert.strictEqual(r.lpop('l'), 'x')
      assert.strictEqual(r.rpop('l'), 'z')
      assert.deepStrictEqual(r.lrange('l', 0, -1), ['y'])
    })

    it('lpop/rpop on empty returns null', () => {
      assert.strictEqual(r.lpop('nope'), null)
      assert.strictEqual(r.rpop('nope'), null)
    })

    it('lrange with negative indices', () => {
      r.rpush('l', 'a', 'b', 'c', 'd')
      assert.deepStrictEqual(r.lrange('l', -2, -1), ['c', 'd'])
    })
  })

  describe('hash operations', () => {
    it('hset/hget', () => {
      assert.strictEqual(r.hset('h', 'f1', 'v1'), 1)
      assert.strictEqual(r.hget('h', 'f1'), 'v1')
    })

    it('hset existing field returns 0', () => {
      r.hset('h', 'f1', 'v1')
      assert.strictEqual(r.hset('h', 'f1', 'v2'), 0)
      assert.strictEqual(r.hget('h', 'f1'), 'v2')
    })

    it('hdel', () => {
      r.hset('h', 'f1', 'v1')
      r.hset('h', 'f2', 'v2')
      assert.strictEqual(r.hdel('h', 'f1'), 1)
      assert.strictEqual(r.hget('h', 'f1'), null)
    })

    it('hkeys', () => {
      r.hset('h', 'a', '1')
      r.hset('h', 'b', '2')
      const keys = r.hkeys('h')
      assert.ok(keys.includes('a'))
      assert.ok(keys.includes('b'))
    })

    it('hgetall', () => {
      r.hset('h', 'a', '1')
      r.hset('h', 'b', '2')
      assert.deepStrictEqual(r.hgetall('h'), { a: '1', b: '2' })
    })

    it('hgetall on missing key returns {}', () => {
      assert.deepStrictEqual(r.hgetall('missing'), {})
    })
  })

  describe('set operations', () => {
    it('sadd/smembers', () => {
      assert.strictEqual(r.sadd('s', 'a', 'b', 'c'), 3)
      const members = r.smembers('s')
      assert.strictEqual(members.length, 3)
      assert.ok(members.includes('a'))
    })

    it('sadd duplicate returns 0 for existing', () => {
      r.sadd('s', 'a')
      assert.strictEqual(r.sadd('s', 'a'), 0)
    })

    it('srem', () => {
      r.sadd('s', 'a', 'b')
      assert.strictEqual(r.srem('s', 'a'), 1)
      assert.deepStrictEqual(r.smembers('s'), ['b'])
    })

    it('sismember', () => {
      r.sadd('s', 'x')
      assert.strictEqual(r.sismember('s', 'x'), 1)
      assert.strictEqual(r.sismember('s', 'y'), 0)
    })

    it('smembers on missing key returns []', () => {
      assert.deepStrictEqual(r.smembers('missing'), [])
    })
  })

  describe('key operations', () => {
    it('exists/del', () => {
      r.set('k', 'v')
      assert.ok(r.exists('k'))
      r.del('k')
      assert.ok(!r.exists('k'))
    })

    it('keys with pattern', () => {
      r.set('user:1', 'a')
      r.set('user:2', 'b')
      r.set('post:1', 'c')
      const userKeys = r.keys('user:*')
      assert.strictEqual(userKeys.length, 2)
      assert.ok(userKeys.includes('user:1'))
      assert.ok(userKeys.includes('user:2'))
    })

    it('ttl returns -1 for persistent key', () => {
      r.set('k', 'v')
      assert.strictEqual(r.ttl('k'), -1)
    })

    it('ttl returns -2 for missing key', () => {
      assert.strictEqual(r.ttl('nope'), -2)
    })

    it('expire sets TTL', () => {
      r.set('k', 'v')
      assert.strictEqual(r.expire('k', 10), 1)
      assert.ok(r.ttl('k') > 0)
    })

    it('expire returns 0 for missing key', () => {
      assert.strictEqual(r.expire('nope', 10), 0)
    })

    it('flushAll', () => {
      r.set('a', '1')
      r.set('b', '2')
      assert.strictEqual(r.flushAll(), 'OK')
      assert.strictEqual(r.dbsize(), 0)
    })

    it('dbsize', () => {
      r.set('a', '1')
      r.set('b', '2')
      assert.strictEqual(r.dbsize(), 2)
    })
  })

  describe('TTL expiration', () => {
    it('key expires after TTL', async () => {
      r.set('temp', 'val', { ttl: 1 })
      assert.strictEqual(r.get('temp'), 'val')
      await sleep(1200)
      assert.strictEqual(r.get('temp'), null)
    })
  })

  describe('WRONGTYPE errors', () => {
    it('list op on string key throws', () => {
      r.set('k', 'v')
      assert.throws(() => r.lpush('k', 'x'), /WRONGTYPE/)
    })

    it('hash op on list key throws', () => {
      r.rpush('l', 'a')
      assert.throws(() => r.hset('l', 'f', 'v'), /WRONGTYPE/)
    })

    it('set op on hash key throws', () => {
      r.hset('h', 'f', 'v')
      assert.throws(() => r.sadd('h', 'x'), /WRONGTYPE/)
    })
  })
})

// ──────────────────────────────────────────────
// xdRedisQueue
// ──────────────────────────────────────────────

describe('xdRedisQueue', () => {
  it('enqueue and process tasks', async () => {
    const r = xdRedis({ max: 100 })
    const processed = []
    const q = r.xdRedisQueue('testq', async task => {
      processed.push(task)
    }, { pollInterval: 50, baseRetryDelay: 10 })

    q.enqueue({ id: 1 })
    q.enqueue({ id: 2 })
    await sleep(300)
    q.stop()
    assert.ok(processed.some(t => t.id === 1))
    assert.ok(processed.some(t => t.id === 2))
  })

  it('stop() stops processing', async () => {
    const r = xdRedis({ max: 100 })
    const processed = []
    const q = r.xdRedisQueue('stopq', async task => {
      processed.push(task)
    }, { pollInterval: 50, baseRetryDelay: 10 })

    assert.strictEqual(q.isRunning, true)
    q.stop()
    assert.strictEqual(q.isRunning, false)
    q.enqueue({ id: 99 })
    await sleep(200)
    assert.strictEqual(processed.length, 0)
  })

  it('length getter', () => {
    const r = xdRedis({ max: 100 })
    const q = r.xdRedisQueue('lenq', async () => {
      await sleep(5000)
    }, { pollInterval: 50000, baseRetryDelay: 10 })
    q.stop()
    r.rpush('lenq', JSON.stringify({ originalTask: { a: 1 }, retryCount: 0 }))
    r.rpush('lenq', JSON.stringify({ originalTask: { a: 2 }, retryCount: 0 }))
    assert.strictEqual(q.length, 2)
  })

  it('isRunning getter', () => {
    const r = xdRedis({ max: 100 })
    const q = r.xdRedisQueue('runq', async () => {}, { pollInterval: 50 })
    assert.strictEqual(q.isRunning, true)
    q.stop()
    assert.strictEqual(q.isRunning, false)
  })

  it('DLQ after max retries', async () => {
    const r = xdRedis({ max: 100 })
    let attempts = 0
    const q = r.xdRedisQueue('dlqq', async () => {
      attempts++
      throw new Error('fail')
    }, { pollInterval: 50, maxRetries: 2, baseRetryDelay: 10 })

    q.enqueue({ id: 'bad' })
    await sleep(2000)
    q.stop()
    assert.ok(q.dlqLength > 0)
  })

  it('viewDLQ returns failed tasks', async () => {
    const r = xdRedis({ max: 100 })
    const q = r.xdRedisQueue('vdlq', async () => {
      throw new Error('boom')
    }, { pollInterval: 50, maxRetries: 1, baseRetryDelay: 10 })

    q.enqueue({ id: 'fail1' })
    await sleep(1500)
    q.stop()
    const dlq = q.viewDLQ()
    assert.ok(dlq.length > 0)
    assert.ok(dlq[0].error === 'boom' || dlq[0].taskPayloadAtFailure)
  })
})

// ──────────────────────────────────────────────
// xdCookie
// ──────────────────────────────────────────────

describe('xdCookie', () => {
  describe('parse', () => {
    it('parses cookie header string', () => {
      const result = xdCookie.parse('foo=bar; baz=qux')
      assert.strictEqual(result.foo, 'bar')
      assert.strictEqual(result.baz, 'qux')
    })

    it('returns empty object for empty input', () => {
      assert.deepStrictEqual(xdCookie.parse(''), Object.create(null))
      assert.deepStrictEqual(xdCookie.parse(null), Object.create(null))
      assert.deepStrictEqual(xdCookie.parse(undefined), Object.create(null))
    })

    it('handles encoded values', () => {
      const result = xdCookie.parse('name=hello%20world')
      assert.strictEqual(result.name, 'hello world')
    })
  })

  describe('serialize', () => {
    it('creates correct Set-Cookie string', () => {
      const s = xdCookie.serialize('foo', 'bar')
      assert.ok(s.includes('foo=bar'))
      assert.ok(s.includes('Path=/'))
      assert.ok(s.includes('HttpOnly'))
    })

    it('with maxAge', () => {
      const s = xdCookie.serialize('n', 'v', { maxAge: 3600 })
      assert.ok(s.includes('Max-Age=3600'))
    })

    it('with expires', () => {
      const d = new Date('2025-01-01T00:00:00Z')
      const s = xdCookie.serialize('n', 'v', { expires: d })
      assert.ok(s.includes('Expires='))
    })

    it('with domain', () => {
      const s = xdCookie.serialize('n', 'v', { domain: '.example.com' })
      assert.ok(s.includes('Domain=.example.com'))
    })

    it('with path', () => {
      const s = xdCookie.serialize('n', 'v', { path: '/api' })
      assert.ok(s.includes('Path=/api'))
    })

    it('with secure', () => {
      const s = xdCookie.serialize('n', 'v', { secure: true })
      assert.ok(s.includes('Secure'))
    })

    it('with httpOnly false', () => {
      const s = xdCookie.serialize('n', 'v', { httpOnly: false })
      assert.ok(!s.includes('HttpOnly'))
    })

    it('with sameSite Strict', () => {
      const s = xdCookie.serialize('n', 'v', { sameSite: 'Strict' })
      assert.ok(s.includes('SameSite=Strict'))
    })

    it('with sameSite Lax', () => {
      const s = xdCookie.serialize('n', 'v', { sameSite: 'Lax' })
      assert.ok(s.includes('SameSite=Lax'))
    })

    it('with sameSite None', () => {
      const s = xdCookie.serialize('n', 'v', { sameSite: 'None' })
      assert.ok(s.includes('SameSite=None'))
    })

    it('throws on invalid name', () => {
      assert.throws(() => xdCookie.serialize('', 'v'), /bad name/)
      assert.throws(() => xdCookie.serialize('na me', 'v'), /invalid name/)
    })

    it('throws on bad sameSite', () => {
      assert.throws(() => xdCookie.serialize('n', 'v', { sameSite: 'Invalid' }), /bad SameSite/)
    })
  })

  describe('set/setAll/clear/get/has', () => {
    const mockRes = () => {
      const hdrs = {}
      return {
        getHeader: k => hdrs[k],
        setHeader: (k, v) => { hdrs[k] = v },
        _headers: hdrs
      }
    }

    it('set() sets cookie header on response', () => {
      const res = mockRes()
      xdCookie.set(res, 'token', 'abc123')
      const cookies = res.getHeader('Set-Cookie')
      assert.ok(Array.isArray(cookies))
      assert.ok(cookies[0].includes('token=abc123'))
    })

    it('setAll() sets multiple cookies', () => {
      const res = mockRes()
      xdCookie.setAll(res, { a: '1', b: '2' })
      const cookies = res.getHeader('Set-Cookie')
      assert.strictEqual(cookies.length, 2)
    })

    it('clear() sets expired cookie', () => {
      const res = mockRes()
      xdCookie.clear(res, 'token')
      const cookies = res.getHeader('Set-Cookie')
      assert.ok(cookies[0].includes('Max-Age=0'))
    })

    it('get() returns cookie value', () => {
      const parsed = xdCookie.parse('a=1; b=2')
      assert.strictEqual(xdCookie.get(parsed, 'a'), '1')
    })

    it('has() checks cookie existence', () => {
      const parsed = xdCookie.parse('a=1')
      assert.strictEqual(xdCookie.has(parsed, 'a'), true)
      assert.strictEqual(xdCookie.has(parsed, 'z'), false)
    })
  })
})

// ──────────────────────────────────────────────
// Escaping functions
// ──────────────────────────────────────────────

describe('Escaping', () => {
  describe('safeText', () => {
    it('escapes HTML entities', () => {
      assert.strictEqual(safeText('<b>'), '&lt;b&gt;')
      assert.strictEqual(safeText('a&b'), 'a&amp;b')
      assert.strictEqual(safeText('"hi"'), '&quot;hi&quot;')
      assert.strictEqual(safeText("it's"), "it&#39;s")
    })

    it('handles empty/null', () => {
      assert.strictEqual(safeText(''), '')
      assert.strictEqual(safeText(null), '')
      assert.strictEqual(safeText(undefined), '')
    })
  })

  describe('safeTextNode', () => {
    it('is alias for safeText', () => {
      assert.strictEqual(safeTextNode('<div>'), '&lt;div&gt;')
    })
  })

  describe('safeAttr', () => {
    it('produces name="escaped_value"', () => {
      const result = safeAttr('class', 'foo "bar"')
      assert.strictEqual(result, 'class="foo &quot;bar&quot;"')
    })

    it('escapes angle brackets', () => {
      const result = safeAttr('title', '<script>')
      assert.ok(result.includes('&lt;script&gt;'))
    })
  })

  describe('safeUrlAttr', () => {
    it('blocks javascript: URLs', () => {
      const result = safeUrlAttr('href', 'javascript:alert(1)')
      assert.ok(result.includes('about:blank'))
    })

    it('allows http URLs', () => {
      const result = safeUrlAttr('href', 'http://example.com')
      assert.ok(result.includes('http://example.com'))
    })

    it('allows https URLs', () => {
      const result = safeUrlAttr('src', 'https://example.com/img.png')
      assert.ok(result.includes('https://example.com/img.png'))
    })

    it('allows relative URLs', () => {
      const result = safeUrlAttr('href', '/path/to/page')
      assert.ok(result.includes('/path/to/page'))
    })
  })

  describe('escapeAny', () => {
    it('context=jsString escapes JS special chars', () => {
      const r = escapeAny("it's <b>", { context: 'jsString' })
      assert.ok(r.includes('\\x3C'))
      assert.ok(!r.includes('<'))
    })

    it('context=cssString escapes non-alphanumeric', () => {
      const r = escapeAny('url("test")', { context: 'cssString' })
      assert.ok(r.includes('\\'))
    })

    it('context=url blocks javascript:', () => {
      const r = escapeAny('javascript:alert(1)', { context: 'url' })
      assert.strictEqual(r, 'about:blank')
    })

    it('context=url allows https', () => {
      const r = escapeAny('https://ok.com', { context: 'url' })
      assert.strictEqual(r, 'https://ok.com')
    })

    it('context=urlComponent encodes', () => {
      const r = escapeAny('hello world&foo=bar', { context: 'urlComponent' })
      assert.strictEqual(r, encodeURIComponent('hello world&foo=bar'))
    })

    it('handles null/undefined', () => {
      assert.strictEqual(escapeAny(null), '')
      assert.strictEqual(escapeAny(undefined), '')
    })

    it('handles objects (default convert)', () => {
      const r = escapeAny({ a: 1 })
      assert.strictEqual(r, '[object Object]')
    })

    it('handles objects with handleObjects=json', () => {
      const r = escapeAny({ a: 1 }, { handleObjects: 'json' })
      assert.ok(r.includes('&quot;a&quot;'))
    })

    it('handles numbers', () => {
      assert.strictEqual(escapeAny(42), '42')
    })
  })
})

// ──────────────────────────────────────────────
// xdSrv.createApp
// ──────────────────────────────────────────────

describe('xdSrv.createApp', () => {
  it('creates app with expected methods', () => {
    const app = xdSrv.createApp({ logs: false, rateLimit: false })
    assert.strictEqual(typeof app.get, 'function')
    assert.strictEqual(typeof app.post, 'function')
    assert.strictEqual(typeof app.put, 'function')
    assert.strictEqual(typeof app.delete, 'function')
    assert.strictEqual(typeof app.use, 'function')
    assert.strictEqual(typeof app.listen, 'function')
  })

  it('route registration returns app for chaining', () => {
    const app = xdSrv.createApp({ logs: false, rateLimit: false })
    assert.strictEqual(app.get('/a', () => {}), app)
    assert.strictEqual(app.post('/b', () => {}), app)
    assert.strictEqual(app.put('/c', () => {}), app)
    assert.strictEqual(app.delete('/d', () => {}), app)
    assert.strictEqual(app.use(() => {}), app)
  })
})

describe('HTTP integration', () => {
  let port
  let httpServer
  const tmpDir = mkdtempSync(join(tmpdir(), 'xdsrv-test-'))

  before(async () => {
    writeFileSync(join(tmpDir, 'index.html'), '<h1>Home</h1>')
    writeFileSync(join(tmpDir, 'test.txt'), 'hello')

    port = await getFreePort()
    const app = xdSrv.createApp({
      static: tmpDir,
      cors: true,
      rateLimit: false,
      logs: false,
      spa: true
    })

    app.get('/json', (req, res) => res.json({ ok: true }))
    app.get('/text', (req, res) => res.send('hello'))
    app.get('/html-page', (req, res) => res.html('<h1>Hi</h1>'))
    app.get('/obj-send', (req, res) => res.send({ data: 1 }))
    app.get('/status-json', (req, res) => res.status(201).json({ created: true }))
    app.get('/redirect-me', (req, res) => res.redirect(302, '/json'))
    app.get('/safe', (req, res) => res.safeHtml('<script>alert("xss")</script>'))
    app.get('/params/:id', (req, res) => res.json({ id: req.params.id }))
    app.get('/query', (req, res) => res.json(req.query))
    app.get('/session-set', async (req, res) => {
      req.session.user = 'alice'
      await req.saveSession()
      res.json({ set: true })
    })
    app.get('/session-get', async (req, res) => {
      res.json({ user: req.session.user || null })
    })
    app.get('/session-destroy', async (req, res) => {
      await req.destroySession()
      res.json({ destroyed: true })
    })

    app.post('/echo', (req, res) => res.json({ body: req.body }))
    app.put('/update', (req, res) => res.json({ updated: req.body }))
    app.delete('/item/:id', (req, res) => res.json({ deleted: req.params.id }))

    await new Promise(resolve => app.listen(port, resolve))

    // Find the server via process handles for cleanup
    for (const h of process._getActiveHandles()) {
      if (h instanceof http.Server && h.address()?.port === port) {
        httpServer = h
        break
      }
    }
  })

  after(() => {
    if (httpServer) httpServer.close()
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  it('GET route returns JSON', async () => {
    const r = await request(port, 'GET', '/json')
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json, { ok: true })
  })

  it('POST route parses JSON body', async () => {
    const r = await request(port, 'POST', '/echo', { key: 'val' })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json.body, { key: 'val' })
  })

  it('PUT route with body', async () => {
    const r = await request(port, 'PUT', '/update', { id: 1, name: 'test' })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json.updated, { id: 1, name: 'test' })
  })

  it('DELETE route', async () => {
    const r = await request(port, 'DELETE', '/item/42')
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json, { deleted: '42' })
  })

  it('route parameters', async () => {
    const r = await request(port, 'GET', '/params/abc')
    assert.deepStrictEqual(r.json, { id: 'abc' })
  })

  it('query string parsing', async () => {
    const r = await request(port, 'GET', '/query?foo=bar&baz=123')
    assert.strictEqual(r.json.foo, 'bar')
    assert.strictEqual(r.json.baz, '123')
  })

  it('middleware execution', async () => {
    const p = await getFreePort()
    const app2 = xdSrv.createApp({ static: tmpDir, rateLimit: false, logs: false })
    app2.use((req, res, next) => {
      res.setHeader('x-custom', 'mw')
      next()
    })
    app2.get('/mw-test', (req, res) => res.json({ ok: true }))
    await new Promise(resolve => app2.listen(p, resolve))

    const r = await request(p, 'GET', '/mw-test')
    assert.strictEqual(r.headers['x-custom'], 'mw')

    for (const h of process._getActiveHandles()) {
      if (h instanceof http.Server && h.address()?.port === p) { h.close(); break }
    }
  })

  it('sessions: save and retrieve', async () => {
    const r1 = await request(port, 'GET', '/session-set')
    assert.strictEqual(r1.json.set, true)
    const cookies = r1.headers['set-cookie']
    assert.ok(cookies)
    const sidCookie = Array.isArray(cookies)
      ? cookies.find(c => c.includes('sid='))
      : cookies
    assert.ok(sidCookie)

    const sidValue = sidCookie.split(';')[0].split('=').slice(1).join('=')
    const r2 = await request(port, 'GET', '/session-get', null, {
      cookie: `sid=${sidValue}`
    })
    assert.strictEqual(r2.json.user, 'alice')
  })

  it('sessions: destroy', async () => {
    const r1 = await request(port, 'GET', '/session-set')
    const cookies = r1.headers['set-cookie']
    const sidCookie = Array.isArray(cookies)
      ? cookies.find(c => c.includes('sid='))
      : cookies
    const sidValue = sidCookie.split(';')[0].split('=').slice(1).join('=')

    await request(port, 'GET', '/session-destroy', null, {
      cookie: `sid=${sidValue}`
    })

    const r3 = await request(port, 'GET', '/session-get', null, {
      cookie: `sid=${sidValue}`
    })
    assert.strictEqual(r3.json.user, null)
  })

  it('CORS headers on OPTIONS preflight', async () => {
    const r = await request(port, 'OPTIONS', '/json')
    assert.strictEqual(r.status, 204)
    assert.ok(r.headers['access-control-allow-origin'])
    assert.ok(r.headers['access-control-allow-methods'])
  })

  it('404 for unmatched routes (spa fallback serves index.html)', async () => {
    // With spa:true, unmatched routes serve index.html
    const r = await request(port, 'GET', '/nonexistent-route-xyz')
    assert.strictEqual(r.status, 200)
    assert.ok(r.text.includes('Home'))
  })

  it('404 when spa is disabled', async () => {
    const p = await getFreePort()
    const noSpaDir = mkdtempSync(join(tmpdir(), 'xdsrv-nospa-'))
    const app2 = xdSrv.createApp({ static: noSpaDir, rateLimit: false, logs: false, spa: false })
    app2.get('/exists', (req, res) => res.json({ ok: true }))
    await new Promise(resolve => app2.listen(p, resolve))

    const r = await request(p, 'GET', '/does-not-exist')
    assert.strictEqual(r.status, 404)

    for (const h of process._getActiveHandles()) {
      if (h instanceof http.Server && h.address()?.port === p) { h.close(); break }
    }
    try { rmSync(noSpaDir, { recursive: true }) } catch {}
  })

  it('res.status().json() chaining', async () => {
    const r = await request(port, 'GET', '/status-json')
    assert.strictEqual(r.status, 201)
    assert.deepStrictEqual(r.json, { created: true })
  })

  it('res.html() sends HTML content-type', async () => {
    const r = await request(port, 'GET', '/html-page')
    assert.ok(r.headers['content-type'].includes('text/html'))
    assert.strictEqual(r.text, '<h1>Hi</h1>')
  })

  it('res.send() auto-detects objects vs strings', async () => {
    const rObj = await request(port, 'GET', '/obj-send')
    assert.deepStrictEqual(rObj.json, { data: 1 })

    const rStr = await request(port, 'GET', '/text')
    assert.strictEqual(rStr.text, 'hello')
  })

  it('res.redirect()', async () => {
    const r = await new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1', port, method: 'GET', path: '/redirect-me'
      }
      const req = http.request(opts, res => {
        res.resume()
        resolve({ status: res.statusCode, headers: res.headers })
      })
      req.on('error', reject)
      req.end()
    })
    assert.strictEqual(r.status, 302)
    assert.strictEqual(r.headers.location, '/json')
  })

  it('res.safeHtml() escapes HTML', async () => {
    const r = await request(port, 'GET', '/safe')
    assert.ok(!r.text.includes('<script>'))
    assert.ok(r.text.includes('&lt;script&gt;'))
  })

  it('rate limiter skipped when rateLimit:false', async () => {
    // The main app has rateLimit:false, so many requests should succeed
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(port, 'GET', '/json'))
    )
    assert.ok(results.every(r => r.status === 200))
  })

  it('static file serving', async () => {
    const r = await request(port, 'GET', '/test.txt')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.text, 'hello')
  })
})
