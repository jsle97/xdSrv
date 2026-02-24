import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import {
  xdSrv,
  xdLRU,
  xdRedis,
  xdCookie,
  escapeAny,
  safeText,
  safeAttr,
  safeUrlAttr,
  errorHandler,
  cors,
  createRateLimiter,
  rateLimiterMiddleware,
  xdWebSocket
} from './xdSrv.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const request = (port, method, path, body, extraHeaders = {}) =>
  new Promise((resolve, reject) => {
    const headers = { ...extraHeaders }
    let payload
    if (body && typeof body === 'string') {
      payload = body
    } else if (body) {
      headers['content-type'] = headers['content-type'] || 'application/json'
      payload = JSON.stringify(body)
    }
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
    if (payload) req.write(payload)
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
    assert.strictEqual(c.size(), 0)
    assert.strictEqual(c.get('a'), undefined)
  })

  it('max size eviction evicts oldest', () => {
    const c = xdLRU({ max: 3, ttl: Infinity })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.set('d', 4)
    assert.strictEqual(c.has('a'), false)
    assert.strictEqual(c.get('b'), 2)
    assert.strictEqual(c.get('d'), 4)
  })

  it('TTL expiration', async () => {
    const c = xdLRU({ max: 10, ttl: 50 })
    c.set('x', 'val')
    assert.strictEqual(c.get('x'), 'val')
    await sleep(80)
    assert.strictEqual(c.get('x'), undefined)
    assert.strictEqual(c.has('x'), false)
  })

  it('per-key TTL overrides default', async () => {
    const c = xdLRU({ max: 10, ttl: 5000 })
    c.set('short', 1, { ttl: 50 })
    await sleep(80)
    assert.strictEqual(c.get('short'), undefined)
  })

  it('updateAgeOnGet refreshes LRU order', () => {
    const c = xdLRU({ max: 3, ttl: Infinity, updateAgeOnGet: true })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.get('a') // refresh 'a'
    c.set('d', 4) // should evict 'b' (oldest non-refreshed)
    assert.strictEqual(c.has('a'), true)
    assert.strictEqual(c.has('b'), false)
  })

  it('updateAgeOnGet=false does not refresh', () => {
    const c = xdLRU({ max: 3, ttl: Infinity, updateAgeOnGet: false })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.get('a') // does NOT refresh 'a'
    c.set('d', 4) // should evict 'a' (still oldest)
    assert.strictEqual(c.has('a'), false)
    assert.strictEqual(c.has('b'), true)
  })

  it('dispose callback on delete', () => {
    const disposed = []
    const c = xdLRU({
      max: 10, ttl: Infinity,
      dispose: (k, v, reason) => disposed.push({ k, v, reason })
    })
    c.set('a', 1)
    c.delete('a')
    assert.strictEqual(disposed.length, 1)
    assert.strictEqual(disposed[0].k, 'a')
    assert.strictEqual(disposed[0].reason, 'delete')
  })

  it('dispose callback on eviction', () => {
    const disposed = []
    const c = xdLRU({
      max: 2, ttl: Infinity,
      dispose: (k, v, reason) => disposed.push({ k, v, reason })
    })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    assert.ok(disposed.some(d => d.reason === 'evict'))
  })

  it('dispose callback on clear', () => {
    const disposed = []
    const c = xdLRU({
      max: 10, ttl: Infinity,
      dispose: (k, v, reason) => disposed.push({ k, v, reason })
    })
    c.set('a', 1)
    c.set('b', 2)
    c.clear()
    assert.strictEqual(disposed.length, 2)
    assert.ok(disposed.every(d => d.reason === 'clear'))
  })

  it('keys() returns iterator of non-expired keys', async () => {
    const c = xdLRU({ max: 10, ttl: 50 })
    c.set('expire', 1)
    c.set('stay', 2, { ttl: Infinity })
    await sleep(80)
    const keys = [...c.keys()]
    assert.ok(!keys.includes('expire'))
    assert.ok(keys.includes('stay'))
  })

  it('size() returns count of non-expired', async () => {
    const c = xdLRU({ max: 10, ttl: 50 })
    c.set('expire', 1)
    c.set('stay', 2, { ttl: Infinity })
    assert.strictEqual(c.size(), 2)
    await sleep(80)
    assert.strictEqual(c.size(), 1)
  })

  it('set returns true', () => {
    const c = xdLRU({ max: 10 })
    assert.strictEqual(c.set('a', 1), true)
    assert.strictEqual(c.set('a', 2), true) // overwrite
  })

  it('delete returns boolean', () => {
    const c = xdLRU({ max: 10 })
    c.set('a', 1)
    assert.strictEqual(c.delete('a'), true)
    assert.strictEqual(c.delete('a'), false)
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

  describe('String operations', () => {
    it('set/get', () => {
      assert.strictEqual(r.set('k', 'v'), 'OK')
      assert.strictEqual(r.get('k'), 'v')
    })

    it('get returns null for missing key', () => {
      assert.strictEqual(r.get('nope'), null)
    })

    it('incr on new key', () => {
      assert.strictEqual(r.incr('counter'), 1)
      assert.strictEqual(r.incr('counter'), 2)
    })

    it('decr on new key', () => {
      assert.strictEqual(r.decr('counter'), -1)
      assert.strictEqual(r.decr('counter'), -2)
    })

    it('incr on non-numeric throws', () => {
      r.set('k', 'abc')
      assert.throws(() => r.incr('k'), /not an integer/)
    })

    it('decr on non-numeric throws', () => {
      r.set('k', 'abc')
      assert.throws(() => r.decr('k'), /not an integer/)
    })

    it('append', () => {
      r.set('k', 'hello')
      assert.strictEqual(r.append('k', ' world'), 11)
      assert.strictEqual(r.get('k'), 'hello world')
    })

    it('append to non-existent key', () => {
      assert.strictEqual(r.append('k', 'hi'), 2)
      assert.strictEqual(r.get('k'), 'hi')
    })
  })

  describe('List operations', () => {
    it('lpush/rpush/lrange', () => {
      r.rpush('list', 'a', 'b')
      r.lpush('list', 'z')
      const items = r.lrange('list', 0, -1)
      assert.deepStrictEqual(items, ['z', 'a', 'b'])
    })

    it('lpop/rpop', () => {
      r.rpush('list', '1', '2', '3')
      assert.strictEqual(r.lpop('list'), '1')
      assert.strictEqual(r.rpop('list'), '3')
    })

    it('lpop/rpop on empty returns null', () => {
      assert.strictEqual(r.lpop('nope'), null)
      assert.strictEqual(r.rpop('nope'), null)
    })

    it('lrange with negative indices', () => {
      r.rpush('list', 'a', 'b', 'c', 'd')
      assert.deepStrictEqual(r.lrange('list', -2, -1), ['c', 'd'])
    })

    it('lrange on missing key returns []', () => {
      assert.deepStrictEqual(r.lrange('nope', 0, -1), [])
    })

    it('lpush returns new length', () => {
      assert.strictEqual(r.lpush('list', 'a'), 1)
      assert.strictEqual(r.lpush('list', 'b'), 2)
    })

    it('rpush returns new length', () => {
      assert.strictEqual(r.rpush('list', 'a'), 1)
      assert.strictEqual(r.rpush('list', 'b'), 2)
    })
  })

  describe('Hash operations', () => {
    it('hset/hget', () => {
      assert.strictEqual(r.hset('h', 'f1', 'v1'), 1)
      assert.strictEqual(r.hget('h', 'f1'), 'v1')
    })

    it('hset returns 0 on update', () => {
      r.hset('h', 'f1', 'v1')
      assert.strictEqual(r.hset('h', 'f1', 'v2'), 0)
    })

    it('hget missing field returns null', () => {
      r.hset('h', 'f1', 'v1')
      assert.strictEqual(r.hget('h', 'nope'), null)
    })

    it('hget missing key returns null', () => {
      assert.strictEqual(r.hget('nope', 'f'), null)
    })

    it('hdel', () => {
      r.hset('h', 'a', '1')
      r.hset('h', 'b', '2')
      assert.strictEqual(r.hdel('h', 'a', 'nonexistent'), 1)
      assert.strictEqual(r.hget('h', 'a'), null)
    })

    it('hkeys', () => {
      r.hset('h', 'a', '1')
      r.hset('h', 'b', '2')
      assert.deepStrictEqual(r.hkeys('h').sort(), ['a', 'b'])
    })

    it('hkeys missing key returns []', () => {
      assert.deepStrictEqual(r.hkeys('nope'), [])
    })

    it('hgetall', () => {
      r.hset('h', 'a', '1')
      r.hset('h', 'b', '2')
      assert.deepStrictEqual(r.hgetall('h'), { a: '1', b: '2' })
    })

    it('hgetall missing key returns {}', () => {
      assert.deepStrictEqual(r.hgetall('nope'), {})
    })
  })

  describe('Set operations', () => {
    it('sadd/smembers', () => {
      assert.strictEqual(r.sadd('s', 'a', 'b', 'a'), 2) // 'a' duplicate
      const members = r.smembers('s').sort()
      assert.deepStrictEqual(members, ['a', 'b'])
    })

    it('srem', () => {
      r.sadd('s', 'a', 'b', 'c')
      assert.strictEqual(r.srem('s', 'b', 'nonexistent'), 1)
      assert.deepStrictEqual(r.smembers('s').sort(), ['a', 'c'])
    })

    it('sismember', () => {
      r.sadd('s', 'x')
      assert.strictEqual(r.sismember('s', 'x'), 1)
      assert.strictEqual(r.sismember('s', 'y'), 0)
    })

    it('sismember on missing key returns 0', () => {
      assert.strictEqual(r.sismember('nope', 'x'), 0)
    })

    it('smembers on missing key returns []', () => {
      assert.deepStrictEqual(r.smembers('nope'), [])
    })
  })

  describe('Key operations', () => {
    it('exists', () => {
      assert.strictEqual(r.exists('k'), false)
      r.set('k', 'v')
      assert.strictEqual(r.exists('k'), true)
    })

    it('del', () => {
      r.set('k', 'v')
      r.del('k')
      assert.strictEqual(r.exists('k'), false)
    })

    it('keys with pattern', () => {
      r.set('user:1', 'a')
      r.set('user:2', 'b')
      r.set('post:1', 'c')
      const userKeys = r.keys('user:*').sort()
      assert.deepStrictEqual(userKeys, ['user:1', 'user:2'])
    })

    it('keys with no pattern returns all', () => {
      r.set('a', '1')
      r.set('b', '2')
      assert.strictEqual(r.keys().length, 2)
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

  describe('TTL', () => {
    it('ttl returns -2 for non-existent', () => {
      assert.strictEqual(r.ttl('nope'), -2)
    })

    it('ttl returns -1 for no expiry', () => {
      r.set('k', 'v')
      assert.strictEqual(r.ttl('k'), -1)
    })

    it('expire sets TTL', () => {
      r.set('k', 'v')
      assert.strictEqual(r.expire('k', 10), 1)
      assert.ok(r.ttl('k') > 0)
    })

    it('expire on non-existent returns 0', () => {
      assert.strictEqual(r.expire('nope', 10), 0)
    })

    it('set with ttl option', async () => {
      r.set('k', 'v', { ttl: 1 })
      assert.strictEqual(r.get('k'), 'v')
      assert.ok(r.ttl('k') > 0)
    })

    it('key expires after TTL', async () => {
      r.set('k', 'v', { ttl: 1 })
      assert.strictEqual(r.get('k'), 'v')
      await sleep(1200)
      assert.strictEqual(r.get('k'), null)
    })
  })

  describe('WRONGTYPE errors', () => {
    it('list op on string key throws', () => {
      r.set('k', 'string')
      assert.throws(() => r.lpush('k', 'x'), /WRONGTYPE/)
    })

    it('hash op on list key throws', () => {
      r.rpush('k', 'x')
      assert.throws(() => r.hset('k', 'f', 'v'), /WRONGTYPE/)
    })

    it('set op on hash key throws', () => {
      r.hset('k', 'f', 'v')
      assert.throws(() => r.sadd('k', 'm'), /WRONGTYPE/)
    })
  })

  describe('createRedisQueue', () => {
    it('enqueue and process tasks', async () => {
      const processed = []
      const q = r.createRedisQueue('testq', async (task) => {
        processed.push(task)
      }, { pollInterval: 50 })

      q.enqueue({ id: 1 })
      q.enqueue({ id: 2 })

      await sleep(300)
      q.stop()

      assert.ok(processed.some(t => t.id === 1))
      assert.ok(processed.some(t => t.id === 2))
    })

    it('isRunning and stop', () => {
      const q = r.createRedisQueue('q2', async () => {}, { pollInterval: 100 })
      assert.strictEqual(q.isRunning, true)
      q.stop()
      assert.strictEqual(q.isRunning, false)
    })

    it('getDLQName returns expected name', () => {
      const q = r.createRedisQueue('myq', async () => {}, { pollInterval: 100 })
      assert.strictEqual(q.getDLQName(), 'myq_DLQ')
      q.stop()
    })

    it('failed tasks go to DLQ after max retries', async () => {
      const q = r.createRedisQueue('failq', async () => {
        throw new Error('fail')
      }, { pollInterval: 50, maxRetries: 1, baseRetryDelay: 10 })

      q.enqueue({ bad: true })
      await sleep(500)
      q.stop()

      assert.ok(q.dlqLength > 0)
      const dlqItems = q.viewDLQ()
      assert.ok(dlqItems.length > 0)
    })
  })
})

// ──────────────────────────────────────────────
// xdCookie
// ──────────────────────────────────────────────

describe('xdCookie', () => {
  describe('parse', () => {
    it('parses cookie header', () => {
      const result = xdCookie.parse('name=value; other=123')
      assert.strictEqual(result.name, 'value')
      assert.strictEqual(result.other, '123')
    })

    it('handles empty/null header', () => {
      assert.deepStrictEqual(xdCookie.parse(''), Object.create(null))
      assert.deepStrictEqual(xdCookie.parse(null), Object.create(null))
    })

    it('decodes URI-encoded values', () => {
      const result = xdCookie.parse('name=hello%20world')
      assert.strictEqual(result.name, 'hello world')
    })
  })

  describe('serialize', () => {
    it('basic serialize', () => {
      const s = xdCookie.serialize('name', 'val')
      assert.ok(s.includes('name=val'))
      assert.ok(s.includes('Path=/'))
      assert.ok(s.includes('HttpOnly'))
    })

    it('with maxAge', () => {
      const s = xdCookie.serialize('n', 'v', { maxAge: 3600 })
      assert.ok(s.includes('Max-Age=3600'))
    })

    it('with expires', () => {
      const date = new Date('2030-01-01')
      const s = xdCookie.serialize('n', 'v', { expires: date })
      assert.ok(s.includes('Expires='))
    })

    it('with secure and sameSite', () => {
      const s = xdCookie.serialize('n', 'v', { secure: true, sameSite: 'Strict' })
      assert.ok(s.includes('Secure'))
      assert.ok(s.includes('SameSite=Strict'))
    })

    it('with domain', () => {
      const s = xdCookie.serialize('n', 'v', { domain: '.example.com' })
      assert.ok(s.includes('Domain=.example.com'))
    })

    it('throws on empty name', () => {
      assert.throws(() => xdCookie.serialize('', 'v'), /TypeError/)
    })

    it('throws on invalid name', () => {
      assert.throws(() => xdCookie.serialize('bad name', 'v'), /TypeError/)
    })

    it('throws on invalid domain', () => {
      assert.throws(() => xdCookie.serialize('n', 'v', { domain: 'invalid' }), /TypeError/)
    })

    it('throws on invalid sameSite', () => {
      assert.throws(() => xdCookie.serialize('n', 'v', { sameSite: 'bad' }), /TypeError/)
    })
  })

  describe('set/get/has/clear', () => {
    const createMockResponse = () => {
      const headers = {}
      return {
        getHeader: (name) => headers[name.toLowerCase()],
        setHeader: (name, value) => { headers[name.toLowerCase()] = value }
      }
    }

    it('set adds Set-Cookie header', () => {
      const res = createMockResponse()
      xdCookie.set(res, 'token', 'abc123')
      const cookies = res.getHeader('set-cookie')
      assert.ok(Array.isArray(cookies))
      assert.ok(cookies[0].includes('token=abc123'))
    })

    it('setAll sets multiple cookies', () => {
      const res = createMockResponse()
      xdCookie.setAll(res, { a: '1', b: '2' })
      const cookies = res.getHeader('set-cookie')
      assert.strictEqual(cookies.length, 2)
    })

    it('setAll throws on non-object', () => {
      const res = createMockResponse()
      assert.throws(() => xdCookie.setAll(res, null), /TypeError/)
    })

    it('clear sets maxAge=0', () => {
      const res = createMockResponse()
      xdCookie.clear(res, 'token')
      const cookies = res.getHeader('set-cookie')
      assert.ok(cookies[0].includes('Max-Age=0'))
    })

    it('get retrieves cookie value', () => {
      const cookies = xdCookie.parse('a=1; b=2')
      assert.strictEqual(xdCookie.get(cookies, 'a'), '1')
      assert.strictEqual(xdCookie.get(cookies, 'c'), undefined)
    })

    it('has checks cookie existence', () => {
      const cookies = xdCookie.parse('a=1')
      assert.strictEqual(xdCookie.has(cookies, 'a'), true)
      assert.strictEqual(xdCookie.has(cookies, 'b'), false)
    })
  })
})

// ──────────────────────────────────────────────
// Escaping
// ──────────────────────────────────────────────

describe('Escaping', () => {
  describe('safeText', () => {
    it('escapes HTML entities', () => {
      assert.strictEqual(safeText('<script>'), '&lt;script&gt;')
    })

    it('escapes ampersand', () => {
      assert.strictEqual(safeText('a & b'), 'a &amp; b')
    })

    it('escapes quotes', () => {
      assert.strictEqual(safeText('"hello"'), '&quot;hello&quot;')
    })

    it('handles null/undefined', () => {
      assert.strictEqual(safeText(null), '')
      assert.strictEqual(safeText(undefined), '')
    })

    it('converts numbers to string', () => {
      assert.strictEqual(safeText(42), '42')
    })
  })

  describe('safeAttr', () => {
    it('produces quoted attribute', () => {
      const result = safeAttr('class', 'my-class')
      assert.strictEqual(result, 'class="my-class"')
    })

    it('escapes dangerous values', () => {
      const result = safeAttr('title', '<script>alert("xss")</script>')
      assert.ok(result.includes('&lt;'))
      assert.ok(!result.includes('<script>'))
    })

    it('unquoted mode', () => {
      const result = safeAttr('id', 'myid', { quoted: false })
      assert.strictEqual(result, 'id=myid')
    })
  })

  describe('safeUrlAttr', () => {
    it('allows safe URLs', () => {
      const result = safeUrlAttr('href', 'https://example.com')
      assert.ok(result.includes('https://example.com'))
    })

    it('blocks javascript: protocol', () => {
      const result = safeUrlAttr('href', 'javascript:alert(1)')
      assert.ok(result.includes('about:blank'))
    })

    it('allows mailto:', () => {
      const result = safeUrlAttr('href', 'mailto:test@example.com')
      assert.ok(result.includes('mailto:'))
    })
  })

  describe('escapeAny', () => {
    it('htmlContent context', () => {
      assert.strictEqual(
        escapeAny('<b>test</b>', { context: 'htmlContent' }),
        '&lt;b&gt;test&lt;/b&gt;'
      )
    })

    it('jsString context', () => {
      const result = escapeAny("alert('xss')", { context: 'jsString', quote: "'" })
      assert.ok(result.includes("\\'"))
    })

    it('urlComponent context', () => {
      const result = escapeAny('hello world', { context: 'urlComponent' })
      assert.strictEqual(result, 'hello%20world')
    })

    it('url context blocks javascript:', () => {
      const result = escapeAny('javascript:void(0)', { context: 'url' })
      assert.strictEqual(result, 'about:blank')
    })

    it('scriptData context escapes </script', () => {
      const result = escapeAny('</script>', { context: 'scriptData' })
      assert.ok(!result.includes('</script>'))
    })

    it('handleObjects: json', () => {
      const result = escapeAny({ a: 1 }, { handleObjects: 'json', context: 'htmlContent' })
      assert.ok(result.includes('&quot;a&quot;'))
    })

    it('handleObjects: empty', () => {
      assert.strictEqual(escapeAny({ a: 1 }, { handleObjects: 'empty' }), '')
    })

    it('handleObjects: throw', () => {
      assert.throws(
        () => escapeAny({ a: 1 }, { handleObjects: 'throw' }),
        /Non-primitive/
      )
    })

    it('cssString context', () => {
      const result = escapeAny('font: "Arial"', { context: 'cssString' })
      assert.ok(!result.includes('"'))
    })

    it('htmlAttributeUnquoted context', () => {
      const result = escapeAny('a b', { context: 'htmlAttributeUnquoted' })
      assert.ok(result.includes('&#32;'))
    })
  })
})

// ──────────────────────────────────────────────
// HTTP Server (xdSrv.createApp)
// ──────────────────────────────────────────────

describe('xdSrv.createApp', () => {
  let app
  let port

  before(async () => {
    app = xdSrv.createApp({ logs: false, rateLimit: false, cors: true, static: '/tmp/xdsrv-test-nonexistent' })

    app.get('/hello', (req, res) => res.json({ msg: 'hello' }))
    app.get('/text', (req, res) => res.send('plain text'))
    app.get('/html-page', (req, res) => res.html('<h1>Hi</h1>'))
    app.get('/redirect-test', (req, res) => res.redirect(302, '/target'))
    app.get('/safe-html', (req, res) => res.safeHtml('<script>alert(1)</script>'))
    app.get('/safe-json', (req, res) => res.safeJson({ ok: true }))
    app.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
    app.get('/query', (req, res) => res.json(req.query))
    app.get('/vary-test', (req, res) => {
      res.vary('Accept')
      res.vary('Accept-Encoding')
      res.json({ ok: true })
    })
    app.get('/props', (req, res) => {
      res.json({ hostname: req.hostname, secure: req.secure, ip: req.ip })
    })

    app.post('/echo', (req, res) => res.json(req.body))
    app.put('/update/:id', (req, res) => res.json({ id: req.params.id, body: req.body }))
    app.delete('/remove/:id', (req, res) => res.json({ removed: req.params.id }))

    app.post('/form', (req, res) => res.json(req.body))

    await new Promise(resolve => {
      app.listen(0, () => {
        port = app.server.address().port
        resolve()
      })
    })
  })

  after(() => {
    app.server.close()
  })

  it('GET route returns JSON', async () => {
    const res = await request(port, 'GET', '/hello')
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(res.json, { msg: 'hello' })
  })

  it('GET route returns plain text via send()', async () => {
    const res = await request(port, 'GET', '/text')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.text, 'plain text')
  })

  it('GET route returns HTML', async () => {
    const res = await request(port, 'GET', '/html-page')
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers['content-type'].includes('text/html'))
  })

  it('redirect', async () => {
    const res = await request(port, 'GET', '/redirect-test')
    assert.strictEqual(res.status, 302)
    assert.strictEqual(res.headers.location, '/target')
  })

  it('safeHtml escapes content', async () => {
    const res = await request(port, 'GET', '/safe-html')
    assert.ok(res.text.includes('&lt;script&gt;'))
    assert.ok(!res.text.includes('<script>'))
  })

  it('safeJson returns JSON', async () => {
    const res = await request(port, 'GET', '/safe-json')
    assert.deepStrictEqual(res.json, { ok: true })
  })

  it('POST with JSON body', async () => {
    const res = await request(port, 'POST', '/echo', { foo: 'bar' })
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(res.json, { foo: 'bar' })
  })

  it('POST with URL-encoded body', async () => {
    const body = 'name=John&age=30'
    const res = await request(port, 'POST', '/form', body, {
      'content-type': 'application/x-www-form-urlencoded'
    })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.name, 'John')
    assert.strictEqual(res.json.age, '30')
  })

  it('PUT route', async () => {
    const res = await request(port, 'PUT', '/update/42', { name: 'updated' })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.json.id, '42')
    assert.deepStrictEqual(res.json.body, { name: 'updated' })
  })

  it('DELETE route', async () => {
    const res = await request(port, 'DELETE', '/remove/99')
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(res.json, { removed: '99' })
  })

  it('route parameters', async () => {
    const res = await request(port, 'GET', '/users/123')
    assert.strictEqual(res.json.id, '123')
  })

  it('query string', async () => {
    const res = await request(port, 'GET', '/query?a=1&b=2')
    assert.strictEqual(res.json.a, '1')
    assert.strictEqual(res.json.b, '2')
  })

  it('404 for unmatched routes', async () => {
    const res = await request(port, 'GET', '/no-such-route')
    assert.strictEqual(res.status, 404)
  })

  it('res.vary() appends Vary header', async () => {
    const res = await request(port, 'GET', '/vary-test')
    const vary = res.headers['vary']
    assert.ok(vary.includes('Accept'))
    assert.ok(vary.includes('Accept-Encoding'))
  })

  it('security headers present', async () => {
    const res = await request(port, 'GET', '/hello')
    assert.ok(res.headers['x-frame-options'])
    assert.ok(res.headers['referrer-policy'])
    assert.ok(res.headers['cross-origin-opener-policy'])
  })

  it('CORS headers present', async () => {
    const res = await request(port, 'GET', '/hello', null, { origin: 'http://test.com' })
    assert.strictEqual(res.headers['access-control-allow-origin'], 'http://test.com')
    assert.ok(res.headers['access-control-allow-methods'])
  })

  it('OPTIONS returns 204 for CORS preflight', async () => {
    const res = await request(port, 'OPTIONS', '/hello', null, { origin: 'http://test.com' })
    assert.strictEqual(res.status, 204)
  })

  it('req properties (hostname, secure, ip)', async () => {
    const res = await request(port, 'GET', '/props')
    assert.strictEqual(res.json.hostname, '127.0.0.1')
    assert.strictEqual(res.json.secure, false)
    assert.ok(typeof res.json.ip === 'string')
  })
})

describe('xdSrv middleware', () => {
  let app
  let port

  before(async () => {
    app = xdSrv.createApp({ logs: false, rateLimit: false, cors: false, static: '/tmp/xdsrv-mw-nonexistent' })

    app.use((req, res, next) => {
      res.setHeader('X-Custom', 'middleware-hit')
      next()
    })

    app.get('/mw', (req, res) => res.json({ ok: true }))

    await new Promise(resolve => {
      app.listen(0, () => {
        port = app.server.address().port
        resolve()
      })
    })
  })

  after(() => { app.server.close() })

  it('middleware runs before route handler', async () => {
    const res = await request(port, 'GET', '/mw')
    assert.strictEqual(res.headers['x-custom'], 'middleware-hit')
    assert.deepStrictEqual(res.json, { ok: true })
  })
})

// ──────────────────────────────────────────────
// WebSocket API surface
// ──────────────────────────────────────────────

describe('WebSocket API surface', () => {
  it('app.ws() registers route and returns app', () => {
    const app = xdSrv.createApp({ logs: false, rateLimit: false, cors: false, static: '/tmp/xdsrv-ws-nonexistent' })
    const result = app.ws('/ws', (ws) => {})
    assert.strictEqual(result, app) // chainable
  })

  it('app.getWsClients() returns a Set', () => {
    const app = xdSrv.createApp({ logs: false, rateLimit: false, cors: false, static: '/tmp/xdsrv-ws2-nonexistent' })
    const clients = app.getWsClients()
    assert.ok(clients instanceof Set)
    assert.strictEqual(clients.size, 0)
  })

  it('app.broadcast() does not throw when no clients', () => {
    const app = xdSrv.createApp({ logs: false, rateLimit: false, cors: false, static: '/tmp/xdsrv-ws3-nonexistent' })
    assert.doesNotThrow(() => app.broadcast('hello'))
    assert.doesNotThrow(() => app.broadcast('hello', { filter: () => true }))
  })
})

// ──────────────────────────────────────────────
// Exported middleware and utilities
// ──────────────────────────────────────────────

describe('Exported utilities', () => {
  it('errorHandler is a function', () => {
    assert.strictEqual(typeof errorHandler, 'function')
  })

  it('cors is a function', () => {
    assert.strictEqual(typeof cors, 'function')
  })

  it('createRateLimiter returns a middleware function', () => {
    const mw = createRateLimiter(1000, 5)
    assert.strictEqual(typeof mw, 'function')
  })

  it('rateLimiterMiddleware is a function', () => {
    assert.strictEqual(typeof rateLimiterMiddleware, 'function')
  })

  it('xdWebSocket is an object with createSocket and handleUpgrade', () => {
    assert.strictEqual(typeof xdWebSocket.createSocket, 'function')
    assert.strictEqual(typeof xdWebSocket.handleUpgrade, 'function')
  })
})
