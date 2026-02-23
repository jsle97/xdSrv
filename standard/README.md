# xdSrv — standard (Standard Build)

**Version:** 1.5.0 | **Size:** ~1 600 LOC | **Dependencies:** 0

Production-capable HTTP/HTTPS/WebSocket server. Extends the core utility set with a full RFC 6455 WebSocket implementation, signed sessions, multipart form parsing, ETag/conditional requests, byte-range serving and security headers.

## Imports

```
node:http, node:https, node:fs/promises, node:fs, node:path, node:crypto, node:events
```

## Exports

```js
export {
 xdRedis,                        // In-memory Redis store
 xdLRU,                          // LRU cache
 xdCookie,                       // Cookie management
 escapeAny, safeText, safeAttr, safeUrlAttr,  // XSS escaping
 errorHandler,                   // Error middleware
 cors,                           // CORS middleware
 createRateLimiter,              // Rate limiter factory
 rateLimiterMiddleware,          // Default rate limiter instance
 xdWebSocket,                    // WebSocket utilities
 xdSrv                           // Server factory
}
```

## What's New vs Base

| Feature | Base | Standard |
|---|---|---|
| WebSocket | — | ✅ Full RFC 6455 |
| HTTPS | proxy only | ✅ native |
| Sessions | unsigned SID | ✅ HMAC-signed SID |
| Session locks | — | ✅ async mutex |
| Body parsing | JSON + urlencoded | + multipart/form-data |
| Static files | basic pipe | + ETag + 304 + Range |
| Security headers | — | ✅ X-Frame, Referrer-Policy, COOP, CORP |
| Trust proxy | — | ✅ X-Forwarded-For/Proto |
| Rate limiter | array-based | ✅ LRU-backed with headers |

## WebSocket Implementation

Full RFC 6455 implementation built directly on raw TCP sockets.

### Server-Side API

```js
app.ws('/chat', (ws) => {
 ws.on('message', (data, isBinary) => {
  ws.send(`Echo: ${data}`)
 })

 ws.on('close', (code, reason) => {
  console.log('Client disconnected:', code, reason)
 })

 ws.on('error', (err) => console.error(err))
 ws.on('ping', (data) => { /* auto-ponged */ })
 ws.on('pong', (data) => { /* heartbeat response */ })
})

// Broadcast to all connected clients
app.broadcast('Hello everyone', {
 exclude: specificClient,     // Skip specific client(s)
 filter: (ws) => ws.path === '/chat'  // Filter recipients
})

// Access all connected clients
app.getWsClients() // Set<WebSocket>
```

### WebSocket Object

| Property/Method | Description |
|---|---|
| `ws.readyState` | 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED |
| `ws.send(data, {binary?})` | Send text or binary frame |
| `ws.close(code?, reason?)` | Initiate close handshake |
| `ws.ping(data?)` | Send ping frame |
| `ws.pong(data?)` | Send pong frame |
| `ws.terminate()` | Force-close without handshake |
| `ws.socket` | Underlying TCP socket |
| `ws.request` | Original HTTP upgrade request |
| `ws.path` | WebSocket path |
| `ws.query` | Parsed query parameters |
| `ws.params` | Route parameters |
| `ws.cookies` | Parsed cookies |

### Implementation Details

**Upgrade handshake:** Validates `Sec-WebSocket-Version: 13`, computes `Sec-WebSocket-Accept` using SHA-1 of key + GUID. Supports sub-protocol negotiation via `Sec-WebSocket-Protocol`.

**Frame parsing:** Reads frames from a receive buffer. Validates RSV bits (must be 0), requires client masking. Handles 7-bit, 16-bit and 64-bit payload lengths. Unmasking via XOR with 4-byte mask.

**Fragmentation:** Continuation frames are buffered and concatenated. Validates frame sequence (no unexpected continuation, no data frame during fragmentation).

**Control frames:** CLOSE triggers close handshake echo + connection teardown. PING triggers automatic PONG response. PONG clears heartbeat timeout.

**Heartbeat:** Configurable ping interval + pong timeout. Missing pong triggers close with code 1006.

**Payload limits:** Configurable `maxPayload` (default 16 MB). Oversized frames trigger close with code 1009.

## Session Management

Sessions use HMAC-SHA256 signed cookie IDs to prevent session fixation attacks.

```js
// Session is auto-initialized on every request
app.post('/login', async (req, res) => {
 req.session.userId = 123
 await req.saveSession()
 res.json({ ok: true })
})

app.get('/profile', (req, res) => {
 res.json({ userId: req.session.userId })
})

app.post('/logout', async (req, res) => {
 await req.destroySession()
 res.json({ ok: true })
})
```

**Implementation:** SID format is `{random_base64url}.{hmac_signature}`. On request, the signature is verified before accepting the SID. Invalid/missing SIDs generate a new session. Session data is stored in xdRedis with 1-hour TTL. Concurrent session writes are serialized via an async lock (promise chain per SID).

## Static File Serving

| Feature | Description |
|---|---|
| ETag | Weak ETag based on file size + mtime |
| Conditional | `If-None-Match` / `If-Modified-Since` → 304 |
| Range | `bytes=start-end` → 206 Partial Content |
| Cache-Control | Configurable `max-age` via `staticMaxAge` option |
| MIME types | 20+ built-in types, extensible |
| Security | `X-Content-Type-Options: nosniff` on non-HTML |
| Path traversal | `path.resolve` + prefix check against static root |
| Streaming | `fs.createReadStream` with proper Content-Length |

## Multipart Form Parsing

```js
app.post('/upload', (req, res) => {
 // req.body = { fields: {name: 'test'}, files: [{name, filename, contentType, data}] }
 const file = req.body.files[0]
 res.json({ uploaded: file.filename, size: file.data.length })
})
```

| Limit | Default | Description |
|---|---|---|
| `maxFileSize` | 10 MB | Per-file size limit |
| `maxFiles` | 10 | Max files per request |
| `maxFields` | 100 | Max form fields |

**Implementation:** Parses multipart boundary from Content-Type header. Splits buffer by boundary markers, extracts Content-Disposition for field name/filename, Content-Type for MIME. Files are stored as Buffer objects in memory. Exceeding limits throws coded errors (`LIMIT_FILE_SIZE`, `LIMIT_FILE_COUNT`).

## Rate Limiter

LRU-backed rate limiter with proper HTTP headers.

```js
// Custom configuration
import { createRateLimiter } from './standard/xdSrv.js'

app.use(createRateLimiter(
 60 * 1000,  // 1 minute window
 30          // 30 requests max
))
```

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` (on 429).

**Implementation:** Uses `xdLRU` with window TTL. Each IP gets a `{count, reset}` record. Counter increments per request. When count exceeds max, returns 429 with retry timing.

## Security Headers

Applied by default when `secureHeaders: true`:

```
X-Frame-Options: SAMEORIGIN
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff  (on static non-HTML files)
```

## Limitations vs Pro

- No structured logging (uses console.log)
- No input validation framework
- No event bus
- No compression (brotli/gzip)
- No CSRF protection
- No idempotency middleware
- No health check endpoint
- No graceful shutdown
- No request timeout
- No session encryption
- No AsyncLocalStorage request context
- No route-level middleware
- No PATCH method
- Session SID is signed but not encrypted
- No stat caching for static files
