/* xdSrv.js - None Server Framework for Node.js
 * Version: 7.4.4 | License: MIT
 * Copyright (c) 2026 Jakub Śledzikowski <jsledzikowski.web@gmail.com>
 */

import { createServer as H } from "http"
import { stat } from "fs/promises"
import { createReadStream as R } from "fs"
import { resolve as P, extname as E } from "path"

const M = {
 html: "text/html;charset=utf-8",
 htm: "text/html;charset=utf-8",
 json: "application/json;charset=utf-8",
 js: "application/javascript;charset=utf-8",
 mjs: "application/javascript;charset=utf-8",
 css: "text/css;charset=utf-8",
 txt: "text/plain;charset=utf-8",
 svg: "image/svg+xml",
 png: "image/png",
 jpg: "image/jpeg",
 jpeg: "image/jpeg",
 gif: "image/gif",
 ico: "image/x-icon",
 woff: "font/woff",
 woff2: "font/woff2"
}

const methodMap = {
 GET: "G",
 POST: "P",
 DELETE: "D",
 PUT: "U",
 HEAD: "H"
}

const X = t => {
 const p = { G: [], P: [], D: [], U: [], H: [] }
 const i = []
 const c = P(t?.s || ".")

 const r = (method, e, handler) => {
  let regex = null
  if (e.includes(":")) {
   let n = 0
   regex = new RegExp(
    "^" +
     e.replace(/:(\w+)/g, (_, name) => `(?<${name}${1 < ++n ? "r" : ""}>[^/]+)`) +
     "$"
   )
  }
  p[methodMap[method]].push({ p: e, r: regex, h: handler })
 }

 const matchRoute = (method, pathname) => {
  for (const route of p[methodMap[method]]) {
   if (route.p === pathname) return { h: route.h, p: {} }
   if (route.r && route.r.test(pathname)) {
    const match = pathname.match(route.r)
    return { h: route.h, p: match ? match.groups : {} }
   }
  }
 }

 const a = H(async (n, o) => {
  const url = new URL(n.url, "http://" + (n.headers.host || "l"))
  n.p = url.pathname
  n.q = Object.fromEntries(url.searchParams)

  o.j = data => {
   o.setHeader("content-type", M.json)
   o.end(JSON.stringify(data))
  }
  o.s = data => {
   typeof data !== "object" || Buffer.isBuffer(data)
    ? o.end(String(data))
    : o.j(data)
  }

  let idx = 0
  const next = async () => {
   if (idx < i.length) {
    try {
     await i[idx++].m(n, o, next)
    } catch (err) {
     console.error(err)
     o.statusCode = 500
     o.end("Internal Server Error")
    }
    return
   }

   const matched = matchRoute(n.method, n.p)
   if (matched) {
    n.params = matched.p
    if (n.method !== "GET" && n.method !== "DELETE") {
     const chunks = []
     n.on("data", chunk => chunks.push(chunk))
     await new Promise(resolve =>
      n.on("end", () => {
       const raw = Buffer.concat(chunks).toString()
       try { n.body = JSON.parse(raw) } catch { n.body = raw }
       resolve()
      })
     )
    }
    return matched.h(n, o)
   }

   const filePath = P(c, "." + (n.p === "/" ? "/index.html" : n.p))
   try {
    const info = await stat(filePath)
    if (info.isFile()) {
     o.setHeader("content-type", M[E(filePath).slice(1)] || "text/plain")
     o.setHeader("content-length", info.size)
     R(filePath).pipe(o)
     return
    }
   } catch {}

   o.statusCode = 404
   o.end("404")
  }

  await next()
 })

 const s = {
  get: (path, handler) => (r("GET", path, handler), s),
  post: (path, handler) => (r("POST", path, handler), s),
  put: (path, handler) => (r("PUT", path, handler), s),
  delete: (path, handler) => (r("DELETE", path, handler), s),
  use: (path, handler) => {
   if (typeof path === "function") { handler = path; path = "*" }
   i.push({ p: path, m: handler })
   return s
  },
  listen: (port, cb) => (console.log(`PORT: ${port}`), a.listen(port, cb), a)
 }

 return s
}

const xdSrv = { build: X }
export default xdSrv