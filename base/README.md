# xdSrv — base (Core Build)

**Version:** 11.0.0 | **Size:** ~750 LOC | **Dependencies:** 0

The core xdSrv build. Adds the full utility layer on top of HTTP routing: in-memory data stores (LRU + Redis-like), reverse proxy middleware, cookie management, context-aware XSS escaping, basic sessions, CORS, rate limiting and an error handler.

## Imports

```
node:http, node:https, node:fs/promises, node:path, node:http, node:https, node:url, node:util
```

## Exports

```js
// Named exports
export {
 createProxyMiddleware, // Reverse proxy
 xdRedis,              // In-memory Redis store + queue
 xdLRU,                // LRU cache
 errorHandler,         // Error handling middleware
 cors,                 // CORS middleware
 rateLimiter,          // Rate limiting middleware
 xdCookie,             // Cookie parse/serialize/set/clear
 escapeAny,            // Context-aware escaping
 safeText,             // HTML content escaping
 safeAttr,             // HTML attribute escaping
 safeUrlAttr,          // URL attribute escaping
 safeTextNode          // Alias for safeText
}

// Default: xdSrv.createApp(options)
export { xdSrv }
```

## Components

### createProxyMiddleware(options)

Reverse proxy middleware supporting HTTP and HTTPS targets.

| Option | Type | Default | Description |
|---|---|---|---|
| `target` | string | **required** | Target URL (`http://localhost:4000`) |
| `changeOrigin` | boolean | `true` | Rewrite Host header to target |
| `ignoreHeaders` | string[] | `[]` | Headers to strip from proxy request |
| `timeout` | number | `0` | Proxy request timeout in ms |
| `onError` | function | console.error + 500 | Custom error handler |

```js
app.use('/api', createProxyMiddleware({
 target: 'http://backend:4000',
 changeOrigin: true,
 timeout: 5000
}))
```

**Implementation:** Creates a `http.request` / `https.request` to the target, pipes `req → proxyReq` and `proxyRes → res`. Handles timeout via `proxyReq.destroy()`. Resolves protocol from target URL scheme.

### xdLRU(options?)

LRU (Least Recently Used) cache backed by a `Map` with insertion-order eviction.

| Option | Type | Default | Description |
|---|---|---|---|
| `max` | number | `500` | Maximum entries |
| `ttl` | number | `0` | Default TTL in ms (0 = no expiry) |
| `updateAgeOnGet` | boolean | `false` | Refresh TTL on read |
| `dispose` | function | `null` | `(key, value, reason)` callback on eviction |

Methods: `get(k)`, `set(k, v, {ttl?})`, `has(k)`, `delete(k)`, `clear()`, `peek(k)`, `prune()`, `keys()`, `size`

**Implementation:** Uses `Map` iteration order for LRU tracking. Each entry stores `{v, exp, itemTtl}`. `touchEntry` deletes and re-inserts to move to tail. `prune()` scans all entries and removes stale ones.

### xdRedis(options?)

In-memory data store mimicking Redis API. Built on top of `xdLRU`.

| Option | Type | Default | Description |
|---|---|---|---|
| `max` | number | `1000` | Maximum keys |

**Key operations:** `exists`, `del`, `keys(pattern)`, `ttl`, `expire`, `flushAll`, `dbsize`

**String ops:** `set`, `get`, `incr`, `decr`, `append`

**List ops:** `lpush`, `rpush`, `lpop`, `rpop`, `lrange`

**Hash ops:** `hset`, `hget`, `hdel`, `hkeys`, `hgetall`

**Set ops:** `sadd`, `srem`, `smembers`, `sismember`

**Implementation:** Each value is wrapped as `{__type, data}`. Type checking via `assertType` ensures operations match the stored type (throws `WRONGTYPE` error otherwise). TTL tracked in a separate `Map(key → timestamp)`. `touch(key)` lazily evicts expired entries on access.

#### xdRedisQueue

Task queue with retry logic and dead-letter queue (DLQ), built on Redis list operations.

```js
const store = xdRedis()
const queue = store.xdRedisQueue('tasks', async (task) => {
 await processTask(task)
}, {
 concurrency: 3,
 maxRetries: 5,
 baseRetryDelay: 1000
})

queue.enqueue({ type: 'email', to: 'user@example.com' })
```

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | number | `1` | Parallel workers |
| `pollInterval` | number | `500` | Poll interval in ms |
| `maxRetries` | number | `3` | Max retry attempts |
| `baseRetryDelay` | number | `1000` | Base delay (exponential backoff) |
| `dlqKeySuffix` | string | `'_DLQ'` | DLQ key suffix |

**Implementation:** Tasks are stored as `{originalTask, retryCount}` JSON strings in a Redis list. Workers `lpop` from the queue. On failure, retry with exponential backoff (`baseDelay * 2^attempt`). After max retries, task moves to DLQ list. Polling via `setTimeout` loop.

### xdCookie

Cookie parser and serializer with Set-Cookie header management.

| Method | Description |
|---|---|
| `parse(header)` | Parse Cookie header → object |
| `serialize(name, value, opts)` | Create Set-Cookie string |
| `set(res, name, value, opts)` | Append Set-Cookie header |
| `setAll(res, map, opts)` | Set multiple cookies at once |
| `clear(res, name, opts)` | Expire a cookie |
| `get(cookies, name)` | Read from parsed cookies |
| `has(cookies, name)` | Check if cookie exists |

Options: `maxAge`, `expires`, `domain`, `path`, `secure`, `httpOnly`, `sameSite`

**Implementation:** `serialize` validates name against RFC 6265 token pattern, validates domain/path formats. `set` reads existing `Set-Cookie` header and appends (supports multiple cookies). `clear` sets `maxAge: 0` + `expires: epoch`.

### Escaping System

Context-aware output escaping supporting 11 contexts:

| Context | Function | Use case |
|---|---|---|
| `htmlContent` | `safeText(v)` | Text nodes |
| `htmlAttribute` | `safeAttr(name, v)` | Quoted attribute values |
| `htmlAttributeUnquoted` | `escapeAny(v, {...})` | Unquoted attribute values |
| `htmlComment` | `escapeAny(v, {context: 'htmlComment'})` | HTML comments |
| `jsString` | Auto-detected for `on*` attributes | JS string literals |
| `jsTemplate` | `escapeAny(v, {context: 'jsTemplate'})` | Template literals |
| `scriptData` | `escapeAny(v, {context: 'scriptData'})` | `<script>` content |
| `cssString` | Auto-detected for `style` attribute | CSS string values |
| `cssIdent` | `escapeAny(v, {context: 'cssIdent'})` | CSS identifiers |
| `cssUrl` | `escapeAny(v, {context: 'cssUrl'})` | CSS `url()` values |
| `url` | Auto-detected for href/src/action | URL attributes |
| `urlComponent` | `escapeAny(v, {context: 'urlComponent'})` | URL query params |

**URL policy:** Configurable allowed protocols (default: http, https, mailto, tel, data). Data URIs filtered by MIME type whitelist. Blocked URLs resolve to `about:blank`, empty string, or throw (configurable).

**Auto-detection:** When `context: 'auto'` (default), the context is inferred from `targetName` (attribute name): `on*` → jsString, `style` → cssString, `href/src/action` → url, quoted → htmlAttribute, unquoted → htmlAttributeUnquoted.

### Server (xdSrv.createApp)

| Feature | Details |
|---|---|
| Routing | GET, POST, PUT, DELETE, HEAD with `:param` patterns |
| Middleware | Global + path-scoped, async-compatible |
| Body parsing | JSON + URL-encoded |
| Static files | Extension-based MIME, `no-store` cache |
| SPA mode | Fallback to `/index.html` |
| Sessions | In-memory via xdRedis, cookie-based SID |
| CORS | Wildcard origin, configurable methods/headers |
| Rate limiting | IP-based, 100 req / 15 min window (array-based) |

**Response helpers:** `res.status(n)`, `res.set(k, v)`, `res.json(d)`, `res.html(h)`, `res.send(d)`, `res.redirect(code, url)`, `res.safeHtml(h)`, `res.safeJson(d)`

**Session API:** `req.session` (object), `req.saveSession()`, `req.destroySession()`

## Limitations vs Standard/Pro

- No WebSocket
- No HTTPS (despite import — only used for proxy targets)
- Session IDs are not cryptographically signed
- No multipart form parsing
- No ETag / conditional requests / range requests
- No security response headers
- No trust proxy support
- Static files use `no-store` (no caching)
- Rate limiter stores raw timestamp arrays (memory-heavy under load)
