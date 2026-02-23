# xdSrv

Zero-dependency HTTP/HTTPS/WebSocket server framework for Node.js built entirely with vanilla JavaScript and native `node:` modules.

## Overview

xdSrv ships as **four distinct builds** — from a ~60-line micro-server to a production-grade framework with WebSocket, compression, CSRF, graceful shutdown and more. Every build follows the same philosophy: no external packages, no transpilers, no `class` keyword.

| Build | Version | LOC ≈ | HTTP | WS | Sessions | Security | Extras |
|---|---|---|---|---|---|---|---|
| **none** | 7.4.4 | 80 | ✅ | — | — | — | Minimal routing + static |
| **base** | 11.0.0 | 750 | ✅ | — | ✅ | ✅ XSS escape | Proxy, LRU, Redis, Queue |
| **standard** | 1.5.0 | 1 600 | ✅ | ✅ | ✅ signed | ✅ headers | ETag, Range, Multipart |
| **pro** | 6.6.6 | 2 800 | ✅ | ✅ | ✅ encrypted | ✅ full | Compression, CSRF, Logger, Validator, EventBus, Health, Graceful shutdown |

## Architecture

```
xdSrv/
├── none/          # Micro build — routing, static, middleware
│   ├── xdSrv.js
│   └── xdSrv.min.js
├── base/          # Core build — adds Redis, LRU, proxy, cookies, escaping
│   └── xdSrv.js
├── standard/      # Standard build — adds WebSocket, multipart, signed sessions
│   └── xdSrv.js
└── pro/           # Production build — full feature set
    └── xdSrv.js
```

Each build is a single self-contained ES module. No build step required — import directly.

## Quick Start

```js
// Pick your build
import { xdSrv } from './pro/xdSrv.js'

const app = xdSrv.createApp({
 static: './public',
 spa: true,
 cors: true,
 sessionSecret: 'my-secret-key'
})

app.get('/api/hello', (req, res) => {
 res.json({ message: 'Hello from xdSrv' })
})

app.post('/api/data', (req, res) => {
 res.json({ received: req.body })
})

app.listen(3000)
```

### None build (micro)

```js
import xdSrv from './none/xdSrv.js'

const app = xdSrv.build({ s: './public' })

app.get('/api/ping', (req, res) => res.j({ ok: true }))
app.listen(3000)
```

### WebSocket (standard / pro)

```js
app.ws('/chat', (ws) => {
 ws.on('message', (msg) => {
  app.broadcast(`Echo: ${msg}`, { exclude: ws })
 })
})
```

## Shared Components

All builds (except `none`) share a common set of utilities:

### xdLRU — LRU Cache

```js
import { xdLRU } from './base/xdSrv.js'

const cache = xdLRU({ max: 1000, ttl: 60000 })
cache.set('key', 'value')
cache.get('key') // 'value'
```

### xdRedis — In-Memory Redis-Like Store

Supports strings, lists, hashes, sets, TTL, pattern-based key search and a built-in task queue with retry + DLQ.

```js
import { xdRedis } from './base/xdSrv.js'

const store = xdRedis({ max: 5000 })
store.set('user:1', 'Alice', { ttl: 3600 })
store.hset('config', 'theme', 'dark')
store.sadd('tags', 'js', 'node', 'server')
store.lpush('queue', 'task1', 'task2')
```

### xdCookie — Cookie Parser / Serializer

```js
import { xdCookie } from './base/xdSrv.js'

const cookies = xdCookie.parse(req.headers.cookie)
xdCookie.set(res, 'token', 'abc123', {
 httpOnly: true,
 secure: true,
 sameSite: 'Strict',
 maxAge: 86400
})
```

### XSS / Injection Escaping

Context-aware escaping for HTML content, attributes, JS strings, CSS, URLs.

```js
import { escapeAny, safeText, safeAttr, safeUrlAttr } from './base/xdSrv.js'

safeText('<script>alert(1)</script>')
// &lt;script&gt;alert(1)&lt;/script&gt;

safeAttr('title', 'He said "hello"')
// title="He said &quot;hello&quot;"

safeUrlAttr('href', 'javascript:alert(1)')
// href="about:blank"
```

## Configuration Reference

Options for `xdSrv.createApp(options)`:

| Option | Type | Default | Builds | Description |
|---|---|---|---|---|
| `static` | string | `'./public'` | all | Static files root directory |
| `spa` | boolean | `true` | base+ | Fallback to index.html for unmatched routes |
| `cors` | boolean/object | `true` | base+ | Enable CORS middleware |
| `rateLimit` | boolean/object | `true` | base+ | Enable rate limiting |
| `logs` | boolean | `true` | base+ | Request logging |
| `maxBody` | number | `1048576` | base+ | Max request body size in bytes |
| `sessionSecret` | string | auto-generated | base+ | Session signing/encryption secret |
| `https` | boolean | `false` | base+ | Enable HTTPS |
| `tls` | object | `{}` | base+ | TLS options (key, cert) |
| `trustProxy` | boolean | `false` | standard+ | Trust X-Forwarded-* headers |
| `secureHeaders` | boolean | `true` | standard+ | Security response headers |
| `staticMaxAge` | number | `0` | standard+ | Static file Cache-Control max-age |
| `compression` | boolean/object | `false` | pro | Enable brotli/gzip/deflate |
| `sessionEncrypt` | boolean | `false` | pro | AES-256-GCM session encryption |
| `healthCheck` | boolean/object | `true` | pro | Health check endpoint |
| `gracefulShutdown` | boolean | `true` | pro | Graceful shutdown handler |
| `requestTimeout` | number | `0` | pro | Request timeout in ms |
| `wsMaxPayload` | number | `16MB` | standard+ | WebSocket max payload |
| `wsPingInterval` | number | `30000` | standard+ | WebSocket ping interval |
| `logLevel` | string | `'INFO'` | pro | Log level (TRACE-FATAL) |
| `logFormat` | string | `'text'` | pro | Log format (text/json) |

## Build Comparison

### none
Ideal for quick prototypes, internal tools, dev servers. ~80 lines of code. Minified version included.

### base
Adds the full utility layer (LRU, Redis, cookies, escaping, proxy) plus sessions, CORS, rate limiting. Good for APIs that don't need WebSocket.

### standard
Adds WebSocket (RFC 6455), signed sessions, multipart parsing, ETag/conditional requests, range requests, security headers. Production-ready for most apps.

### pro
Full production framework. Adds structured logging, input validation, event bus, compression, CSRF protection, idempotency, health checks, graceful shutdown, AES encryption, AsyncLocalStorage request context, route-level middleware.

## Routing

All builds support the same core routing API:

```js
app.get('/users', handler)
app.post('/users', handler)
app.put('/users/:id', handler)
app.delete('/users/:id', handler)

// Pro build also supports:
app.patch('/users/:id', handler)
app.options('/users', handler)
app.all('/health', handler)
```

Dynamic parameters are available via `req.params`:

```js
app.get('/users/:id/posts/:postId', (req, res) => {
 const { id, postId } = req.params
 res.json({ userId: id, postId })
})
```

## Middleware

```js
// Global middleware
app.use((req, res, next) => {
 console.log(`${req.method} ${req.path}`)
 next()
})

// Path-scoped middleware
app.use('/api', authMiddleware)

// Route-level middleware (pro build)
app.get('/admin', authMiddleware, adminHandler)
```

## License

MIT — Jakub Śledzikowski
