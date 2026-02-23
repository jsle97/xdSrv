/* xdSrv.js - Lightweight HTTP/HTTPS/WebSocket Server Framework for Node.js 
 * Version: 1.5.0 | License: MIT
 * Copyright (c) 2025 Jakub Śledzikowski <jsledzikowski.web@gmail.com>
 */

import { createServer as httpCreateServer } from 'node:http';
import { createServer as httpsCreateServer } from 'node:https';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// ==================== CONSTANTS ====================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_READY_STATES = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
});
const WS_OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xA
});

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const DEFAULT_MIME_TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  map: 'application/json; charset=utf-8',
  avif: 'image/avif',
  bmp: 'image/bmp'
});

// ==================== SECURITY UTILITIES ====================
const HTML_RE = /[&<>"']/g;
const HTML_UNQUOTED_RE = /[&<>"'`=\/ \t\n\r]/g;

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;', 
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

const HTML_UNQUOTED_ESCAPES = Object.freeze({
  ...HTML_ESCAPES,
  '`': '&#96;',
  '=': '&#61;',
  '/': '&#47;',
  ' ': '&#32;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;'
});

const JS_ESC_RE = /[\\'"`\u2028\u2029<&/]/g;
const CSS_SAFE_RE = /[^a-zA-Z0-9 _\-.,]/g;
const URL_PROTOCOL_RE = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/;
const END_SCRIPT_RE = /<\/script/gi;

const DEFAULT_ESCAPE_OPTIONS = Object.freeze({
  handleObjects: 'convert',
  context: 'auto',
  quote: '"',
  targetName: null,
  inAttribute: false,
  urlPolicy: Object.freeze({
    allow: ['http', 'https', 'mailto', 'tel', 'data'],
    dataMimeAllow: /^image\/(png|gif|jpeg|webp|svg\+xml)$/i,
    onFail: 'about:blank'
  }),
  normalize: false
});

// ==================== CORE UTILITIES ====================
const safeJsonStringify = (value) => {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  }) || '';
};

const parseUrlSearchParams = (search) => Object.fromEntries(new URLSearchParams(search));

const createErrorWithCode = (msg, code) => {
  const e = new Error(msg);
  e.code = code;
  return e;
};

const createRegexPattern = (pattern) => {
  if (!pattern.includes(':')) return null;
  return new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
};

const mapReplace = (string, regex, mapping) => 
  string.replace(regex, char => mapping[char] || char);

const toStringSafe = (value, options = {}) => {
  if (value == null) return '';
  
  if (typeof value === 'string') {
    return options.normalize ? value.normalize('NFC') : value;
  }
  
  if (typeof value === 'number' || typeof value === 'bigint' || 
      typeof value === 'boolean' || typeof value === 'symbol') {
    return String(value);
  }
  
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : value.toISOString();
  }
  
  const handleObjects = options.handleObjects || 'convert';
  if (handleObjects === 'empty') return '';
  if (handleObjects === 'json') return safeJsonStringify(value);
  if (handleObjects === 'throw') {
    throw new TypeError('Non-primitive values not allowed');
  }
  
  return String(value);
};

const cssEscapeIdent = (string) => {
  let result = '';
  
  for (let i = 0; i < string.length; i++) {
    const char = string[i];
    const code = string.charCodeAt(i);
    
    if ((code >= 0x30 && code <= 0x39) || 
        (code >= 0x41 && code <= 0x5A) || 
        (code >= 0x61 && code <= 0x7A) || 
        char === '-' || char === '_') {
      
      if (i === 0 && code >= 0x30 && code <= 0x39) {
        result += '\\3' + char + ' ';
        continue;
      }
      
      result += char;
    } else {
      result += '\\' + code.toString(16) + ' ';
    }
  }
  
  return result;
};

const cssEscapeString = (string) => 
  string.replace(CSS_SAFE_RE, char => 
    '\\' + char.codePointAt(0).toString(16) + ' '
  );

const jsEscapeString = (string, quoteChar) => 
  string.replace(JS_ESC_RE, char => {
    switch (char) {
      case '\\': return '\\\\';
      case quoteChar: return '\\' + quoteChar;
      case '`': return '\\`';
      case '\u2028': return '\\u2028';
      case '\u2029': return '\\u2029';
      case '<': return '\\x3C';
      case '&': return '\\x26';
      case '/': return '\\/';
      default: return char;
    }
  });

const isSafeUrl = (url, policy) => {
  const match = String(url).match(URL_PROTOCOL_RE);
  if (!match) return { ok: true, url };
  
  const protocol = match[1].toLowerCase();
  
  if (protocol === 'data') {
    if (!policy.allow.includes('data')) return { ok: false };
    
    const dataPart = String(url).slice(match[0].length);
    const mimeMatch = dataPart.match(/^([^;,]+)[;,]/);
    const mimeType = mimeMatch ? mimeMatch[1].trim() : '';
    
    if (!policy.dataMimeAllow.test(mimeType)) return { ok: false };
    return { ok: true, url };
  }
  
  return policy.allow.includes(protocol) ? { ok: true, url } : { ok: false };
};

const sanitizeUrl = (url, policy) => {
  const result = isSafeUrl(url, policy);
  
  if (result.ok) return String(url);
  
  switch (policy.onFail) {
    case 'strip': return '';
    case 'throw': throw new Error('Blocked URL protocol');
    default: return 'about:blank';
  }
};

const detectContext = (string, options) => {
  if (!options.inAttribute || !options.targetName) {
    return 'htmlContent';
  }
  
  const name = options.targetName.toLowerCase();
  
  if (/^on/.test(name)) return 'jsString';
  if (name === 'style') return 'cssString';
  if (/^(href|src|xlink:href|action|formaction|poster|data)$/i.test(name)) {
    return 'url';
  }
  
  return options.quote ? 'htmlAttribute' : 'htmlAttributeUnquoted';
};

const escapeAny = (value, options = {}) => {
  const opts = { ...DEFAULT_ESCAPE_OPTIONS, ...options };
  let string = toStringSafe(value, opts);
  
  if (opts.normalize && typeof string.normalize === 'function') {
    string = string.normalize('NFC');
  }

  const context = opts.context === 'auto' ? 
    detectContext(string, opts) : opts.context;

  switch (context) {
    case 'htmlContent':
    case 'htmlAttribute':
      return mapReplace(string, HTML_RE, HTML_ESCAPES);
    
    case 'htmlAttributeUnquoted':
      return mapReplace(string, HTML_UNQUOTED_RE, HTML_UNQUOTED_ESCAPES);
    
    case 'htmlComment':
      return string
        .replace(/--/g, '&#45;&#45;')
        .replace(/>/g, '>')
        .replace(/</g, '<');
    
    case 'jsString':
      return jsEscapeString(string, 
        opts.quote === "'" ? "'" : 
        opts.quote === '`' ? '`' : '"'
      );
    
    case 'scriptData':
      return string
        .replace(END_SCRIPT_RE, '<\\/script')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    
    case 'cssString':
      return cssEscapeString(string);
    
    case 'cssIdent':
      return cssEscapeIdent(string);
    
    case 'cssUrl':
      return `url("${mapReplace(
        sanitizeUrl(string, opts.urlPolicy), 
        HTML_RE, 
        HTML_ESCAPES
      )}")`;
    
    case 'url':
      return sanitizeUrl(string, opts.urlPolicy);
    
    case 'urlComponent':
      return encodeURIComponent(string);
    
    default:
      return mapReplace(string, HTML_RE, HTML_ESCAPES);
  }
};

const safeText = (value) => escapeAny(value, { context: 'htmlContent' });

const safeAttr = (name, value, { quoted = true, ...options } = {}) => {
  const escapedValue = escapeAny(value, { 
    context: 'auto', 
    inAttribute: true, 
    targetName: name, 
    quote: quoted ? '"' : '', 
    ...options 
  });
  
  return quoted ? `${name}="${escapedValue}"` : `${name}=${escapedValue}`;
};

const safeUrlAttr = (name, url, options = {}) => {
  const escapedUrl = escapeAny(url, { 
    context: 'url', 
    inAttribute: true, 
    targetName: name, 
    ...options 
  });
  
  return `${name}="${mapReplace(escapedUrl, HTML_RE, HTML_ESCAPES)}"`;
};

// ==================== LRU CACHE ====================
const createCache = ({ max = 500, ttl = 0, updateAgeOnGet = true, dispose = null } = {}) => {
  const cache = new Map();
  const expiries = new Map();

  const isExpired = (key) => {
    const expiry = expiries.get(key);
    return expiry !== undefined && expiry !== Infinity && Date.now() > expiry;
  };

  const evictOne = () => {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return false;

    const value = cache.get(oldestKey);
    cache.delete(oldestKey);
    expiries.delete(oldestKey);
    
    if (dispose) dispose(oldestKey, value, 'evict');
    return true;
  };

  const deleteKey = (key) => {
    if (!cache.has(key)) return false;
    
    const value = cache.get(key);
    cache.delete(key);
    expiries.delete(key);
    
    if (dispose) dispose(key, value, 'delete');
    return true;
  };

  const get = (key) => {
    if (!cache.has(key)) return undefined;
    
    if (isExpired(key)) {
      deleteKey(key);
      return undefined;
    }
    
    const value = cache.get(key);
    if (updateAgeOnGet) {
      cache.delete(key);
      cache.set(key, value);
    }
    
    return value;
  };

  const set = (key, value, setOpts = {}) => {
    const effectiveTtl = setOpts.ttl !== undefined ? setOpts.ttl : ttl;
    const expiry = effectiveTtl === Infinity || effectiveTtl <= 0 ? Infinity : Date.now() + effectiveTtl;
    
    if (cache.has(key)) {
      cache.delete(key);
      expiries.delete(key);
    } else if (cache.size >= max) {
      evictOne();
    }
    
    cache.set(key, value);
    expiries.set(key, expiry);
    return true;
  };

  const has = (key) => {
    if (!cache.has(key)) return false;
    if (isExpired(key)) {
      deleteKey(key);
      return false;
    }
    return true;
  };

  const clear = () => {
    if (dispose) {
      for (const [key, value] of cache) {
        dispose(key, value, 'clear');
      }
    }
    cache.clear();
    expiries.clear();
  };

  const getKeys = () => {
    const validKeys = [];
    for (const key of cache.keys()) {
      if (!isExpired(key)) validKeys.push(key);
    }
    return validKeys[Symbol.iterator]();
  };

  const getSize = () => {
    let count = 0;
    for (const key of cache.keys()) {
      if (!isExpired(key)) count++;
    }
    return count;
  };

  return {
    get,
    set,
    has,
    delete: deleteKey,
    clear,
    keys: getKeys,
    size: getSize
  };
};

const xdLRU = (opts = {}) => {
  const { max = 500, ttl = 0, updateAgeOnGet = true, dispose = null } = opts;
  return createCache({ max, ttl, updateAgeOnGet, dispose });
};

// ==================== REDIS-LIKE STORE ====================
const createRedisInstance = ({ max = 1000 } = {}) => {
  const wrap = (type, data) => ({ __type: type, data });
  const expiries = new Map();
  const cache = xdLRU({ 
    max, 
    ttl: Infinity, 
    updateAgeOnGet: true, 
    dispose: key => expiries.delete(key) 
  });

  const expired = (key) => {
    const expiry = expiries.get(key);
    return expiry !== undefined && expiry !== Infinity && Date.now() > expiry;
  };

  const assertType = (entry, type) => {
    if (!entry || entry.__type !== type) {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
  };

  const setWithTTL = (key, payload, ttlSeconds = -1) => {
    const expiry = ttlSeconds >= 0 ? Date.now() + ttlSeconds * 1000 : Infinity;
    expiries.set(key, expiry);
    cache.set(key, payload, { ttl: expiry === Infinity ? Infinity : expiry - Date.now() });
  };

  const touch = (key) => {
    if (expired(key)) {
      cache.delete(key);
      return false;
    }
    return true;
  };

  const getEntry = (key) => cache.get(key);

  const getTtlSeconds = (key) => {
    if (!touch(key) || !cache.has(key)) return -2;
    
    const expiry = expiries.get(key);
    if (expiry === Infinity) return -1;
    return Math.max(1, Math.ceil((expiry - Date.now()) / 1000));
  };

  const preserveTtl = (key) => {
    const ttl = getTtlSeconds(key);
    return ttl === -2 ? -1 : ttl;
  };

  const stringOperations = {
    set: (key, value, { ttl = -1 } = {}) => {
      setWithTTL(key, wrap('string', value), ttl);
      return 'OK';
    },

    get: (key) => {
      if (!touch(key)) return null;
      const entry = getEntry(key);
      return entry ? entry.data : null;
    },

    incr: (key) => {
      const value = stringOperations.get(key);
      const num = parseInt(value ?? 0, 10);
      
      if (Number.isNaN(num) && value !== null) {
        throw new Error('ERR value is not an integer or out of range');
      }
      
      const result = (Number.isNaN(num) ? 0 : num) + 1;
      stringOperations.set(key, String(result), { ttl: preserveTtl(key) });
      return result;
    },

    decr: (key) => {
      const value = stringOperations.get(key);
      const num = parseInt(value ?? 0, 10);
      
      if (Number.isNaN(num) && value !== null) {
        throw new Error('ERR value is not an integer or out of range');
      }
      
      const result = (Number.isNaN(num) ? 0 : num) - 1;
      stringOperations.set(key, String(result), { ttl: preserveTtl(key) });
      return result;
    },

    append: (key, string) => {
      const current = String(stringOperations.get(key) ?? '');
      const result = current + string;
      stringOperations.set(key, result, { ttl: preserveTtl(key) });
      return result.length;
    }
  };

  const listOperations = {
    lpush: (key, ...elements) => {
      touch(key);
      const entry = getEntry(key);
      const list = entry ? (assertType(entry, 'list'), entry.data) : [];
      
      for (const element of elements) {
        list.unshift(String(element));
      }
      
      setWithTTL(key, wrap('list', list), preserveTtl(key));
      return list.length;
    },

    rpush: (key, ...elements) => {
      touch(key);
      const entry = getEntry(key);
      const list = entry ? (assertType(entry, 'list'), entry.data) : [];
      
      for (const element of elements) {
        list.push(String(element));
      }
      
      setWithTTL(key, wrap('list', list), preserveTtl(key));
      return list.length;
    },

    lpop: (key) => {
      if (!touch(key) || !cache.has(key)) return null;
      
      const entry = getEntry(key);
      if (!entry) return null;
      
      assertType(entry, 'list');
      if (entry.data.length === 0) return null;
      
      const value = entry.data.shift();
      
      if (entry.data.length) {
        setWithTTL(key, wrap('list', entry.data), preserveTtl(key));
      } else {
        api.del(key);
      }
      
      return value;
    },

    rpop: (key) => {
      if (!touch(key) || !cache.has(key)) return null;
      
      const entry = getEntry(key);
      if (!entry) return null;
      
      assertType(entry, 'list');
      if (entry.data.length === 0) return null;
      
      const value = entry.data.pop();
      
      if (entry.data.length) {
        setWithTTL(key, wrap('list', entry.data), preserveTtl(key));
      } else {
        api.del(key);
      }
      
      return value;
    },

    lrange: (key, start, end) => {
      if (!touch(key) || !cache.has(key)) return [];
      
      const entry = getEntry(key);
      if (!entry) return [];
      
      assertType(entry, 'list');
      const length = entry.data.length;
      const getIndex = (index) => (index < 0 ? length + index : index);
      const from = Math.max(0, getIndex(start));
      const to = Math.min(length - 1, getIndex(end));
      
      return from <= to ? entry.data.slice(from, to + 1) : [];
    }
  };

  const hashOperations = {
    hset: (key, field, value) => {
      touch(key);
      const entry = getEntry(key);
      const hash = entry ? (assertType(entry, 'hash'), entry.data) : {};
      const isNew = !(String(field) in hash);
      
      hash[String(field)] = String(value);
      setWithTTL(key, wrap('hash', hash), preserveTtl(key));
      
      return isNew ? 1 : 0;
    },

    hget: (key, field) => {
      if (!touch(key) || !cache.has(key)) return null;
      
      const entry = getEntry(key);
      if (!entry) return null;
      
      assertType(entry, 'hash');
      return entry.data[String(field)] ?? null;
    },

    hdel: (key, ...fields) => {
      if (!touch(key) || !cache.has(key)) return 0;
      
      const entry = getEntry(key);
      if (!entry) return 0;
      
      assertType(entry, 'hash');
      let deletedCount = 0;
      
      for (const field of fields) {
        const fieldKey = String(field);
        if (Object.prototype.hasOwnProperty.call(entry.data, fieldKey)) {
          delete entry.data[fieldKey];
          deletedCount++;
        }
      }
      
      if (deletedCount > 0) {
        if (Object.keys(entry.data).length) {
          setWithTTL(key, wrap('hash', entry.data), preserveTtl(key));
        } else {
          api.del(key);
        }
      }
      
      return deletedCount;
    },

    hkeys: (key) => {
      if (!touch(key) || !cache.has(key)) return [];
      
      const entry = getEntry(key);
      if (!entry) return [];
      
      assertType(entry, 'hash');
      return Object.keys(entry.data);
    },

    hgetall: (key) => {
      if (!touch(key) || !cache.has(key)) return {};
      
      const entry = getEntry(key);
      if (!entry) return {};
      
      assertType(entry, 'hash');
      return { ...entry.data };
    }
  };

  const setOperations = {
    sadd: (key, ...members) => {
      touch(key);
      const entry = getEntry(key);
      const set = entry ? (assertType(entry, 'set'), entry.data) : new Set();
      let addedCount = 0;
      
      for (const member of members) {
        const memberStr = String(member);
        if (!set.has(memberStr)) {
          set.add(memberStr);
          addedCount++;
        }
      }
      
      if (addedCount > 0 || !entry) {
        setWithTTL(key, wrap('set', set), preserveTtl(key));
      }
      
      return addedCount;
    },

    srem: (key, ...members) => {
      if (!touch(key) || !cache.has(key)) return 0;
      
      const entry = getEntry(key);
      if (!entry) return 0;
      
      assertType(entry, 'set');
      let removedCount = 0;
      
      for (const member of members) {
        if (entry.data.delete(String(member))) removedCount++;
      }
      
      if (removedCount > 0) {
        if (entry.data.size) {
          setWithTTL(key, wrap('set', entry.data), preserveTtl(key));
        } else {
          api.del(key);
        }
      }
      
      return removedCount;
    },

    smembers: (key) => {
      if (!touch(key) || !cache.has(key)) return [];
      
      const entry = getEntry(key);
      if (!entry) return [];
      
      assertType(entry, 'set');
      return [...entry.data];
    },

    sismember: (key, member) => {
      if (!touch(key) || !cache.has(key)) return 0;
      
      const entry = getEntry(key);
      if (!entry) return 0;
      
      assertType(entry, 'set');
      return entry.data.has(String(member)) ? 1 : 0;
    }
  };

  const api = {
    exists: (key) => touch(key) && cache.has(key),

    del: (key) => cache.delete(key),

    keys: (pattern = '*') => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const result = [];
      for (const key of cache.keys()) {
        if (touch(key) && cache.has(key) && regex.test(key)) {
          result.push(key);
        }
      }
      return result;
    },

    ttl: (key) => getTtlSeconds(key),

    expire: (key, seconds) => {
      if (!api.exists(key)) return 0;
      
      const newTtlMs = seconds * 1000;
      expiries.set(key, Date.now() + newTtlMs);
      const payload = cache.get(key);
      
      if (payload !== undefined) {
        cache.set(key, payload, { ttl: newTtlMs });
      }
      
      return 1;
    },

    flushAll: () => {
      cache.clear();
      expiries.clear();
      return 'OK';
    },

    dbsize: () => {
      let count = 0;
      for (const key of cache.keys()) {
        if (touch(key) && cache.has(key)) count++;
      }
      return count;
    },

    ...stringOperations,
    ...listOperations,
    ...hashOperations,
    ...setOperations
  };

  const createRedisQueue = (queueKey, worker, options = {}) => {
    const {
      concurrency = 1,
      pollInterval = 500,
      maxRetries = 3,
      baseRetryDelay = 1000,
      dlqKeySuffix = '_DLQ'
    } = options;

    let running = 0;
    let stopped = false;
    let pollTimeout;
    const dlqName = `${queueKey}${dlqKeySuffix}`;

    const processTask = async () => {
      const taskString = api.lpop(queueKey);
      if (taskString == null) {
        running--;
        return;
      }

      let taskPayload;
      try {
        taskPayload = JSON.parse(taskString);
      } catch {
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
      } catch (error) {
        const attempt = retryCount + 1;
        if (attempt <= maxRetries) {
          await new Promise(resolve => setTimeout(
            resolve, 
            baseRetryDelay * Math.pow(2, attempt - 1)
          ));
          api.rpush(queueKey, JSON.stringify({
            originalTask,
            retryCount: attempt
          }));
        } else {
          api.rpush(dlqName, JSON.stringify({
            taskPayloadAtFailure: taskPayload,
            error: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
            failedAt: new Date().toISOString()
          }));
        }
      } finally {
        running--;
        if (!stopped) scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (stopped) return;
      
      while (running < concurrency) {
        running++;
        processTask();
        
        if (api.lrange(queueKey, 0, 0).length === 0 && running === 0) {
          break;
        }
      }
    };

    const startPolling = () => {
      if (stopped) return;
      scheduleNext();
      pollTimeout = setTimeout(startPolling, pollInterval);
    };

    startPolling();

    return {
      enqueue: (task) => {
        const length = api.rpush(queueKey, JSON.stringify({
          originalTask: task,
          retryCount: 0
        }));
        
        if (!stopped && running < concurrency) {
          clearTimeout(pollTimeout);
          startPolling();
        }
        
        return length;
      },

      stop: () => {
        stopped = true;
        clearTimeout(pollTimeout);
      },

      get length() {
        return api.lrange(queueKey, 0, -1).length;
      },

      get isRunning() {
        return !stopped;
      },

      getDLQName: () => dlqName,

      get dlqLength() {
        return api.lrange(dlqName, 0, -1).length;
      },

      viewDLQ: (start = 0, end = -1) => 
        api.lrange(dlqName, start, end).map(item => JSON.parse(item))
    };
  };

  return { ...api, createRedisQueue: (queueKey, worker, options) => createRedisQueue(queueKey, worker, options) };
};

const xdRedis = createRedisInstance;

// ==================== HTTP UTILITIES ====================
const signData = (data, secret) => 
  crypto.createHmac('sha256', String(secret)).update(data).digest('base64url');

const generateSessionId = () => 
  crypto.randomBytes(32).toString('base64url');

const isSecureConnection = (request, trustProxy) => 
  Boolean(request.socket?.encrypted) || 
  (trustProxy && String(request.headers['x-forwarded-proto'] || '')
    .toLowerCase()
    .split(',')[0]
    ?.trim() === 'https');

const getClientIp = (request, trustProxy) => {
  if (trustProxy && request.headers['x-forwarded-for']) {
    return String(request.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return request.socket?.remoteAddress || '';
};

const getHostname = (request) => 
  String(request.headers.host || '').trim().replace(/:.*/, '');

const generateEtag = (stats) => 
  `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

const appendVaryHeader = (existing, value) => {
  if (!existing) return value;
  
  const headers = new Set(
    existing.split(',').map(h => h.trim()).filter(Boolean)
  );
  
  value.split(',').map(h => h.trim()).forEach(h => headers.add(h));
  
  return Array.from(headers).join(', ');
};

const sanitizeRedirectUrl = (url) => 
  (typeof url !== 'string' || url.includes('\n') || url.includes('\r')) ? 
    '/' : url;

// ==================== COOKIE HANDLER ====================
const createCookieHandler = () => {
  const parse = (header) => {
    if (!header) return Object.create(null);
    
    const cookies = Object.create(null);
    const parts = header.split(';');
    
    for (const part of parts) {
      const trimmed = part.trim();
      const eqIndex = trimmed.indexOf('=');
      
      if (eqIndex > 0) {
        const name = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        
        if (name) {
          try {
            cookies[name] = decodeURIComponent(value);
          } catch {
            cookies[name] = value;
          }
        }
      }
    }
    
    return cookies;
  };

  const serialize = (name, value, options = {}) => {
    if (!name || typeof name !== 'string') {
      throw new TypeError('Cookie name must be a non-empty string');
    }
    
    if (!/^[\w!#$%&'*+\-.0-9^`|~]+$/.test(name)) {
      throw new TypeError('Invalid cookie name');
    }

    let cookieString = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    const {
      maxAge,
      expires,
      domain,
      path = '/',
      secure,
      httpOnly = true,
      sameSite
    } = options;

    if (Number.isFinite(maxAge) && maxAge >= 0) {
      cookieString += `; Max-Age=${Math.floor(maxAge)}`;
    }
    
    if (expires instanceof Date) {
      cookieString += `; Expires=${expires.toUTCString()}`;
    }
    
    if (domain) {
      if (!/^\.[a-z0-9.-]+$/i.test(domain)) {
        throw new TypeError('Invalid domain');
      }
      cookieString += `; Domain=${domain}`;
    }
    
    if (path) {
      if (!/^\/[\w!#$%&'()*+\-./:<>?@[\]\\^_`{|}~]*$/.test(path)) {
        throw new TypeError('Invalid path');
      }
      cookieString += `; Path=${path}`;
    }
    
    if (httpOnly) cookieString += '; HttpOnly';
    if (secure) cookieString += '; Secure';
    
    if (sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None') {
      cookieString += `; SameSite=${sameSite}`;
    } else if (sameSite !== undefined) {
      throw new TypeError('Invalid SameSite value');
    }
    
    return cookieString;
  };

  const setCookieHeader = (response, cookieHeader) => {
    const existing = response.getHeader('Set-Cookie');
    
    if (Array.isArray(existing)) {
      response.setHeader('Set-Cookie', [...existing, cookieHeader]);
    } else {
      response.setHeader('Set-Cookie', [cookieHeader]);
    }
  };

  const set = (response, name, value, options) => {
    const cookieHeader = serialize(name, value, options);
    setCookieHeader(response, cookieHeader);
  };

  const setAll = (response, cookieMap, options) => {
    if (!cookieMap || typeof cookieMap !== 'object') {
      throw new TypeError('Cookie map is required');
    }
    
    const cookies = Object.entries(cookieMap).map(([name, value]) =>
      serialize(name, value, options)
    );
    
    const existing = response.getHeader('Set-Cookie');
    
    if (Array.isArray(existing)) {
      response.setHeader('Set-Cookie', [...existing, ...cookies]);
    } else {
      response.setHeader('Set-Cookie', cookies);
    }
  };

  const clear = (response, name, options = {}) => {
    set(response, name, '', {
      ...options,
      maxAge: 0,
      expires: new Date(0)
    });
  };

  const get = (cookies, name) => cookies[name];

  const has = (cookies, name) => name in cookies;

  return {
    parse,
    serialize,
    set,
    setAll,
    clear,
    get,
    has
  };
};

const xdCookie = createCookieHandler();

// ==================== MIDDLEWARE ====================
const createRateLimiter = (windowMs = 15 * 60 * 1000, maxRequests = 100) => {
  const rateLimiterCache = xdLRU({ 
    max: 10000, 
    ttl: windowMs, 
    updateAgeOnGet: false 
  });

  return (request, response, next) => {
    const clientIp = request.ip || request.connection?.remoteAddress || '';
    const now = Date.now();

    let record = rateLimiterCache.get(clientIp);
    
    if (!record) {
      record = { count: 0, reset: now + windowMs };
      rateLimiterCache.set(clientIp, record, { ttl: windowMs });
    }
    
    record.count++;

    const remaining = Math.max(0, maxRequests - record.count);
    
    response.setHeader('X-RateLimit-Limit', String(maxRequests));
    response.setHeader('X-RateLimit-Remaining', String(remaining));
    response.setHeader('X-RateLimit-Reset', String(Math.floor(record.reset / 1000)));

    if (record.count > maxRequests) {
      response.setHeader('Retry-After', 
        String(Math.ceil((record.reset - now) / 1000)));
      return response.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((record.reset - now) / 1000)
      });
    }
    
    next();
  };
};

const rateLimiterMiddleware = createRateLimiter();

const corsMiddleware = (request, response, next) => {
  const origin = request.headers.origin || '*';
  
  response.setHeader('Vary', appendVaryHeader(
    String(response.getHeader('Vary') || ''), 
    'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
  ));
  
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 
    'GET, POST, PUT, DELETE, HEAD, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 
    'Content-Type, Authorization, X-API-Key');
  response.setHeader('Access-Control-Max-Age', '86400');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }
  
  next();
};

const errorHandlerMiddleware = (error, request, response, next) => {
  if (response.headersSent) {
    try { response.end(); } catch {}
    return;
  }
  
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return response.status(400).json({ error: 'File too large' });
  }
  
  if (error?.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Invalid JSON' });
  }
  
  const body = { error: 'Internal server error' };
  
  if (process.env.NODE_ENV === 'development') {
    body.message = String(error?.message || error);
    body.stack = error?.stack;
  }
  
  response.status(500).json(body);
};

// ==================== ASYNC FILE SERVING ====================
const serveFileAsync = async (request, response, relativePath, method = 'GET', staticRoot, mimeTypes, staticMaxAge, secureHeaders) => {
  // Path traversal fix: zawsze używaj zdekodowanej ścieżki
  let requestPath = relativePath === '/' ? '/index.html' : relativePath;
  try {
    requestPath = decodeURIComponent(requestPath);
  } catch {}
  // Usuwamy podwójne slash i normalize
  requestPath = path.posix.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const absolutePath = path.resolve(staticRoot, '.' + requestPath);

  if (!absolutePath.startsWith(staticRoot + path.sep) && absolutePath !== staticRoot) {
    return false;
  }
  
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) return false;

    const extension = path.extname(absolutePath).slice(1).toLowerCase();
    const etag = generateEtag(stats);
    
    response.setHeader('etag', etag);
    response.setHeader('last-modified', stats.mtime.toUTCString());
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('cache-control', 
      staticMaxAge > 0 ? 
        `public, max-age=${staticMaxAge}` : 
        'public, max-age=0, must-revalidate'
    );
    response.setHeader('content-type', mimeTypes[extension] || 'application/octet-stream');
    
    if (secureHeaders && !/^(text\/html|application\/json)/i.test(
      response.getHeader('content-type') || ''
    )) {
      response.setHeader('x-content-type-options', 'nosniff');
    }

    const ifNoneMatch = String(request.headers['if-none-match'] || '');
    const ifModifiedSince = request.headers['if-modified-since'] ? 
      new Date(request.headers['if-modified-since']) : null;
    
    if ((ifNoneMatch && ifNoneMatch === etag) || 
        (ifModifiedSince && !isNaN(ifModifiedSince.getTime()) && stats.mtime <= ifModifiedSince)) {
      response.statusCode = 304;
      response.end();
      return true;
    }
    
    if (method === 'HEAD') {
      response.setHeader('content-length', String(stats.size));
      response.statusCode = 200;
      response.end();
      return true;
    }

    const rangeHeader = String(request.headers.range || '');
    if (rangeHeader.startsWith('bytes=')) {
      const rangeParts = rangeHeader.slice(6).split(',')[0].split('-');
      let start = rangeParts[0] ? parseInt(rangeParts[0], 10) : 0;
      let end = rangeParts[1] ? parseInt(rangeParts[1], 10) : stats.size - 1;
      
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end)) end = stats.size - 1;
      
      if (start > end || start < 0 || end >= stats.size) {
        response.statusCode = 416;
        response.setHeader('content-range', `bytes */${stats.size}`);
        response.end();
        return true;
      }
      
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${start}-${end}/${stats.size}`);
      response.setHeader('content-length', String(end - start + 1));
      
      const readStream = fsSync.createReadStream(absolutePath, { start, end });
      readStream.pipe(response);
      return true;
    }

    response.setHeader('content-length', String(stats.size));
    const readStream = fsSync.createReadStream(absolutePath);
    readStream.pipe(response);
    return true;
  } catch (error) {
    console.error('File serving error:', error);
    return false;
  }
};

// ==================== BODY PARSING ====================
const parseMultipartData = async (buffer, boundary, parseOptions = {}) => {
  const {
    maxFileSize = 10 * 1024 * 1024,
    maxFiles = 10,
    maxFields = 100
  } = parseOptions;
  
  const result = { fields: {}, files: [] };
  const separator = Buffer.from('--' + boundary);
  const doubleCrlf = Buffer.from('\r\n\r\n');

  let position = buffer.indexOf(separator);
  if (position === -1) return result;
  
  position += separator.length;

  while (position < buffer.length) {
    if (buffer.slice(position, position + 2).equals(Buffer.from('--'))) {
      break;
    }
    
    if (buffer.slice(position, position + 2).equals(Buffer.from('\r\n'))) {
      position += 2;
    }

    const headerEnd = buffer.indexOf(doubleCrlf, position);
    if (headerEnd === -1) break;

    const headerString = buffer.slice(position, headerEnd).toString('utf8');
    const headers = {};
    
    headerString.split('\r\n').forEach((line) => {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const headerName = line.slice(0, colonIndex).trim().toLowerCase();
        const headerValue = line.slice(colonIndex + 1).trim();
        headers[headerName] = headerValue;
      }
    });

    const bodyStart = headerEnd + 4;
    const nextSeparator = buffer.indexOf(separator, bodyStart);
    const body = buffer.slice(
      bodyStart, 
      nextSeparator === -1 ? buffer.length : nextSeparator - 2
    );

    const disposition = headers['content-disposition'] || '';
    const nameMatch = disposition.match(/\bname="([^"]+)"/);
    const filenameMatch = disposition.match(/\bfilename="([^"]+)"/);
    
    const name = nameMatch ? nameMatch[1] : '';
    const filename = filenameMatch ? filenameMatch[1] : null;

    if (filename) {
      if (result.files.length >= maxFiles) {
        throw createErrorWithCode('Too many files', 'LIMIT_FILE_COUNT');
      }
      
      if (body.length > maxFileSize) {
        throw createErrorWithCode('File too large', 'LIMIT_FILE_SIZE');
      }
      
      result.files.push({
        name,
        filename,
        contentType: headers['content-type'] || 'application/octet-stream',
        data: body
      });
    } else if (name) {
      if (Object.keys(result.fields).length >= maxFields) {
        throw createErrorWithCode('Too many fields', 'LIMIT_FIELD_COUNT');
      }
      
      result.fields[name] = body.toString('utf8');
    }
    
    position = nextSeparator === -1 ? buffer.length : nextSeparator;
  }
  
  return result;
};

const parseRequestBody = (request, maxBodySize, parseOptions = {}) => 
  new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] || '').toLowerCase();
    const contentLength = parseInt(request.headers['content-length'] || '0', 10);
    
    if (Number.isFinite(contentLength) && contentLength > maxBodySize) {
      request.destroy(new Error('Payload Too Large'));
      return resolve(null);
    }

    let totalSize = 0;
    const chunks = [];
    let exceededLimit = false;

    const onData = (chunk) => {
      if (exceededLimit) return;
      
      totalSize += chunk.length;
      if (totalSize > maxBodySize) {
        exceededLimit = true;
        request.destroy(new Error('Payload Too Large'));
        resolve(null);
        return;
      }
      
      chunks.push(chunk);
    };

    const onEnd = async () => {
      if (exceededLimit) return;
      
      try {
        const buffer = Buffer.concat(chunks);

        if (contentType.includes('json')) {
          resolve(JSON.parse(buffer.toString('utf8')));
        } else if (contentType.includes('x-www-form-urlencoded')) {
          resolve(parseUrlSearchParams(buffer.toString('utf8')));
        } else if (contentType.includes('multipart/form-data')) {
          const boundaryMatch = contentType.match(
            /boundary=(?:"([^"]+)"|([^;\s]+))/i
          );
          
          if (!boundaryMatch) {
            throw new Error('Invalid boundary');
          }
          
          const boundary = boundaryMatch[1] || boundaryMatch[2];
          resolve(await parseMultipartData(buffer, boundary, parseOptions));
        } else {
          resolve(buffer.toString('utf8'));
        }
      } catch (error) {
        if (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT') {
          resolve(null);
        } else if (error instanceof SyntaxError) {
          resolve(null);
        } else {
          reject(error);
        }
      }
    };

    const onError = (error) => {
      reject(error);
    };

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });

// ==================== SESSION MANAGEMENT ====================
const createSessionManager = (sessionSecret, sessionStore) => {
 const sessionLocks = new Map();

 const withSessionLock = async (sessionId, callback) => {
  const previousLock = sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const currentLock = new Promise(resolve => { release = resolve; });

  sessionLocks.set(sessionId, previousLock.then(() => currentLock));
  await previousLock;

  try {
   return await callback();
  } finally {
   release();
   if (sessionLocks.get(sessionId) === previousLock.then(() => currentLock)) {
    sessionLocks.delete(sessionId);
   }
  }
 };

 const getSessionData = async (sessionId) => {
  if (!sessionId) return null;

  try {
   const rawData = sessionStore.get(`sess:${sessionId}`);
   return rawData ? JSON.parse(rawData) : null;
  } catch {
   return null;
  }
 };

 const setSessionData = async (sessionId, data) => {
  sessionStore.set(`sess:${sessionId}`, safeJsonStringify(data), { ttl: 3600 });
 };

 const destroySessionData = async (sessionId) => {
  sessionStore.del(`sess:${sessionId}`);
 };

 // Naprawa session fixation: nie akceptuj niepodpisanych SID
 const getSessionId = async (request, sessionSecret) => {
  let sessionId = request.cookies.sid;

  if (sessionId?.includes('.')) {
   const [idPart, signaturePart] = sessionId.split('.', 2);
   if (signaturePart === signData(idPart, sessionSecret)) {
    return idPart;
   }
  }
  // Zawsze generuj nowe SID jeśli nie ma poprawnego podpisu
  return generateSessionId();
 };

 return {
  withSessionLock,
  getSessionData,
  setSessionData,
  destroySessionData,
  getSessionId
 };
};

// ==================== WEBSOCKET IMPLEMENTATION ====================
const createWebSocket = (socket, request, wsOptions = {}) => {
  const emitter = new EventEmitter();
  const {
    maxPayload = 16 * 1024 * 1024,
    pingInterval = 30000,
    pingTimeout = 10000
  } = wsOptions;

  let readyState = WS_READY_STATES.OPEN;
  let fragmentBuffer = [];
  let fragmentOpcode = null;
  let pingTimer = null;
  let pongTimer = null;
  let closeCode = null;
  let closeReason = '';

  const websocket = {
    get readyState() { return readyState; },
    
    get CONNECTING() { return WS_READY_STATES.CONNECTING; },
    get OPEN() { return WS_READY_STATES.OPEN; },
    get CLOSING() { return WS_READY_STATES.CLOSING; },
    get CLOSED() { return WS_READY_STATES.CLOSED; },
    
    socket,
    request,
    
    on: (event, listener) => { 
      emitter.on(event, listener); 
      return websocket; 
    },
    
    once: (event, listener) => { 
      emitter.once(event, listener); 
      return websocket; 
    },
    
    off: (event, listener) => { 
      emitter.off(event, listener); 
      return websocket; 
    },
    
    removeListener: (event, listener) => { 
      emitter.removeListener(event, listener); 
      return websocket; 
    },

    send: (data, options = {}) => {
      if (readyState !== WS_READY_STATES.OPEN) return false;
      
      const isBinary = options.binary || Buffer.isBuffer(data);
      const opcode = isBinary ? WS_OPCODES.BINARY : WS_OPCODES.TEXT;
      const payload = Buffer.isBuffer(data) ? 
        data : 
        Buffer.from(String(data), 'utf8');
      
      const frame = createFrame(opcode, payload, true);
      
      try {
        socket.write(frame);
        return true;
      } catch {
        return false;
      }
    },

    close: (code = 1000, reason = '') => {
      if (readyState === WS_READY_STATES.CLOSED || 
          readyState === WS_READY_STATES.CLOSING) {
        return;
      }
      
      readyState = WS_READY_STATES.CLOSING;
      closeCode = code;
      closeReason = reason;
      
      const responsePayload = Buffer.alloc(2 + Buffer.byteLength(reason));
      if (reason) responsePayload.write(reason, 2, 'utf8');
      responsePayload.writeUInt16BE(code, 0);
      
      const frame = createFrame(WS_OPCODES.CLOSE, responsePayload, true);
      try {
        socket.write(frame);
      } catch {}
      
      setTimeout(() => {
        if (readyState !== WS_READY_STATES.CLOSED) {
          terminateConnection();
        }
      }, 5000);
    },

    ping: (data = Buffer.alloc(0)) => {
      if (readyState !== WS_READY_STATES.OPEN) return false;
      
      const payload = Buffer.isBuffer(data) ? 
        data : 
        Buffer.from(String(data), 'utf8');
      
      const frame = createFrame(WS_OPCODES.PING, payload, true);
      
      try {
        socket.write(frame);
        return true;
      } catch {
        return false;
      }
    },

    pong: (data = Buffer.alloc(0)) => {
      if (readyState !== WS_READY_STATES.OPEN) return false;
      
      const payload = Buffer.isBuffer(data) ? 
        data : 
        Buffer.from(String(data), 'utf8');
      
      const frame = createFrame(WS_OPCODES.PONG, payload, true);
      
      try {
        socket.write(frame);
        return true;
      } catch {
        return false;
      }
    },

    terminate: () => terminateConnection()
  };

  const createFrame = (opcode, payload, fin = true) => {
    const length = payload.length;
    let headerLength = 2;
    let extendedLengthBytes = 0;

    if (length > 65535) {
      headerLength += 8;
      extendedLengthBytes = 8;
    } else if (length > 125) {
      headerLength += 2;
      extendedLengthBytes = 2;
    }

    const frame = Buffer.alloc(headerLength + length);
    frame[0] = (fin ? 0x80 : 0x00) | opcode;

    if (extendedLengthBytes === 0) {
      frame[1] = length;
    } else if (extendedLengthBytes === 2) {
      frame[1] = 126;
      frame.writeUInt16BE(length, 2);
    } else {
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
    }

    payload.copy(frame, headerLength);
    return frame;
  };

  const unmaskPayload = (data, mask) => {
    const result = Buffer.alloc(data.length);
    
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] ^ mask[i % 4];
    }
    
    return result;
  };

  let receiveBuffer = Buffer.alloc(0);

  const parseFrames = () => {
    while (receiveBuffer.length >= 2) {
      const firstByte = receiveBuffer[0];
      const secondByte = receiveBuffer[1];

      const fin = (firstByte & 0x80) !== 0;
      const rsv1 = (firstByte & 0x40) !== 0;
      const rsv2 = (firstByte & 0x20) !== 0;
      const rsv3 = (firstByte & 0x10) !== 0;
      const opcode = firstByte & 0x0F;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7F;

      if (rsv1 || rsv2 || rsv3) {
        closeWithError(1002, 'RSV bits must be 0');
        return;
      }
      
      if (!masked) {
        closeWithError(1002, 'Client frames must be masked');
        return;
      }

      let headerLength = 2;
      if (payloadLength === 126) headerLength += 2;
      else if (payloadLength === 127) headerLength += 8;

      headerLength += 4;

      if (receiveBuffer.length < headerLength) return;

      let offset = 2;
      if (payloadLength === 126) {
        payloadLength = receiveBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        // Poprawka: sprawdzamy oba 32 bity
        const highBits = receiveBuffer.readUInt32BE(offset);
        const lowBits = receiveBuffer.readUInt32BE(offset + 4);
        if (highBits > 0 || lowBits > maxPayload) {
         closeWithError(1009, 'Payload too large');
         return;
        }
        payloadLength = lowBits;
        offset += 8;
      }

      if (payloadLength > maxPayload) {
        closeWithError(1009, 'Payload too large');
        return;
      }

      const totalLength = headerLength + payloadLength;
      if (receiveBuffer.length < totalLength) return;

      const mask = receiveBuffer.slice(offset, offset + 4);
      offset += 4;
      const maskedPayload = receiveBuffer.slice(offset, offset + payloadLength);
      const payload = unmaskPayload(maskedPayload, mask);

      receiveBuffer = receiveBuffer.slice(totalLength);
      handleFrame(fin, opcode, payload);
    }
  };

  const handleFrame = (fin, opcode, payload) => {
    if (opcode >= 0x8) {
      handleControlFrame(opcode, payload);
      return;
    }

    if (opcode === WS_OPCODES.CONTINUATION) {
      if (fragmentOpcode === null) {
        closeWithError(1002, 'Unexpected continuation frame');
        return;
      }
      
      fragmentBuffer.push(payload);
      
      if (fin) {
        const fullPayload = Buffer.concat(fragmentBuffer);
        deliverMessage(fragmentOpcode, fullPayload);
        fragmentBuffer = [];
        fragmentOpcode = null;
      }
    } else {
      if (fragmentOpcode !== null) {
        closeWithError(1002, 'Expected continuation frame');
        return;
      }
      
      if (fin) {
        deliverMessage(opcode, payload);
      } else {
        fragmentOpcode = opcode;
        fragmentBuffer = [payload];
      }
    }
  };

  const handleControlFrame = (opcode, payload) => {
    if (opcode === WS_OPCODES.CLOSE) {
      let code = 1005;
      let reason = '';
      
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.slice(2).toString('utf8');
      }
      
      if (readyState === WS_READY_STATES.OPEN) {
        readyState = WS_READY_STATES.CLOSING;
        
        const responsePayload = Buffer.alloc(2);
        responsePayload.writeUInt16BE(code, 0);
        
        const frame = createFrame(WS_OPCODES.CLOSE, responsePayload, true);
        try {
          socket.write(frame);
        } catch {}
      }
      
      closeCode = code;
      closeReason = reason;
      terminateConnection();
    } else if (opcode === WS_OPCODES.PING) {
      if (readyState === WS_READY_STATES.OPEN) {
        const frame = createFrame(WS_OPCODES.PONG, payload, true);
        try {
          socket.write(frame);
        } catch {}
      }
      emitter.emit('ping', payload);
    } else if (opcode === WS_OPCODES.PONG) {
      clearTimeout(pongTimer);
      pongTimer = null;
      emitter.emit('pong', payload);
    }
  };

  const deliverMessage = (opcode, payload) => {
    if (opcode === WS_OPCODES.TEXT) {
      try {
        const text = payload.toString('utf8');
        emitter.emit('message', text, false);
      } catch {
        closeWithError(1007, 'Invalid UTF-8');
      }
    } else if (opcode === WS_OPCODES.BINARY) {
      emitter.emit('message', payload, true);
    }
  };

  const closeWithError = (code, reason) => {
    if (readyState === WS_READY_STATES.CLOSED) return;
    websocket.close(code, reason);
  };

  const terminateConnection = () => {
    if (readyState === WS_READY_STATES.CLOSED) return;
    
    readyState = WS_READY_STATES.CLOSED;
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    
    try { socket.end(); } catch {}
    try { socket.destroy(); } catch {}
    
    emitter.emit('close', closeCode || 1006, closeReason || '');
  };

  const startHeartbeat = () => {
    if (pingInterval <= 0) return;
    
    pingTimer = setInterval(() => {
      if (readyState !== WS_READY_STATES.OPEN) return;
      
      websocket.ping();
      
      pongTimer = setTimeout(() => {
        if (readyState === WS_READY_STATES.OPEN) {
          closeWithError(1006, 'Pong timeout');
        }
      }, pingTimeout);
    }, pingInterval);
  };

  socket.on('data', (chunk) => {
    receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
    parseFrames();
  });

  socket.on('close', terminateConnection);
  socket.on('error', (error) => {
    emitter.emit('error', error);
    terminateConnection();
  });
  socket.on('end', terminateConnection);

  startHeartbeat();
  return websocket;
};

const handleWebSocketUpgrade = (request, socket, head, wsRoutes, wsOptions) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  let matchedRoute = null;
  let params = {};

  for (const route of wsRoutes) {
    if (route.pattern === pathname) {
      matchedRoute = route;
      params = {};
      break;
    }
    
    if (route.regex) {
      const match = pathname.match(route.regex);
      if (match) {
        matchedRoute = route;
        params = match.groups || {};
        break;
      }
    }
  }

  if (!matchedRoute) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];

  if (!key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  const protocol = request.headers['sec-websocket-protocol'];
  if (protocol && wsOptions.protocols) {
    const requestedProtocols = protocol.split(',').map(p => p.trim());
    const supportedProtocols = Array.isArray(wsOptions.protocols) ?
      wsOptions.protocols : [wsOptions.protocols];
    // RFC: serwer wybiera preferowany z własnej listy
    const selectedProtocol = supportedProtocols.find(p =>
      requestedProtocols.includes(p)
    );
    if (selectedProtocol) {
      responseHeaders.push(`Sec-WebSocket-Protocol: ${selectedProtocol}`);
    }
  }

  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

  const ws = createWebSocket(socket, request, wsOptions);
  ws.path = pathname;
  ws.query = parseUrlSearchParams(url.search);
  ws.params = params;
  ws.cookies = xdCookie.parse(request.headers.cookie || '');

  if (head && head.length > 0) {
    socket.unshift(head);
  }

  matchedRoute.handler(ws, request);
};

const xdWebSocket = {
  createSocket: createWebSocket,
  handleUpgrade: handleWebSocketUpgrade
};

// ==================== CREATE SERVER APP ====================
const createServerApp = (options = {}) => {
  const routes = {
    GET: [],
    POST: [],
    PUT: [],
    DELETE: [],
    HEAD: []
  };
  
  const wsRoutes = [];
  const middlewares = [];
  
  const staticRoot = path.resolve(options.static || './public');
  const maxBodySize = options.maxBody || 1048576;
  const spaMode = options.spa !== false;
  const enableLogs = options.logs !== false;
  const sessionSecret = String(options.sessionSecret || 'default-secret');
  const trustProxy = options.trustProxy === true;
  const staticMaxAge = Number.isFinite(options.staticMaxAge) ? 
    Math.max(0, options.staticMaxAge) : 0;
  const secureHeaders = options.secureHeaders !== false;
  const sessionStore = options.sessionStore || xdRedis({ max: 1000 });
  const mimeTypes = { ...DEFAULT_MIME_TYPES };
  
  const wsOptions = {
    maxPayload: options.wsMaxPayload || 16 * 1024 * 1024,
    pingInterval: options.wsPingInterval || 30000,
    pingTimeout: options.wsPingTimeout || 10000,
    protocols: options.wsProtocols || null
  };

  const wsClients = new Set();
  const sessionManager = createSessionManager(sessionSecret, sessionStore);

  const useMiddleware = (pathPattern, middleware) => {
    if (typeof pathPattern === 'function') {
      middleware = pathPattern;
      pathPattern = '*';
    }
    
    middlewares.push({ path: pathPattern, middleware });
  };

  const addRoute = (method, pattern, handler) => {
    const regex = createRegexPattern(pattern);
    routes[method].push({ pattern, regex, handler });
  };

  const addWsRoute = (pattern, handler) => {
    const regex = createRegexPattern(pattern);
    wsRoutes.push({ pattern, regex, handler });
  };

  const matchRoute = (method, pathname) => {
    for (const route of routes[method]) {
      if (route.pattern === pathname) {
        return { handler: route.handler, params: {} };
      }
      
      if (route.regex) {
        const match = pathname.match(route.regex);
        if (match) {
          return { handler: route.handler, params: match.groups || {} };
        }
      }
    }
    
    return null;
  };

  const executeMiddlewares = async (request, response, middlewareList, index = 0) => {
    if (index >= middlewareList.length || response.writableEnded) {
      return true;
    }
    
    let hasCalledNext = false;
    const next = (error) => {
      if (hasCalledNext) return;
      hasCalledNext = true;
      
      if (error) throw error;
      return executeMiddlewares(request, response, middlewareList, index + 1);
    };
    
    try {
      const result = middlewareList[index](request, response, next);
      if (result?.then) {
        await result;
        if (!hasCalledNext && !response.writableEnded) {
          await next();
        }
      }
    } catch (error) {
      throw error;
    }
    
    return true;
  };

  const setupRequestResponse = (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    
    request.path = url.pathname;
    request.query = parseUrlSearchParams(url.search);
    request.cookies = xdCookie.parse(request.headers.cookie || '');
    request.hostname = getHostname(request);
    request.secure = isSecureConnection(request, trustProxy);
    request.ip = getClientIp(request, trustProxy);

    response.status = (code) => { 
      response.statusCode = code; 
      return response; 
    };
    
    response.set = (key, value) => { 
      response.setHeader(key, value); 
      return response; 
    };
    
    response.vary = (value) => { 
      response.setHeader('Vary', appendVaryHeader(
        String(response.getHeader('Vary') || ''), 
        value
      )); 
      return response; 
    };
    
    response.type = (type) => response.set('content-type', type);
    
    response.json = (data) => { 
      response.type(mimeTypes.json); 
      response.end(safeJsonStringify(data)); 
    };
    
    response.html = (html) => { 
      response.type(mimeTypes.html); 
      response.end(html); 
    };
    
    response.send = (data) => {
      if (typeof data === 'object' && !Buffer.isBuffer(data)) {
        return response.json(data);
      }
      return response.end(String(data));
    };
    
    response.redirect = (code, urlString) => { 
      response.status(code)
        .set('location', sanitizeRedirectUrl(urlString))
        .end(); 
    };
    
    response.safeHtml = (html) => response.html(safeText(html));
    response.safeJson = (data) => response.json(data);
    response.setHeader('x-response-time', '0');

    if (secureHeaders) {
      response.setHeader('x-frame-options', 'SAMEORIGIN');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('cross-origin-opener-policy', 'same-origin');
      response.setHeader('cross-origin-resource-policy', 'same-origin');
    }

    // Session handling
    (async () => {
      try {
        const sessionId = await sessionManager.getSessionId(request, sessionSecret);
        const sessionData = await sessionManager.getSessionData(sessionId);
        
        request.session = sessionData || {};
        request.currentSessionId = sessionId;

        request.saveSession = () => sessionManager.withSessionLock(sessionId, async () => {
          await sessionManager.setSessionData(sessionId, request.session);
          xdCookie.set(response, 'sid', 
            `${sessionId}.${signData(sessionId, sessionSecret)}`, 
            { 
              httpOnly: true, 
              secure: request.secure, 
              maxAge: 3600, 
              path: '/', 
              sameSite: 'Lax' 
            }
          );
        });

        request.destroySession = () => sessionManager.withSessionLock(sessionId, async () => {
          await sessionManager.destroySessionData(sessionId);
          xdCookie.clear(response, 'sid', { path: '/' });
        });
      } catch (error) {
        console.error('Session initialization error:', error);
        request.session = {};
        request.currentSessionId = null;
      }
    })();
  };

  const requestHandler = async (request, response) => {
    const startTime = Date.now();
    setupRequestResponse(request, response);

    response.on('finish', () => {
      if (enableLogs) {
        console.log(
          `${request.method} ${request.path} ` +
          `${response.statusCode || 200} ${Date.now() - startTime}ms`
        );
      }
    });

    try {
      const globalMiddlewares = middlewares
        .filter(m => m.path === '*' || request.path.startsWith(m.path))
        .map(m => m.middleware);
      
      await executeMiddlewares(request, response, globalMiddlewares);
      
      if (response.headersSent || response.writableEnded) return;
    } catch (error) {
      return errorHandlerMiddleware(error, request, response, () => {});
    }

    if (request.method === 'HEAD') {
      const routeMatch = matchRoute('GET', request.path);
      if (routeMatch) {
        request.params = routeMatch.params;
        
        const originalWrite = response.write;
        const originalEnd = response.end;
        
        response.write = () => true;
        response.end = function() {
          try {
            return originalEnd.call(response);
          } catch {
            return undefined;
          }
        };
        
        try {
          await routeMatch.handler(request, response);
        } catch (error) {
          errorHandlerMiddleware(error, request, response, () => {});
        }
        
        response.write = originalWrite;
        response.end = originalEnd;
        return;
      }
      
      if (await serveFileAsync(request, response, request.path, 'HEAD', staticRoot, mimeTypes, staticMaxAge, secureHeaders)) return;
      if (spaMode && await serveFileAsync(request, response, '/index.html', 'HEAD', staticRoot, mimeTypes, staticMaxAge, secureHeaders)) return;
      
      response.status(404).end();
      return;
    }

    const routeMatch = matchRoute(request.method, request.path);
    if (routeMatch) {
      request.params = routeMatch.params;
      
      try {
        if (request.method === 'GET' || request.method === 'DELETE') {
          await routeMatch.handler(request, response);
        } else {
          const bodyResult = await parseRequestBody(request, maxBodySize, {});
          
          if (bodyResult === null) {
            return response.status(413).send('Payload Too Large');
          }
          
          request.body = bodyResult;
          await routeMatch.handler(request, response);
        }
      } catch (error) {
        errorHandlerMiddleware(error, request, response, () => {});
      }
      
      return;
    }

    if (await serveFileAsync(request, response, request.path, 'GET', staticRoot, mimeTypes, staticMaxAge, secureHeaders)) return;
    if (spaMode && await serveFileAsync(request, response, '/index.html', 'GET', staticRoot, mimeTypes, staticMaxAge, secureHeaders)) return;
    
    response.status(404).send('Not Found');
  };

  const server = options.https ? 
    httpsCreateServer(options.tls || {}, requestHandler) : 
    httpCreateServer(requestHandler);

  server.on('upgrade', (request, socket, head) => {
    const upgradeHeader = String(request.headers.upgrade || '').toLowerCase();
    
    if (upgradeHeader !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      xdWebSocket.handleUpgrade(request, socket, head, wsRoutes, wsOptions);
    } catch (error) {
      console.error('WebSocket upgrade error:', error);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  const app = {
    get: (pattern, handler) => { 
      addRoute('GET', pattern, handler); 
      return app; 
    },
    
    post: (pattern, handler) => { 
      addRoute('POST', pattern, handler); 
      return app; 
    },
    
    put: (pattern, handler) => { 
      addRoute('PUT', pattern, handler); 
      return app; 
    },
    
    delete: (pattern, handler) => { 
      addRoute('DELETE', pattern, handler); 
      return app; 
    },
    
    use: (pathPattern, middleware) => { 
      useMiddleware(pathPattern, middleware); 
      return app; 
    },

    ws: (pattern, handler) => {
      addWsRoute(pattern, (ws) => {
        wsClients.add(ws);
        ws.on('close', () => wsClients.delete(ws));
        handler(ws);
      });
      return app;
    },

    getWsClients: () => wsClients,

    broadcast: (data, options = {}) => {
      const filterFn = options.filter || (() => true);
      const excludeSet = options.exclude ? 
        new Set(Array.isArray(options.exclude) ? options.exclude : [options.exclude]) : 
        new Set();
      
      for (const client of wsClients) {
        if (client.readyState === WS_READY_STATES.OPEN && 
            !excludeSet.has(client) && 
            filterFn(client)) {
          try {
            client.send(data, options);
          } catch (error) {
            console.error('Broadcast error:', error);
          }
        }
      }
    },

    listen: (port, callback) => {
      server.listen(port, () => {
        console.log(
          `Server: http${options.https ? 's' : ''}://localhost:${port}`
        );
        if (callback) callback();
      });
      return app;
    },

    server
  };

  if (options.rateLimit !== false) {
    app.use(rateLimiterMiddleware);
  }
  
  if (options.cors !== false) {
    app.use(corsMiddleware);
  }

  return app;
};

const xdSrv = {
  createApp: createServerApp
};

// ==================== EXPORTS ====================
export {
  xdRedis,
  xdLRU,
  xdCookie,
  escapeAny,
  safeText,
  safeAttr,
  safeUrlAttr,
  errorHandlerMiddleware as errorHandler,
  corsMiddleware as cors,
  createRateLimiter,
  rateLimiterMiddleware,
  xdWebSocket,
  xdSrv
};

export default xdSrv;