# xdSrv — none (Micro Build)

**Version:** 7.4.4 | **Size:** ~80 LOC (+ minified variant) | **Dependencies:** 0

The smallest possible xdSrv build. A single-function HTTP server with routing, middleware pipeline and static file serving — nothing else.

## Files

| File | Size | Description |
|---|---|---|
| `xdSrv.js` | ~80 LOC | Readable source |
| `xdSrv.min.js` | ~2 KB | Minified single-line build |

## API

### `xdSrv.build(options?) → app`

Creates a server instance.

| Option | Type | Default | Description |
|---|---|---|---|
| `s` | string | `'.'` | Static files root directory |

### App Methods

```js
app.get(path, handler)     // Register GET route
app.post(path, handler)    // Register POST route
app.put(path, handler)     // Register PUT route
app.delete(path, handler)  // Register DELETE route
app.use([path], middleware) // Register middleware
app.listen(port, cb?)      // Start server (returns raw http.Server)
```

### Request Object

| Property | Type | Description |
|---|---|---|
| `req.p` | string | Pathname (`/api/users`) |
| `req.q` | object | Parsed query params |
| `req.params` | object | Route params from `:param` patterns |
| `req.body` | any | Parsed body (POST/PUT — auto JSON parse) |

### Response Object

| Method | Description |
|---|---|
| `res.j(data)` | Send JSON response |
| `res.s(data)` | Send — auto-detects object→JSON or string |

## Implementation Details

**Routing:** Routes are stored per HTTP method in arrays. Matching is sequential — first exact match wins, then regex for parameterized routes (`:param` syntax). Regex patterns use named capture groups.

**Middleware pipeline:** Executed sequentially via recursive `next()` calls. Supports async middleware. Errors in middleware result in 500 response.

**Body parsing:** Only triggers for non-GET/DELETE methods. Collects chunks, concatenates, attempts `JSON.parse`, falls back to raw string.

**Static files:** Uses `fs.stat` + `createReadStream` with proper Content-Type from extension map and Content-Length from file stats. Falls back to 404.

**Variable naming convention:** Single-letter imports and internal variables (`H` = createServer, `R` = createReadStream, `P` = resolve, `E` = extname, `M` = MIME map) to minimize footprint.

## Usage

```js
import xdSrv from './xdSrv.js'

const app = xdSrv.build({ s: './public' })

app.use((req, res, next) => {
 res.setHeader('x-powered-by', 'xdSrv/none')
 next()
})

app.get('/api/status', (req, res) => res.j({ ok: true }))

app.get('/api/users/:id', (req, res) => {
 res.j({ userId: req.params.id })
})

app.post('/api/echo', (req, res) => {
 res.j({ received: req.body })
})

app.listen(3000)
```

## Limitations

- No HTTPS support
- No WebSocket
- No sessions or cookies
- No CORS or rate limiting
- No security headers or XSS escaping
- No ETag / conditional requests
- No multipart form parsing
- Body parsing is basic (JSON or raw string only)
- No SPA fallback mode

## When to Use

- Quick prototypes and throwaway scripts
- Internal dev servers
- Lightweight microservices behind a reverse proxy
- Situations where every byte matters
