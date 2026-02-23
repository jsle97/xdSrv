# xdSrv — pro (Production Build)

**Version:** 6.6.6 | **Size:** ~2 800 LOC | **Dependencies:** 0

Full production-grade server framework. Extends Standard with structured logging, input validation, event bus, compression (brotli/gzip/deflate), CSRF protection, idempotency, health checks, graceful shutdown, AES-256-GCM encryption, AsyncLocalStorage request context and route-level middleware.

## Imports

```
node:http, node:https, node:fs/promises, node:fs, node:path, node:crypto,
node:events, node:async_hooks, node:zlib, node:stream, node:util
```

## Exports

```js
// Framework
export { xdSrv }

// Data stores
export { xdRedis, xdLRU }

// Security
export { xdCookie, xdValidate, escapeAny, safeText, safeAttr, safeUrlAttr }
export { createCsrfProtection, createSecurityHeaders }
export { encryptAES256GCM, decryptAES256GCM, signData, verifySignature }

// Infrastructure
export { createLogger, xdEventBus, xdWebSocket }
export { createCompressionMiddleware, createRateLimiter, createCorsMiddleware }
export { createIdempotencyMiddleware, createHealthCheck, createGracefulShutdown }
export { createRequestTimeout, createStaticFileServer }
export { generateRequestId, generateSessionId, generateContentEtag }
export { errorHandler, cors, rateLimiterMiddleware }

// Constants
export { ERROR_CODES, LOG_LEVELS, REQUEST_METHODS, WS_READY_STATES, WS_OPCODES, DEFAULT_MIME_TYPES }

// Context
export { requestContext, getRequestContext, getRequestId }

// Utilities
export { safeJsonStringify, safeJsonParse }
```

## What's New vs Standard

| Feature | Standard | Pro |
|---|---|---|
| Logging | console.log | ✅ Structured logger (JSON/text) with redaction |
| Validation | — | ✅ Schema-based input validation |
| Event bus | — | ✅ Pub/sub with priorities |
| Compression | — | ✅ Brotli + gzip + deflate |
| CSRF | — | ✅ Token-based with HMAC signing |
| Idempotency | — | ✅ Header-based response caching |
| Health check | — | ✅ `/health` with custom checks |
| Graceful shutdown | — | ✅ Signal handling + connection draining |
| Request timeout | — | ✅ Configurable per-request timeout |
| Session encryption | signed | ✅ AES-256-GCM encrypted |
| Request context | — | ✅ AsyncLocalStorage with request ID |
| Route middleware | — | ✅ Per-route middleware chains |
| Static file cache | fs.stat per request | ✅ LRU stat cache |
| PATCH method | — | ✅ |
| OPTIONS method | — | ✅ |
| `app.all()` | — | ✅ |
| Backpressure | — | ✅ Static files + WebSocket |
| Error factory | — | ✅ Structured error objects |
| WS stats | — | ✅ bytes/messages sent/received |
| CORS | basic | ✅ Configurable (whitelist, regex, function) |
| Rate limiter | counter | ✅ Sliding window + token bucket |

## Components

### Structured Logger

JSON or text output with key redaction, child loggers and request context.

```js
import { createLogger } from './pro/xdSrv.js'

const logger = createLogger({
 level: 'DEBUG',
 format: 'json',
 redactKeys: ['password', 'token', 'secret']
})

logger.info('User logged in', { userId: 123 })
// {"timestamp":"...","level":"INFO","message":"User logged in","requestId":"abc123","data":{"userId":123}}

const childLogger = logger.child({ module: 'auth' })
childLogger.warn('Token expired')
```

Levels: `TRACE` (0) → `DEBUG` (1) → `INFO` (2) → `WARN` (3) → `ERROR` (4) → `FATAL` (5) → `SILENT` (6)

**Implementation:** Entries include timestamp, level, message, request ID (from AsyncLocalStorage), context and optional data. Redaction traverses object keys recursively, replacing matches with `[REDACTED]`. Circular references handled via WeakSet.

### AsyncLocalStorage Request Context

Every request runs in an isolated `AsyncLocalStorage` context carrying `requestId`, `startTime`, `method`, `url`.

```js
import { getRequestId, getRequestContext } from './pro/xdSrv.js'

app.get('/api/data', (req, res) => {
 const id = getRequestId() // Available anywhere in the call stack
 const ctx = getRequestContext()
 res.json({ requestId: id })
})
```

**Implementation:** `requestContext.run({...}, async () => { ... })` wraps the entire request handler. Logger, error factory and event bus automatically attach the current request ID.

### Input Validation (xdValidate)

Schema-based validation with built-in rules and sanitization.

```js
import { xdValidate } from './pro/xdSrv.js'

const { valid, errors, data } = xdValidate.validate(req.body, {
 email: { required: true, type: 'email', maxLength: 254 },
 age: { type: 'number', min: 18, max: 120 },
 role: { oneOf: ['admin', 'user', 'moderator'], default: 'user' },
 username: { 
  type: 'string', 
  minLength: 3, 
  maxLength: 32,
  pattern: /^[a-zA-Z0-9_]+$/,
  sanitize: (v) => v.trim().toLowerCase()
 }
})

if (!valid) return res.status(400).json({ errors })
```

Built-in rules: `required`, `string`, `number`, `integer`, `boolean`, `email`, `url`, `uuid`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `oneOf`, `array`, `object`, `date`, `alphanumeric`, `hex`, `ip`, `port`

Custom rules via `custom: (value, allData) => true | 'error message'`

### Event Bus (xdEventBus)

In-process pub/sub with priority support and wildcard listener.

```js
import { xdEventBus } from './pro/xdSrv.js'

const bus = xdEventBus()

const subId = bus.subscribe('user:created', async (envelope) => {
 console.log(envelope.data) // { id: 1, name: 'Alice' }
}, { priority: 10 })

bus.publish('user:created', { id: 1, name: 'Alice' })

// Wildcard - catches all events
bus.on('*', (envelope) => {
 console.log(`Event: ${envelope.event}`)
})

bus.unsubscribe(subId)
```

**Implementation:** Wraps Node.js `EventEmitter`. Each subscription gets a unique hex ID. Envelopes include `event`, `data`, `timestamp`, `id`, `requestId`. Errors in handlers are caught and re-emitted as `bus:error` events.

### Compression Middleware

Automatic response compression with brotli, gzip and deflate.

```js
const app = xdSrv.createApp({
 compression: true
 // or: compression: { threshold: 512, brotliEnabled: true }
})
```

| Option | Default | Description |
|---|---|---|
| `threshold` | 1024 | Min body size to compress |
| `level` | Z_DEFAULT | zlib compression level |
| `brotliEnabled` | true | Enable brotli (quality 4) |
| `filter` | null | Custom `(req, res) → boolean` filter |

Priority: brotli > gzip > deflate. Only compresses if result is smaller than original. Adds `Vary: Accept-Encoding`. Compressible types: text/*, application/json, application/javascript, application/xml, image/svg+xml, application/wasm.

**Implementation:** Intercepts `response.write` and `response.end` to buffer the response body. On `end`, selects encoding from `Accept-Encoding`, compresses synchronously (`brotliCompressSync` / `gzipSync` / `deflateSync`), compares sizes, sends compressed if smaller.

### CSRF Protection

HMAC-signed CSRF tokens with cookie + header validation.

```js
import { createCsrfProtection } from './pro/xdSrv.js'

const csrf = createCsrfProtection({ secret: 'my-csrf-secret' })
app.use(csrf.middleware)

// In GET handler, include token for client
app.get('/form', (req, res) => {
 res.html(`<input type="hidden" name="_csrf" value="${req.csrfToken}">`)
})

// POST/PUT/DELETE automatically validated
```

**Implementation:** Token format is `{random_hex}.{hmac_signature}`. Token stored in `_csrf` cookie (httpOnly: false so JS can read it). Safe methods (GET, HEAD, OPTIONS) skip validation. Unsafe methods check `x-csrf-token` header, `_csrf` body field, or `_csrf` query param.

### Idempotency Middleware

Caches responses for requests with `Idempotency-Key` header.

```js
import { createIdempotencyMiddleware } from './pro/xdSrv.js'

app.use(createIdempotencyMiddleware({
 ttl: 86400000,     // 24h cache
 methods: new Set(['POST', 'PUT', 'PATCH'])
}))
```

**Implementation:** Cache key = `idem:{method}:{path}:{idempotency-key}`. Intercepts `response.write`/`end` to capture the full response (status, headers, body). On cache hit, replays stored response with `x-idempotent-replayed: true` header. Hop-by-hop headers are excluded from replay.

### Health Check

```js
const app = xdSrv.createApp({
 healthCheck: {
  path: '/health',
  includeDetails: true,
  checks: {
   database: async () => { await db.ping(); return { latency: '2ms' }; },
   redis: async () => { store.set('health', '1'); return { keys: store.dbsize() }; }
  }
 }
})
```

Response: `{ status: 'ok'|'degraded', timestamp, uptime, memory, checks: {...} }`

### Graceful Shutdown

Handles SIGTERM/SIGINT, drains connections, closes WebSockets.

```js
const app = xdSrv.createApp({
 gracefulShutdown: true,
 shutdownTimeout: 30000 // Force kill after 30s
})

// Also adds middleware that returns 503 during shutdown
```

**Implementation:** Tracks all TCP connections via `server.on('connection')`. On signal: stops accepting new connections, runs custom `onShutdown` callback, closes idle connections via `conn.end()`, force-destroys remaining after timeout/2, calls `process.exit`. Also handles `uncaughtException` and `unhandledRejection`.

### Encryption

AES-256-GCM encryption for session data and arbitrary values.

```js
import { encryptAES256GCM, decryptAES256GCM } from './pro/xdSrv.js'

const encrypted = encryptAES256GCM('sensitive data', 'secret-key')
// "iv_base64url.ciphertext_base64url.authTag_base64url"

const decrypted = decryptAES256GCM(encrypted, 'secret-key')
// "sensitive data"
```

**Implementation:** Key derived via SHA-256 hash of secret. Random 12-byte IV per encryption. Output format: `{iv}.{ciphertext}.{authTag}` in base64url encoding. Decryption returns `null` on any failure (wrong key, tampered data, malformed input).

### Advanced Rate Limiter

Two algorithms: sliding window (default) and token bucket.

```js
import { createRateLimiter } from './pro/xdSrv.js'

// Sliding window
app.use(createRateLimiter({
 windowMs: 60000,
 max: 30,
 keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
 skip: (req) => req.path === '/health',
 message: 'Rate limit exceeded'
}))

// Token bucket
app.use(createRateLimiter({
 algorithm: 'token-bucket',
 windowMs: 60000,
 max: 100
}))
```

**Sliding window:** Stores timestamps array per key. Filters out expired timestamps on each request. Count = active timestamps in window.

**Token bucket:** Stores `{tokens, lastRefill}` per key. Tokens refill at `max / (windowMs/1000)` per second. Each request consumes 1 token.

### Advanced CORS

```js
const app = xdSrv.createApp({
 cors: {
  origin: ['https://app.example.com', 'https://admin.example.com'],
  // or: origin: /\.example\.com$/,
  // or: origin: (origin) => checkDatabase(origin),
  credentials: true,
  methods: 'GET, POST, PUT, DELETE',
  allowedHeaders: 'Content-Type, Authorization',
  exposedHeaders: 'X-Request-ID',
  maxAge: 86400
 }
})
```

### Route-Level Middleware

```js
const auth = (req, res, next) => {
 if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' })
 next()
}

const admin = (req, res, next) => {
 if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
 next()
}

app.get('/admin/users', auth, admin, (req, res) => {
 res.json({ users: [] })
})
```

### Security Headers Builder

```js
import { createSecurityHeaders } from './pro/xdSrv.js'

const security = createSecurityHeaders({
 frameOptions: 'DENY',
 hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
 csp: {
  'default-src': "'self'",
  'script-src': ["'self'", 'https://cdn.example.com'],
  'style-src': ["'self'", "'unsafe-inline'"]
 },
 permissionsPolicy: {
  camera: "'none'",
  microphone: "'none'",
  geolocation: "'self'"
 }
})

app.use(security.middleware)
```

### Error Factory

```js
import { createAppError, ERROR_CODES } from './pro/xdSrv.js'

throw createAppError('NOT_FOUND', {
 message: 'User not found',
 details: { userId: 123 },
 suggestion: 'Check the user ID and try again'
})
// Error with: status=404, code='NOT_FOUND', requestId, timestamp, isOperational=true
```

Available codes: BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, METHOD_NOT_ALLOWED, CONFLICT, PAYLOAD_TOO_LARGE, UNPROCESSABLE, TOO_MANY_REQUESTS, INTERNAL, BAD_GATEWAY, SERVICE_UNAVAILABLE, GATEWAY_TIMEOUT

### Static File Server Improvements

- **Stat cache:** LRU cache for `fs.stat` results (configurable TTL + max entries)
- **Dot files:** Configurable policy — `ignore` (skip) or `deny` (403)
- **Filename sanitization:** `path.basename` + strip non-word characters
- **Backpressure:** Pauses read stream when write buffer is full, resumes on `drain`
- **Weak ETags:** `W/"size-mtime"` format
- **Immutable cache:** `Cache-Control: immutable` for max-age > 86400

### WebSocket Improvements

- **Stats tracking:** `ws.stats` → `{ bytesReceived, bytesSent, messagesSent, messagesReceived }`
- **Buffer overflow protection:** Configurable `maxBufferSize` (default 64 MB)
- **Fragment size tracking:** Validates total fragmented message size against `maxPayload`
- **Optimized unmasking:** 4-byte XOR via `readUInt32BE` + `writeUInt32BE` for aligned chunks
- **Backpressure:** `socket.write` return value checked, `drain` event handled
