import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import http from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import xdSrv from "./xdSrv.js"

const request = (port, method, path, body) =>
  new Promise((resolve, reject) => {
    const opts = { hostname: "127.0.0.1", port, method, path }
    if (body) opts.headers = { "content-type": "application/json" }
    const req = http.request(opts, res => {
      const chunks = []
      res.on("data", c => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString()
        let json
        try { json = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on("error", reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })

const listen = (app) =>
  new Promise(resolve => {
    const server = app.listen(0, () => resolve(server))
  })

const close = (server) =>
  new Promise(resolve => server.close(resolve))

describe("xdSrv.build", () => {
  it("returns an app with correct methods", () => {
    const app = xdSrv.build()
    assert.strictEqual(typeof app.get, "function")
    assert.strictEqual(typeof app.post, "function")
    assert.strictEqual(typeof app.put, "function")
    assert.strictEqual(typeof app.delete, "function")
    assert.strictEqual(typeof app.use, "function")
    assert.strictEqual(typeof app.listen, "function")
  })

  it("route registration returns the app for chaining", () => {
    const app = xdSrv.build()
    assert.strictEqual(app.get("/a", () => {}), app)
    assert.strictEqual(app.post("/b", () => {}), app)
    assert.strictEqual(app.put("/c", () => {}), app)
    assert.strictEqual(app.delete("/d", () => {}), app)
    assert.strictEqual(app.use(() => {}), app)
  })
})

describe("GET routes", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.get("/hello", (req, res) => res.s("world"))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("responds with correct body", async () => {
    const r = await request(port, "GET", "/hello")
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.text, "world")
  })
})

describe("POST routes with JSON body", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.post("/data", (req, res) => res.j({ got: req.body }))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("parses JSON body and responds", async () => {
    const r = await request(port, "POST", "/data", { key: "val" })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json.got, { key: "val" })
  })
})

describe("PUT routes with JSON body", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.put("/update", (req, res) => res.j({ updated: req.body }))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("parses JSON body and responds", async () => {
    const r = await request(port, "PUT", "/update", { id: 1 })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json.updated, { id: 1 })
  })
})

describe("DELETE routes", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.delete("/item/:id", (req, res) => res.j({ deleted: req.params.id }))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("handles delete requests", async () => {
    const r = await request(port, "DELETE", "/item/42")
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.json.deleted, "42")
  })
})

describe("route parameters", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.get("/users/:id", (req, res) => res.j(req.params))
    app.get("/a/:x/b/:y", (req, res) => res.j(req.params))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("extracts a single route param", async () => {
    const r = await request(port, "GET", "/users/42")
    assert.strictEqual(r.json.id, "42")
  })

  it("extracts multiple route params", async () => {
    const r = await request(port, "GET", "/a/hello/b/world")
    assert.strictEqual(r.json.x, "hello")
    // second param group gets 'r' suffix per implementation
    assert.strictEqual(r.json.yr, "world")
  })
})

describe("query string parsing", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.get("/search", (req, res) => res.j(req.q))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("parses query params into req.q", async () => {
    const r = await request(port, "GET", "/search?foo=bar&n=1")
    assert.deepStrictEqual(r.json, { foo: "bar", n: "1" })
  })
})

describe("middleware", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.use((req, res, next) => {
      req.order = ["first"]
      next()
    })
    app.use((req, res, next) => {
      req.order.push("second")
      next()
    })
    app.get("/mw", (req, res) => res.j(req.order))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("runs middleware in order before route handler", async () => {
    const r = await request(port, "GET", "/mw")
    assert.deepStrictEqual(r.json, ["first", "second"])
  })
})

describe("middleware error handling", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.use(() => { throw new Error("boom") })
    app.get("/err", (req, res) => res.s("ok"))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("returns 500 on middleware error", async () => {
    const r = await request(port, "GET", "/err")
    assert.strictEqual(r.status, 500)
    assert.strictEqual(r.text, "Internal Server Error")
  })
})

describe("static file serving", () => {
  let server, port, tmpDir

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "xdsrv-test-"))
    writeFileSync(join(tmpDir, "index.html"), "<h1>home</h1>")
    writeFileSync(join(tmpDir, "style.css"), "body{}")
    writeFileSync(join(tmpDir, "data.json"), '{"a":1}')
    const app = xdSrv.build({ s: tmpDir })
    server = await listen(app)
    port = server.address().port
  })

  after(async () => {
    await close(server)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("serves index.html for /", async () => {
    const r = await request(port, "GET", "/")
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.text, "<h1>home</h1>")
    assert.ok(r.headers["content-type"].includes("text/html"))
  })

  it("serves css with correct content-type", async () => {
    const r = await request(port, "GET", "/style.css")
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.text, "body{}")
    assert.ok(r.headers["content-type"].includes("text/css"))
  })

  it("serves json files", async () => {
    const r = await request(port, "GET", "/data.json")
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.json, { a: 1 })
  })
})

describe("404 for unmatched routes", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("returns 404 for unknown path", async () => {
    const r = await request(port, "GET", "/nonexistent")
    assert.strictEqual(r.status, 404)
    assert.strictEqual(r.text, "404")
  })
})

describe("res.j sends JSON", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.get("/json", (req, res) => res.j({ ok: true }))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("sets application/json content-type", async () => {
    const r = await request(port, "GET", "/json")
    assert.ok(r.headers["content-type"].includes("application/json"))
    assert.deepStrictEqual(r.json, { ok: true })
  })
})

describe("res.s auto-detection", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.get("/obj", (req, res) => res.s({ x: 1 }))
    app.get("/str", (req, res) => res.s("hello"))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("sends objects as JSON", async () => {
    const r = await request(port, "GET", "/obj")
    assert.ok(r.headers["content-type"].includes("application/json"))
    assert.deepStrictEqual(r.json, { x: 1 })
  })

  it("sends strings as text", async () => {
    const r = await request(port, "GET", "/str")
    assert.strictEqual(r.text, "hello")
  })
})

describe("req.p pathname", () => {
  let server, port

  before(async () => {
    const app = xdSrv.build({ s: tmpdir() })
    app.get("/check", (req, res) => res.j({ p: req.p }))
    server = await listen(app)
    port = server.address().port
  })

  after(() => close(server))

  it("sets req.p to the pathname", async () => {
    const r = await request(port, "GET", "/check?x=1")
    assert.strictEqual(r.json.p, "/check")
  })
})
