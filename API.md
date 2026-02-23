# xdSrv — API Reference

Complete API reference for all builds. Methods marked with build badges indicate minimum required build.

---

## Server Factory

### `xdSrv.createApp(options)` — base | standard | pro
### `xdSrv.build(options)` — none

Creates and returns an `app` instance.

---

## App Instance

### Routing

| Method | Signature | Build |
|---|---|---|
| `app.get` | `(pattern, ...handlers)` | all |
| `app.post` | `(pattern, ...handlers)` | all |
| `app.put` | `(pattern, ...handlers)` | all |
| `app.delete` | `(pattern, ...handlers)` | all |
| `app.patch` | `(pattern, ...handlers)` | pro |
| `app.options` | `(pattern, ...handlers)` | pro |
| `app.all` | `(pattern, ...handlers)` | pro |

Route patterns support `:param` syntax: `/users/:id/posts/:postId`

### Middleware

| Method | Signature | Build |
|---|---|---|
| `app.use` | `([path], middleware)` | all |

### WebSocket

| Method | Signature | Build |
|---|---|---|
| `app.ws` | `(pattern, handler)` | standard+ |
| `app.broadcast` | `(data, {filter?, exclude?, binary?})` | standard+ |
| `app.getWsClients` | `() → Set<WebSocket>` | standard+ |

### Lifecycle

| Method | Signature | Build |
|---|---|---|
| `app.listen` | `(port, callback?) → app` | all |
| `app.close` | `(callback?)` | pro |

### Accessors (pro)

| Property | Type | Description |
|---|---|---|
| `app.server` | http.Server | Underlying Node.js server |
| `app.logger` | Logger | Structured logger instance |
| `app.eventBus` | EventBus | Event bus instance |
| `app.sessionStore` | xdRedis | Session store |
| `app.healthCheck` | HealthCheck | Health check instance |
| `app.gracefulShutdown` | GracefulShutdown | Shutdown controller |
| `app.getRoutes()` | object | Map of method → patterns |
| `app.invalidateStatCache(path?)` | void | Clear stat cache |
| `app.getStatCacheStats()` | object | Stat cache hit/miss |

---

## Request Object

### Properties (all builds)

| Property | Type | Build | Description |
|---|---|---|---|
| `req.p` / `req.path` | string | none / base+ | URL pathname |
| `req.q` / `req.query` | object | none / base+ | Parsed query params |
| `req.params` | object | all | Route parameters |
| `req.body` | any | all | Parsed request body |

### Properties (base+)

| Property | Type | Description |
|---|---|---|
| `req.cookies` | object | Parsed cookies |
| `req.session` | object | Session data |
| `req.headers` | object | Request headers |

### Properties (standard+)

| Property | Type | Description |
|---|---|---|
| `req.hostname` | string | Host without port |
| `req.secure` | boolean | HTTPS connection |
| `req.ip` | string | Client IP (respects trust proxy) |

### Properties (pro)

| Property | Type | Description |
|---|---|---|
| `req.protocol` | string | `'http'` or `'https'` |
| `req.originalUrl` | string | Original URL before rewrite |
| `req.currentSessionId` | string | Active session ID |
| `req.csrfToken` | string | CSRF token (when middleware active) |

### Methods

| Method | Build | Description |
|---|---|---|
| `req.saveSession()` | base+ | Persist session + set cookie |
| `req.destroySession()` | base+ | Delete session + clear cookie |
| `req.regenerateSession()` | pro | New SID, preserve nothing |
| `req.generateCsrfToken()` | pro | Get current CSRF token |

---

## Response Object

### Methods (none)

| Method | Description |
|---|---|
| `res.j(data)` | Send JSON |
| `res.s(data)` | Send auto-detect (object→JSON, else string) |

### Methods (base+)

| Method | Description |
|---|---|
| `res.status(code)` | Set status code (chainable) |
| `res.set(key, value)` | Set header (chainable) |
| `res.json(data)` | Send JSON with Content-Type |
| `res.html(html)` | Send HTML with Content-Type |
| `res.send(data)` | Auto-detect: object→json, buffer→binary, else string |
| `res.redirect(code, url)` | Send redirect response |
| `res.safeHtml(html)` | Send HTML-escaped content |
| `res.safeJson(data)` | Send JSON (alias) |

### Methods (pro)

| Method | Description |
|---|---|
| `res.get(key)` | Get response header |
| `res.vary(value)` | Append Vary header |
| `res.type(contentType)` | Set Content-Type |
| `res.download(path, filename?)` | Stream file as attachment |
| `res.cookie(name, value, opts)` | Set cookie |
| `res.clearCookie(name, opts)` | Clear cookie |

---

## xdLRU

```js
const cache = xdLRU({ max, ttl, updateAgeOnGet, dispose })
```

| Method | Signature | Returns |
|---|---|---|
| `get` | `(key)` | value \| undefined |
| `set` | `(key, value, {ttl?})` | this (base) / true (standard+) |
| `has` | `(key)` | boolean |
| `delete` | `(key)` | void (base) / boolean (standard+) |
| `clear` | `()` | void |
| `peek` | `(key)` | value \| undefined (base only) |
| `prune` | `()` | void (base only) |
| `keys` | `()` | Iterator |
| `size` | getter | number |
| `stats` | `()` | `{hits, misses, ratio, size, maxSize}` (pro) |

---

## xdRedis

```js
const store = xdRedis({ max })
```

### Key Operations

| Method | Signature | Returns |
|---|---|---|
| `exists` | `(key)` | boolean |
| `del` | `(key)` | void/boolean |
| `keys` | `(pattern?)` | string[] |
| `ttl` | `(key)` | seconds (-1=no TTL, -2=not found) |
| `expire` | `(key, seconds)` | 0 \| 1 |
| `persist` | `(key)` | 0 \| 1 (pro) |
| `rename` | `(key, newKey)` | 'OK' (pro) |
| `type` | `(key)` | string (pro) |
| `flushAll` | `()` | 'OK' |
| `dbsize` | `()` | number |

### String Operations

| Method | Signature | Returns |
|---|---|---|
| `set` | `(key, value, {ttl?})` | 'OK' |
| `get` | `(key)` | string \| null |
| `incr` | `(key)` | number |
| `decr` | `(key)` | number |
| `append` | `(key, string)` | length |
| `mset` | `(pairs)` | 'OK' (pro) |
| `mget` | `(...keys)` | string[] (pro) |
| `setnx` | `(key, value, {ttl?})` | 0 \| 1 (pro) |
| `getset` | `(key, value)` | old value (pro) |
| `incrby` | `(key, n)` | number (pro) |
| `decrby` | `(key, n)` | number (pro) |

### List Operations

| Method | Signature | Returns |
|---|---|---|
| `lpush` | `(key, ...elements)` | length |
| `rpush` | `(key, ...elements)` | length |
| `lpop` | `(key)` | string \| null |
| `rpop` | `(key)` | string \| null |
| `lrange` | `(key, start, end)` | string[] |
| `llen` | `(key)` | number (pro) |
| `lindex` | `(key, index)` | string \| null (pro) |

### Hash Operations

| Method | Signature | Returns |
|---|---|---|
| `hset` | `(key, field, value)` | 0 \| 1 |
| `hget` | `(key, field)` | string \| null |
| `hdel` | `(key, ...fields)` | count |
| `hkeys` | `(key)` | string[] |
| `hgetall` | `(key)` | object |
| `hvals` | `(key)` | string[] (pro) |
| `hlen` | `(key)` | number (pro) |
| `hexists` | `(key, field)` | 0 \| 1 (pro) |
| `hmset` | `(key, fieldValues)` | 'OK' (pro) |
| `hincrby` | `(key, field, n)` | number (pro) |

### Set Operations

| Method | Signature | Returns |
|---|---|---|
| `sadd` | `(key, ...members)` | count added |
| `srem` | `(key, ...members)` | count removed |
| `smembers` | `(key)` | string[] |
| `sismember` | `(key, member)` | 0 \| 1 |
| `scard` | `(key)` | number (pro) |
| `srandmember` | `(key)` | string \| null (pro) |
| `sunion` | `(...keys)` | string[] (pro) |
| `sinter` | `(...keys)` | string[] (pro) |

### Queue

```js
const queue = store.xdRedisQueue(queueKey, worker, options)  // base
const queue = store.createRedisQueue(queueKey, worker, options) // standard+
```

| Method/Property | Type | Description |
|---|---|---|
| `enqueue(task)` | method | Add task to queue |
| `stop()` | method | Stop processing |
| `length` | getter | Pending tasks |
| `isRunning` | getter | Queue active |
| `getDLQName()` | method | DLQ key name |
| `dlqLength` | getter | Failed tasks |
| `viewDLQ(start?, end?)` | method | Inspect DLQ |

---

## xdCookie

| Method | Signature | Description |
|---|---|---|
| `parse` | `(header) → object` | Parse Cookie header |
| `serialize` | `(name, value, opts) → string` | Create Set-Cookie string |
| `set` | `(res, name, value, opts)` | Set cookie on response |
| `setAll` | `(res, map, opts)` | Set multiple cookies |
| `clear` | `(res, name, opts)` | Expire cookie |
| `get` | `(cookies, name) → string` | Read parsed cookie |
| `has` | `(cookies, name) → boolean` | Check cookie exists |
| `setEncrypted` | `(res, name, value, secret, opts)` | Set AES-encrypted cookie (pro) |
| `getEncrypted` | `(cookies, name, secret) → string` | Read encrypted cookie (pro) |

---

## Escaping

| Function | Signature | Context |
|---|---|---|
| `escapeAny` | `(value, options?) → string` | Any (auto-detect or explicit) |
| `safeText` | `(value) → string` | HTML content |
| `safeAttr` | `(name, value, {quoted?}) → string` | HTML attribute (name="value") |
| `safeUrlAttr` | `(name, url, opts?) → string` | URL attribute with protocol check |

---

## WebSocket Object (standard+)

| Property/Method | Type | Description |
|---|---|---|
| `readyState` | number | Connection state |
| `socket` | net.Socket | Raw TCP socket |
| `request` | http.IncomingMessage | Upgrade request |
| `path` | string | WebSocket URL path |
| `query` | object | Parsed query params |
| `params` | object | Route params |
| `cookies` | object | Parsed cookies |
| `stats` | object | Traffic stats (pro) |
| `send(data, {binary?})` | boolean | Send frame |
| `close(code?, reason?)` | void | Close handshake |
| `ping(data?)` | boolean | Send ping |
| `pong(data?)` | boolean | Send pong |
| `terminate()` | void | Force close |
| `on(event, handler)` | WebSocket | Subscribe |
| `once(event, handler)` | WebSocket | Subscribe once |
| `off(event, handler)` | WebSocket | Unsubscribe |

Events: `message`, `close`, `error`, `ping`, `pong`, `drain` (pro)
