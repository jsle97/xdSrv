/* xdSrv.js - Lightweight Server Framework for Node.js
 * Version: 11.0.0 | License: MIT
 * Copyright (c) 2026 Jakub Śledzikowski <jsledzikowski.web@gmail.com>
 */

import { createServer as httpCreateServer } from 'node:http'
import { createServer as httpsCreateServer } from 'node:https'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { format } from 'node:util'

function createProxyMiddleware(options) {
  if (!options || typeof options.target !== 'string') {
    throw new Error("MyHttpProxy: 'target' option is required and must be a string.");
  }

  let targetUrl;
  try {
    targetUrl = new URL(options.target);
  } catch (e) {
    throw new Error(`MyHttpProxy: Invalid URL format for 'target': ${options.target}`);
  }

  const config = {
    changeOrigin: true,
    ignoreHeaders: [],
    timeout: 0,
    onError: (err, req, res) => {
      console.error(format(
        'MyHttpProxy: Error proxying request %s %s to %s: %s',
        req.method, req.url, targetUrl.href, err.message
      ));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy server error: An issue occurred while processing your request.');
      } else {
        res.end();
      }
    },
    ...options
  };

  const protocolModule = targetUrl.protocol === 'https:' ? https : http;

  const prepareProxyHeaders = (originalHeaders) => {
    const newHeaders = {};
    const ignoreList = config.ignoreHeaders.map(h => h.toLowerCase());
    for (const headerName in originalHeaders) {
      if (
        Object.prototype.hasOwnProperty.call(originalHeaders, headerName) &&
        !ignoreList.includes(headerName.toLowerCase())
      ) {
        newHeaders[headerName] = originalHeaders[headerName];
      }
    }
    if (config.changeOrigin) {
      newHeaders['host'] = targetUrl.hostname;
    }
    return newHeaders;
  };

  return function proxyMiddleware(req, res, next) {
    const requestUrl = new URL(req.url, `http://localhost`);
    const proxyPath = targetUrl.pathname === '/'
      ? requestUrl.pathname + requestUrl.search
      : `${targetUrl.pathname}${requestUrl.pathname}${requestUrl.search}`;

    const proxyOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: proxyPath,
      method: req.method,
      headers: prepareProxyHeaders(req.headers),
      timeout: config.timeout
    };

    const proxyReq = protocolModule.request(proxyOptions, proxyRes => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      config.onError(err, req, res);
      if (next) next(err);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('Proxy request timed out.'));
    });

    req.pipe(proxyReq);
    req.on('end', () => proxyReq.end());
  };
}

const xdLRU = ({ max = 500, ttl = 0, updateAgeOnGet = false, dispose } = {}) => {
  const cache = new Map();
  const getNow = () => Date.now();

  const getHeadKey = () => cache.keys().next().value;

  const del = (k, e, reason) => {
    if (dispose && e) dispose(k, e.v, reason);
    cache.delete(k);
  };

  const fresh = (e, t) => e && (e.exp > t || e.exp === Infinity);

  const touchEntry = (k, e) => {
    cache.delete(k);
    cache.set(k, e);
  };

  return {
    get(k) {
      const entry = cache.get(k);
      const t = getNow();
      if (!fresh(entry, t)) {
        del(k, entry, 'stale');
        return undefined;
      }
      if (updateAgeOnGet && entry.itemTtl != null && entry.itemTtl !== Infinity) {
        entry.exp = t + entry.itemTtl;
      }
      touchEntry(k, entry);
      return entry.v;
    },

    set(k, v, { ttl: customTtl } = {}) {
      const life = customTtl ?? ttl;
      const exp = life === Infinity ? Infinity : getNow() + life;
      const existing = cache.get(k);

      if (existing) {
        existing.v = v;
        existing.exp = exp;
        existing.itemTtl = life;
        touchEntry(k, existing);
      } else {
        if (max > 0 && cache.size >= max) {
          const head = getHeadKey();
          del(head, cache.get(head), 'evict');
        }
        cache.set(k, { v, exp, itemTtl: life });
      }
      return this;
    },

    has: k => fresh(cache.get(k), getNow()),
    delete: k => { del(k, cache.get(k), 'delete'); },
    clear() {
      cache.forEach((e, k) => del(k, e, 'delete'));
    },
    peek: k => {
      const e = cache.get(k);
      return fresh(e, getNow()) ? e.v : undefined;
    },
    prune() {
      const t = getNow();
      cache.forEach((e, k) => { if (!fresh(e, t)) del(k, e, 'stale'); });
    },
    keys() {
      return cache.keys();
    },
    get size() {
      return cache.size;
    }
  };
};

const xdRedis = ({ max = 1_000 } = {}) => {
  const getNow = () => Date.now();
  const inf = Infinity;
  const wrap = (type, data) => ({ __type: type, data });

  const expiries = new Map();
  const cache = xdLRU({
    max,
    ttl: inf,
    updateAgeOnGet: true,
    dispose: k => expiries.delete(k)
  });

  const getEntry = k => cache.get(k);

  const expired = k => {
    const e = expiries.get(k);
    return e !== undefined && e !== inf && getNow() > e;
  };

  const ttlLeftMs = k => expiries.has(k) ? expiries.get(k) - getNow() : -1;

  const assertType = (entry, t) => {
    if (!entry || entry.__type !== t)
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
  };

  const setWithTTL = (k, payload, ttlSeconds = -1) => {
    const exp = ttlSeconds >= 0 ? getNow() + ttlSeconds * 1000 : inf;
    expiries.set(k, exp);
    cache.set(k, payload, { ttl: exp === inf ? inf : exp - getNow() });
  };

  const internalTouch = k => {
    if (expired(k)) {
      cache.delete(k);
      return false;
    }
    return true;
  };

  const api = {
    exists: k => internalTouch(k) && cache.has(k),
    del: k => cache.delete(k),
    keys: (pat = '*') => {
      const re = new RegExp('^' + pat.replace(/\*/g, '.*') + '$');
      const resultKeys = [];
      for (const k of cache.keys()) {
        if (internalTouch(k) && cache.has(k) && re.test(k)) {
          resultKeys.push(k);
        }
      }
      return resultKeys;
    },
    ttl: k => {
      if (!internalTouch(k) || !cache.has(k)) return -2;
      const exp = expiries.get(k);
      if (exp === inf) return -1;
      return Math.max(0, Math.floor((exp - getNow()) / 1000));
    },
    expire: (k, seconds) => {
      if (api.exists(k)) {
        const newTtlMs = seconds * 1000;
        const newExpiryTimestamp = getNow() + newTtlMs;
        expiries.set(k, newExpiryTimestamp);

        const wrappedPayload = cache.get(k);
        if (wrappedPayload !== undefined) {
          cache.set(k, wrappedPayload, { ttl: newTtlMs });
        }
        return 1;
      }
      return 0;
    },
    flushAll: () => {
      cache.clear();
      expiries.clear();
      return 'OK';
    },
    dbsize: () => {
      let count = 0;
      for (const k of cache.keys()) {
        if (internalTouch(k) && cache.has(k)) {
          count++;
        }
      }
      return count;
    },

    set: (k, v, { ttl = -1 } = {}) => {
      setWithTTL(k, wrap('string', v), ttl);
      return 'OK';
    },
    get: k => {
      if (!internalTouch(k)) return null;
      const entry = getEntry(k);
      return entry ? entry.data : null;
    },
    incr: k => {
      const currentVal = api.get(k);
      const n = parseInt(currentVal ?? 0, 10);
      if (Number.isNaN(n) && currentVal !== null) throw new Error('ERR value is not an integer or out of range');
      const x = (Number.isNaN(n) ? 0 : n) + 1;
      const t = api.ttl(k);
      api.set(k, String(x), { ttl: t === -2 ? -1 : t });
      return x;
    },
    decr: k => {
      const currentVal = api.get(k);
      const n = parseInt(currentVal ?? 0, 10);
      if (Number.isNaN(n) && currentVal !== null) throw new Error('ERR value is not an integer or out of range');
      const x = (Number.isNaN(n) ? 0 : n) - 1;
      const t = api.ttl(k);
      api.set(k, String(x), { ttl: t === -2 ? -1 : t });
      return x;
    },
    append: (k, s) => {
      const cur = String(api.get(k) ?? '');
      const out = cur + s;
      const t = api.ttl(k);
      api.set(k, out, { ttl: t === -2 ? -1 : t });
      return out.length;
    },

    lpush: (k, ...els) => {
      if (!internalTouch(k) && els.length > 0) { }
      const ent = getEntry(k);
      const list = ent ? (assertType(ent, 'list'), ent.data) : [];
      els.reverse().forEach(x => list.unshift(String(x)));
      setWithTTL(k, wrap('list', list), api.ttl(k));
      return list.length;
    },
    rpush: (k, ...els) => {
      if (!internalTouch(k) && els.length > 0) { }
      const ent = getEntry(k);
      const list = ent ? (assertType(ent, 'list'), ent.data) : [];
      els.forEach(x => list.push(String(x)));
      setWithTTL(k, wrap('list', list), api.ttl(k));
      return list.length;
    },
    lpop: k => {
      if (!internalTouch(k) || !cache.has(k)) return null;
      const ent = getEntry(k);
      if (!ent) return null;
      assertType(ent, 'list');
      if (ent.data.length === 0) return null;
      const v = ent.data.shift();
      const currentTtl = api.ttl(k);
      ent.data.length ? setWithTTL(k, ent, currentTtl) : api.del(k);
      return v;
    },
    rpop: k => {
      if (!internalTouch(k) || !cache.has(k)) return null;
      const ent = getEntry(k);
      if (!ent) return null;
      assertType(ent, 'list');
      if (ent.data.length === 0) return null;
      const v = ent.data.pop();
      const currentTtl = api.ttl(k);
      ent.data.length ? setWithTTL(k, ent, currentTtl) : api.del(k);
      return v;
    },
    lrange: (k, s, e) => {
      if (!internalTouch(k) || !cache.has(k)) return [];
      const ent = getEntry(k);
      if (!ent) return [];
      assertType(ent, 'list');
      const len = ent.data.length;
      const idx = i => (i < 0 ? len + i : i);
      const from = Math.max(0, idx(s));
      const to = Math.min(len - 1, idx(e));
      return from <= to ? ent.data.slice(from, to + 1) : [];
    },

    hset: (k, f, v) => {
      if (!internalTouch(k)) { }
      const ent = getEntry(k);
      const h = ent ? (assertType(ent, 'hash'), ent.data) : {};
      const isNew = !(f in h);
      h[String(f)] = String(v);
      setWithTTL(k, wrap('hash', h), api.ttl(k));
      return isNew ? 1 : 0;
    },
    hget: (k, f) => {
      if (!internalTouch(k) || !cache.has(k)) return null;
      const ent = getEntry(k);
      if (!ent) return null;
      assertType(ent, 'hash');
      return ent.data[String(f)] ?? null;
    },
    hdel: (k, ...fields) => {
      if (!internalTouch(k) || !cache.has(k)) return 0;
      const ent = getEntry(k);
      if (!ent) return 0;
      assertType(ent, 'hash');
      let deletedCount = 0;
      fields.forEach(f_str => {
        if (delete ent.data[String(f_str)]) {
          deletedCount++;
        }
      });
      if (deletedCount > 0) {
        const currentTtl = api.ttl(k);
        Object.keys(ent.data).length ? setWithTTL(k, ent, currentTtl) : api.del(k);
      }
      return deletedCount;
    },
    hkeys: k => {
      if (!internalTouch(k) || !cache.has(k)) return [];
      const ent = getEntry(k);
      if (!ent) return [];
      assertType(ent, 'hash');
      return Object.keys(ent.data);
    },
    hgetall: k => {
      if (!internalTouch(k) || !cache.has(k)) return {};
      const ent = getEntry(k);
      if (!ent) return {};
      assertType(ent, 'hash');
      return { ...ent.data };
    },

    sadd: (k, ...m) => {
      if (!internalTouch(k) && m.length > 0) { }
      const ent = getEntry(k);
      const s = ent ? (assertType(ent, 'set'), ent.data) : new Set();
      let added = 0;
      m.forEach(x_val => {
        const x = String(x_val);
        if (!s.has(x)) { s.add(x); added++; }
      });
      if (added > 0 || !ent) {
        setWithTTL(k, wrap('set', s), api.ttl(k));
      }
      return added;
    },
    srem: (k, ...m) => {
      if (!internalTouch(k) || !cache.has(k)) return 0;
      const ent = getEntry(k);
      if (!ent) return 0;
      assertType(ent, 'set');
      let rem = 0;
      m.forEach(x_val => {
        if (ent.data.delete(String(x_val))) rem++;
      });
      if (rem > 0) {
        const currentTtl = api.ttl(k);
        ent.data.size ? setWithTTL(k, ent, currentTtl) : api.del(k);
      }
      return rem;
    },
    smembers: k => {
      if (!internalTouch(k) || !cache.has(k)) return [];
      const ent = getEntry(k);
      if (!ent) return [];
      assertType(ent, 'set');
      return [...ent.data];
    },
    sismember: (k, x_val) => {
      if (!internalTouch(k) || !cache.has(k)) return 0;
      const ent = getEntry(k);
      if (!ent) return 0;
      assertType(ent, 'set');
      return ent.data.has(String(x_val)) ? 1 : 0;
    }
  };

  const xdRedisQueue = (
    queueKey,
    worker,
    {
      concurrency = 1,
      pollInterval = 500,
      maxRetries = 3,
      baseRetryDelay = 1000,
      dlqKeySuffix = '_DLQ'
    } = {}
  ) => {
    let running = 0;
    let stopped = false;
    let pollTimeout;

    const processTask = async () => {
      const taskString = api.lpop(queueKey);
      if (taskString == null) {
        running--;
        return;
      }

      let taskPayload;
      try {
        taskPayload = JSON.parse(taskString);
      } catch (parseError) {
        console.error('Failed to parse task from queue:', parseError, taskString);
        const dlqName = queueKey + dlqKeySuffix;
        api.rpush(dlqName, JSON.stringify({
          malformedTaskString: taskString,
          error: 'Failed to parse task JSON',
          failedAt: new Date().toISOString()
        }));
        running--;
        if (!stopped) scheduleNext();
        return;
      }

      const { originalTask, retryCount = 0 } = taskPayload;

      try {
        await worker(originalTask);
      } catch (err) {
        const currentAttempt = retryCount + 1;
        console.error(`Task worker error: attempt ${currentAttempt}/${maxRetries}`, err, 'for task:', originalTask);

        if (currentAttempt <= maxRetries) {
          const delay = baseRetryDelay * Math.pow(2, currentAttempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
          api.rpush(queueKey, JSON.stringify({ originalTask, retryCount: currentAttempt }));
        } else {
          console.error('Task failed after max retries, sending to DLQ:', originalTask);
          const dlqName = queueKey + dlqKeySuffix;
          api.rpush(dlqName, JSON.stringify({
            taskPayloadAtFailure: taskPayload,
            error: err instanceof Error ? err.message : String(err),
            errorStack: err instanceof Error ? err.stack : undefined,
            failedAt: new Date().toISOString()
          }));
        }
      } finally {
        running--;
        if (!stopped) {
          scheduleNext();
        }
      }
    };

    const scheduleNext = () => {
      if (stopped) return;
      while (running < concurrency) {
        running++;
        processTask();
        if (api.lrange(queueKey, 0, 0).length === 0 && running === 0) break;
      }
    };

    const start = () => {
      if (stopped) return;
      scheduleNext();
      pollTimeout = setTimeout(start, pollInterval);
    };

    start();

    return {
      enqueue: task => {
        const initialTaskData = { originalTask: task, retryCount: 0 };
        const len = api.rpush(queueKey, JSON.stringify(initialTaskData));
        if (!stopped && running < concurrency) {
          clearTimeout(pollTimeout);
          start();
        }
        return len;
      },
      stop: () => {
        stopped = true;
        clearTimeout(pollTimeout);
      },
      get length() {
        const range = api.lrange(queueKey, 0, -1);
        return range ? range.length : 0;
      },
      get isRunning() {
        return !stopped;
      },
      getDLQName: () => queueKey + dlqKeySuffix,
      get dlqLength() {
        const dlqName = queueKey + dlqKeySuffix;
        const range = api.lrange(dlqName, 0, -1);
        return range ? range.length : 0;
      },
      viewDLQ: (start = 0, end = -1) => {
        const dlqName = queueKey + dlqKeySuffix;
        return api.lrange(dlqName, start, end).map(item => JSON.parse(item));
      }
    };
  };

  return { ...api, xdRedisQueue };
};

const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large' });
    }

    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
};

const cors = (req, res, next) => {
    const origin = req.headers.origin;

    if (true) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
};

const requests = new Map();

const rateLimiter = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxRequests = 100;

    if (!requests.has(ip)) {
        requests.set(ip, []);
    }

    const userRequests = requests.get(ip).filter(time => now - time < windowMs);

    if (userRequests.length >= maxRequests) {
        return res.status(429).json({
            error: 'Too many requests',
            retryAfter: Math.ceil(windowMs / 1000)
        });
    }

    userRequests.push(now);
    requests.set(ip, userRequests);

    next();
};

const HTML_MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"};
const HTML_RE = /[&<>"']/g;

const HTML_UNQUOTED_MAP = {...HTML_MAP,'`':'&#96;','=':'&#61;','/':'&#47;',' ':'&#32;','\t':'&#9;','\n':'&#10;','\r':'&#13;'};
const HTML_UNQUOTED_RE = /[&<>"'`=\/ \t\n\r]/g;

const JS_ESC_RE = /[\\'"`\u2028\u2029<&/]/g; 
const CSS_SAFE_RE = /[^a-zA-Z0-9 _\-\.,]/g;

const URL_PROTOCOL_RE = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/;
const END_SCRIPT_RE = /<\/script/gi;

const DEFAULTS = {
 handleObjects: 'convert', 
 context: 'auto', 
 quote: '"',
 targetName: null, 
 inAttribute: false,
 urlPolicy: {allow: ['http','https','mailto','tel','data'], dataMimeAllow: /^image\/(png|gif|jpeg|webp|svg\+xml)$/i, onFail: 'about:blank'}, 
 normalize: false
};

const mapReplace = (s, re, map) => s.replace(re, ch => map[ch]);

const toStr = (v, opts) => {
 if (v == null) return '';
 if (typeof v === 'string') return opts.normalize ? v.normalize('NFC') : v;
 if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || typeof v === 'symbol') return String(v);
 if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
 if (opts.handleObjects === 'empty') return '';
 if (opts.handleObjects === 'json') return safeJson(v);
 if (opts.handleObjects === 'throw') throw new TypeError('Non-primitive not allowed');
 return String(v);
};

const safeJson = v => {
 const seen = new WeakSet();
 const json = JSON.stringify(v, (k, val) => {
  if (typeof val === 'object' && val !== null) {
   if (seen.has(val)) return '[Circular]';
   seen.add(val);
  }
  return val;
 });
 return json == null ? '' : json;
};

const cssEscapeIdent = s => {
 let out = '';
 for (let i = 0; i < s.length; i++) {
  const ch = s[i], code = s.charCodeAt(i);
  if (
   (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5A) ||
   (code >= 0x61 && code <= 0x7A) || ch === '-' || ch === '_'
  ) {
   if (i === 0 && code >= 0x30 && code <= 0x39) { out += '\\3' + ch + ' '; continue; }
   out += ch;
  } else {
   out += '\\' + code.toString(16) + ' ';
  }
 }
 return out;
};

const cssEscapeString = s => s.replace(CSS_SAFE_RE, ch => '\\' + ch.codePointAt(0).toString(16) + ' ');

const jsEscapeString = (s, quote) => s.replace(JS_ESC_RE, ch => {
 if (ch === '\\') return '\\\\';
 if (ch === quote) return '\\' + quote;
 if (ch === '`') return '\\`';
 if (ch === '\u2028') return '\\u2028';
 if (ch === '\u2029') return '\\u2029';
 if (ch === '<') return '\\x3C';
 if (ch === '&') return '\\x26';
 if (ch === '/') return '\\/';
 return ch;
});

const isSafeUrl = (u, policy) => {
 const m = String(u).match(URL_PROTOCOL_RE);
 if (!m) return {ok:true, url:u};
 const proto = m[1].toLowerCase();
 if (proto === 'data') {
  const mm = String(u).slice(m[0].length).match(/^([^;,]+)[;,]/);
  const mime = mm ? mm[1].trim() : '';
  if (!policy.allow.includes('data')) return {ok:false};
  if (!policy.dataMimeAllow.test(mime)) return {ok:false};
  return {ok:true, url:u};
 }
 if (policy.allow.includes(proto)) return {ok:true, url:u};
 return {ok:false};
};

const sanitizeUrl = (u, policy) => {
 const r = isSafeUrl(u, policy);
 if (r.ok) return String(u);
 if (policy.onFail === 'strip') return '';
 if (policy.onFail === 'throw') throw new Error('Blocked URL protocol');
 return 'about:blank';
};

const detect = (str, o) => {
 if (o.inAttribute && o.targetName) {
  const n = o.targetName.toLowerCase();
  if (/^on/.test(n)) return 'jsString';
  if (n === 'style') return 'cssString';
  if (/^(href|src|xlink:href|action|formaction|poster|data)$/i.test(n)) return 'url';
  return o.quote ? 'htmlAttribute' : 'htmlAttributeUnquoted';
 }
 return 'htmlContent';
};

const escapeAny = (value, options = {}) => {
 const o = {...DEFAULTS, ...options};
 let s = toStr(value, o);
 if (o.normalize && typeof s.normalize === 'function') s = s.normalize('NFC');

 const ctx = o.context === 'auto' ? detect(s, o) : o.context;

 if (ctx === 'htmlContent') return mapReplace(s, HTML_RE, HTML_MAP);

 if (ctx === 'htmlAttribute') return mapReplace(s, HTML_RE, HTML_MAP);

 if (ctx === 'htmlAttributeUnquoted') return mapReplace(s, HTML_UNQUOTED_RE, HTML_UNQUOTED_MAP);

 if (ctx === 'htmlComment') {
  let t = s.replace(/--/g, '&#45;&#45;');
  t = t.replace(/>/g, '&gt;');
  t = t.replace(/</g, '&lt;');
  return t;
 }

 if (ctx === 'jsString') {
  const q = o.quote === "'" ? "'" : o.quote === '`' ? '`' : '"';
  return jsEscapeString(s, q);
 }

 if (ctx === 'jsTemplate') {
  let t = s.replace(/[`$\\]/g, m => (m === '`' ? '\\`' : m === '$' ? '\\$' : '\\\\'));
  t = t.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return t;
 }

 if (ctx === 'scriptData') {
  let t = s.replace(END_SCRIPT_RE, '<\\/script');
  t = t.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return t;
 }

 if (ctx === 'cssString') return cssEscapeString(s);

 if (ctx === 'cssIdent') return cssEscapeIdent(s);

 if (ctx === 'cssUrl') {
  const u = sanitizeUrl(s, o.urlPolicy);
  return `url("${mapReplace(u, HTML_RE, HTML_MAP)}")`;
 }

 if (ctx === 'url') return sanitizeUrl(s, o.urlPolicy);

 if (ctx === 'urlComponent') return encodeURIComponent(s);

 return mapReplace(s, HTML_RE, HTML_MAP);
};

const safeText = v => escapeAny(v, {context:'htmlContent'});

const safeAttr = (name, v, {quoted = true, ...rest} = {}) => {
 const ctx = quoted ? 'htmlAttribute' : 'htmlAttributeUnquoted';
 const targetName = name;
 const inAttribute = true;
 const val = escapeAny(v, {context:'auto', inAttribute, targetName, quote: quoted ? '"' : '', ...rest});
 return quoted ? `${name}="${val}"` : `${name}=${val}`;
};

const safeUrlAttr = (name, url, opts = {}) => {
 const v = escapeAny(url, {context:'url', inAttribute:true, targetName:name, ...opts});
 return `${name}="${mapReplace(v, HTML_RE, HTML_MAP)}"`;
};

const safeTextNode = v => safeText(v);

const xdCookie = {
 parse: (h) => {
  if (!h) return Object.create(null);
  const o = Object.create(null);
  let s = 0, e, n, v;
  while ((e = h.indexOf(';', s)) !== -1) {
   [n, v] = h.slice(s, e).trim().split('=', 2);
   if (n && v) o[n.trim()] = decodeURIComponent(v.trim());
   s = e + 1;
  }
  [n, v] = h.slice(s).trim().split('=', 2);
  if (n && v) o[n.trim()] = decodeURIComponent(v.trim());
  return o;
 },

 serialize: (n, v, opt = {}) => {
  if (!n || typeof n !== 'string') throw TypeError('bad name');
  if (!/^[\w!#$%&'*+\-.0-9^`|~]+$/.test(n)) throw TypeError('invalid name');

  let s = `${encodeURIComponent(n)}=${encodeURIComponent(v)}`;
  const { maxAge, expires, domain, path = '/', secure, httpOnly = true, sameSite } = opt;

  if (maxAge != null) {
   if (!Number.isFinite(maxAge) || maxAge < 0) throw TypeError('bad maxAge');
   s += `; Max-Age=${Math.floor(maxAge)}`;
  }
  if (expires && expires instanceof Date) s += `; Expires=${expires.toUTCString()}`;
  if (domain) {
   if (!/^\.?[a-z0-9.-]+$/i.test(domain)) throw TypeError('bad domain');
   s += `; Domain=${domain}`;
  }
  if (path) {
   if (!/^\/[\w!#$%&'()*+\-./:<>?@[\\\]^_`{|}~]*$/.test(path)) throw TypeError('bad path');
   s += `; Path=${path}`;
  }
  if (secure) s += '; Secure';
  if (httpOnly) s += '; HttpOnly';
  switch (sameSite) {
   case 'Strict':
   case 'Lax':
   case 'None': s += `; SameSite=${sameSite}`; break;
   case undefined: break;
   default: throw TypeError('bad SameSite');
  }
  return s;
 },

 set: (r, n, v, opt) => {
  const hdr = xdCookie.serialize(n, v, opt);
  const prev = r.getHeader('Set-Cookie');
  r.setHeader('Set-Cookie', Array.isArray(prev) ? prev.concat(hdr) : [hdr]);
 },

 setAll: (r, map, opt) => {
  if (!map || typeof map !== 'object') throw TypeError('map required');
  const arr = [];
  for (const [k, v] of Object.entries(map)) arr.push(xdCookie.serialize(k, v, opt));
  const prev = r.getHeader('Set-Cookie');
  r.setHeader('Set-Cookie', Array.isArray(prev) ? prev.concat(arr) : arr);
 },

 clear: (r, n, opt = {}) => xdCookie.set(r, n, '', { ...opt, maxAge: 0, expires: new Date(0) }),

 get: (o, n) => o[n],

 has: (o, n) => n in o
};

export const xdSrv = {
 createApp: function (opts = {}) {
  const routes = { GET: [], POST: [], PUT: [], DELETE: [], HEAD: [] }
  const middlewares = []
  const staticRoot = path.resolve(opts.static || './public')
  const maxBody = opts.maxBody || 1048576
  const corsEnabled = opts.cors !== false
  const spa = opts.spa !== false
  const logs = opts.logs !== false
  const sessionSecret = opts.sessionSecret || 'default-secret'
  
  const sessionStore = opts.sessionStore || xdRedis({ max: 1000 })

  const mime = {
   html: 'text/html; charset=utf-8',
   css: 'text/css; charset=utf-8',
   js: 'application/javascript; charset=utf-8',
   json: 'application/json; charset=utf-8',
   txt: 'text/plain; charset=utf-8',
   svg: 'image/svg+xml',
   png: 'image/png',
   jpg: 'image/jpeg',
   jpeg: 'image/jpeg',
   webp: 'image/webp',
   ico: 'image/x-icon',
   woff: 'font/woff',
   woff2: 'font/woff2'
  }

  const use = (path, middleware) => {
    if (typeof path === 'function') {
      middleware = path
      path = '*'
    }
    middlewares.push({ path, middleware })
  }

  const addRoute = (method, pattern, handler) => {
   const regex = pattern.includes(':') ? new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') : null
   routes[method].push({ pattern, regex, handler })
  }

  const matchRoute = (method, pathname) => {
   for (const route of routes[method]) {
    if (route.pattern === pathname) return { handler: route.handler, params: {} }
    if (route.regex) {
     const match = pathname.match(route.regex)
     if (match) return { handler: route.handler, params: match.groups || {} }
    }
   }
   return null
  }

  const generateSessionId = () => {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
  }

  const getSession = async (sessionId) => {
    if (!sessionId) return null
    const sessionData = sessionStore.get(`sess:${sessionId}`)
    return sessionData ? JSON.parse(sessionData) : null
  }

  const setSession = async (sessionId, data) => {
    sessionStore.set(`sess:${sessionId}`, JSON.stringify(data), { ttl: 3600 })
  }

  const destroySession = async (sessionId) => {
    sessionStore.del(`sess:${sessionId}`)
  }

  const serveFile = async (res, relPath) => {
   const reqPath = relPath === '/' ? '/index.html' : relPath
   const absPath = path.join(staticRoot, reqPath)
   if (!absPath.startsWith(staticRoot)) return false
   try {
    const data = await fs.readFile(absPath)
    const ext = path.extname(absPath).slice(1).toLowerCase()
    res.setHeader('content-type', mime[ext] || 'application/octet-stream')
    res.setHeader('cache-control', 'no-store')
    res.end(data)
    return true
   } catch {
    return false
   }
  }

  const parseBody = (req) => new Promise((resolve) => {
   let data = ''
   let size = 0
   req.on('data', chunk => {
    size += chunk.length
    if (size > maxBody) return resolve({ error: 413 })
    data += chunk
   })
   req.on('end', () => {
    const ct = (req.headers['content-type'] || '').toLowerCase()
    if (ct.includes('json')) {
     try { resolve(JSON.parse(data)) } catch { resolve({ error: 400 }) }
    } else if (ct.includes('urlencoded')) {
     resolve(Object.fromEntries(new URLSearchParams(data)))
    } else {
     resolve(data)
    }
   })
  })

  const executeMiddlewares = async (req, res, middlewares, index = 0) => {
    if (index >= middlewares.length) return true
    
    const middleware = middlewares[index]
    let nextCalled = false
    
    return new Promise((resolve, reject) => {
      const next = (err) => {
        if (err) return reject(err)
        nextCalled = true
        resolve(executeMiddlewares(req, res, middlewares, index + 1))
      }
      
      try {
        const result = middleware(req, res, next)
        if (result instanceof Promise) {
          result.then(next).catch(reject)
        } else if (!nextCalled) {
          next()
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  const handler = async (req, res) => {
   const url = new URL(req.url, `http://${req.headers.host}`)
   req.path = url.pathname
   req.query = Object.fromEntries(url.searchParams)
   req.headers = req.headers

   req.cookies = xdCookie.parse(req.headers.cookie || '')

   let sessionId = req.cookies.sid
   if (sessionId) {
     req.session = await getSession(sessionId) || {}
   } else {
     sessionId = generateSessionId()
     req.session = {}
   }

   req.saveSession = async () => {
     await setSession(sessionId, req.session)
     xdCookie.set(res, 'sid', sessionId, { 
       httpOnly: true, 
       secure: false, 
       maxAge: 3600,
       path: '/'
     })
   }

   req.destroySession = async () => {
     await destroySession(sessionId)
     xdCookie.clear(res, 'sid')
   }

   res.status = n => (res.statusCode = n, res)
   res.set = (k, v) => (res.setHeader(k, v), res)
   res.json = d => (res.set('content-type', mime.json), res.end(JSON.stringify(d)))
   res.html = h => (res.set('content-type', mime.html), res.end(h))
   res.send = d => typeof d === 'object' && !Buffer.isBuffer(d) ? res.json(d) : res.end(String(d))
   res.redirect = (code, url) => (res.status(code).set('location', url).end())
   
   res.safeHtml = h => res.html(safeText(h))
   res.safeJson = d => res.json(d)

   if (corsEnabled) {
    res.set('access-control-allow-origin', '*')
    res.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,HEAD,OPTIONS')
    res.set('access-control-allow-headers', 'content-type,authorization')
    if (req.method === 'OPTIONS') return res.status(204).end()
   }

   const log = () => {
    if (!logs) return
    const time = Date.now() - start
    const msg = `${req.method} ${req.path} ${res.statusCode || 200} ${time}ms`
    console.log(res.statusCode >= 400 ? msg : msg)
   }
   const start = Date.now()
   res.on('finish', log)

   try {
     const globalMiddlewares = middlewares
       .filter(m => m.path === '*' || req.path.startsWith(m.path))
       .map(m => m.middleware)
     
     await executeMiddlewares(req, res, globalMiddlewares)
     
     if (res.headersSent) return
   } catch (err) {
     return errorHandler(err, req, res, () => {})
   }

   if (req.method === 'HEAD') {
    const route = matchRoute('GET', req.path)
    if (route) {
     req.params = route.params
     try { await route.handler(req, res) } catch { res.status(500).end() }
     res.end()
     return
    }
    if (await serveFile(res, req.path)) return
    if (spa && await serveFile(res, '/index.html')) return
    res.status(404).end()
    return
   }

   const route = matchRoute(req.method, req.path)
   if (route) {
    req.params = route.params
    try {
     if (req.method === 'GET' || req.method === 'DELETE') {
      await route.handler(req, res)
     } else {
      const body = await parseBody(req)
      if (body?.error === 413) return res.status(413).send('Payload Too Large')
      if (body?.error === 400) return res.status(400).send('Invalid JSON')
      req.body = body
      await route.handler(req, res)
     }
    } catch (e) {
     errorHandler(e, req, res, () => {})
    }
    return
   }

   if (await serveFile(res, req.path)) return
   if (spa && await serveFile(res, '/index.html')) return
   res.status(404).send('Not Found')
  }

  const server = opts.https ? httpsCreateServer(opts.tls || {}, handler) : httpCreateServer(handler)

  const app = {
   get: (p, h) => (addRoute('GET', p, h), app),
   post: (p, h) => (addRoute('POST', p, h), app),
   put: (p, h) => (addRoute('PUT', p, h), app),
   delete: (p, h) => (addRoute('DELETE', p, h), app),
   use: (path, middleware) => (use(path, middleware), app),
   listen: (port, cb) => {
    server.listen(port, () => {
     console.log(`Server: http${opts.https ? 's' : ''}://localhost:${port}`)
     if (cb) cb()
    })
    return app
   }
  }

  if (opts.rateLimit !== false) {
    app.use(rateLimiter)
  }
  
  if (opts.cors !== false) {
    app.use(cors)
  }

  return app
 }
}

export { 
  createProxyMiddleware,
  xdRedis,
  xdLRU,
  errorHandler,
  cors,
  rateLimiter,
  xdCookie,
  escapeAny,
  safeText,
  safeAttr,
  safeUrlAttr,
  safeTextNode
}
