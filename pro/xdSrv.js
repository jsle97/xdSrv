/* xdSrv.js - Lightweight HTTP/HTTPS/WebSocket Server Framework for Node.js
 * Version: 6.6.6 | License: MIT
 * Copyright (c) 2026 Jakub Śledzikowski <jsledzikowski.web@gmail.com>
 */

import { createServer as httpCreateServer } from 'node:http';
import { createServer as httpsCreateServer } from 'node:https';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

const pipelineAsync = promisify(pipeline);

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

const REQUEST_METHODS = Object.freeze({
 GET: 'GET',
 POST: 'POST',
 PUT: 'PUT',
 DELETE: 'DELETE',
 HEAD: 'HEAD',
 OPTIONS: 'OPTIONS',
 PATCH: 'PATCH'
});

const LOG_LEVELS = Object.freeze({
 TRACE: 0,
 DEBUG: 1,
 INFO: 2,
 WARN: 3,
 ERROR: 4,
 FATAL: 5,
 SILENT: 6
});

const HOP_BY_HOP_HEADERS = new Set([
 'connection', 'keep-alive', 'proxy-authenticate',
 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const COMPRESSIBLE_TYPES = new Set([
 'text/html', 'text/css', 'text/plain', 'text/xml', 'text/javascript',
 'application/javascript', 'application/json', 'application/xml',
 'application/xhtml+xml', 'image/svg+xml', 'application/wasm'
]);

const DEFAULT_MIME_TYPES = Object.freeze({
 html: 'text/html; charset=utf-8',
 css: 'text/css; charset=utf-8',
 js: 'application/javascript; charset=utf-8',
 mjs: 'application/javascript; charset=utf-8',
 json: 'application/json; charset=utf-8',
 txt: 'text/plain; charset=utf-8',
 xml: 'application/xml; charset=utf-8',
 svg: 'image/svg+xml',
 png: 'image/png',
 jpg: 'image/jpeg',
 jpeg: 'image/jpeg',
 webp: 'image/webp',
 avif: 'image/avif',
 gif: 'image/gif',
 bmp: 'image/bmp',
 ico: 'image/x-icon',
 woff: 'font/woff',
 woff2: 'font/woff2',
 ttf: 'font/ttf',
 otf: 'font/otf',
 eot: 'application/vnd.ms-fontobject',
 wasm: 'application/wasm',
 map: 'application/json; charset=utf-8',
 mp4: 'video/mp4',
 webm: 'video/webm',
 mp3: 'audio/mpeg',
 ogg: 'audio/ogg',
 wav: 'audio/wav',
 pdf: 'application/pdf',
 zip: 'application/zip',
 gz: 'application/gzip'
});

const ERROR_CODES = Object.freeze({
 BAD_REQUEST: { status: 400, code: 'BAD_REQUEST', message: 'Bad Request' },
 UNAUTHORIZED: { status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' },
 FORBIDDEN: { status: 403, code: 'FORBIDDEN', message: 'Forbidden' },
 NOT_FOUND: { status: 404, code: 'NOT_FOUND', message: 'Not Found' },
 METHOD_NOT_ALLOWED: { status: 405, code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' },
 CONFLICT: { status: 409, code: 'CONFLICT', message: 'Conflict' },
 PAYLOAD_TOO_LARGE: { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Payload Too Large' },
 UNPROCESSABLE: { status: 422, code: 'UNPROCESSABLE', message: 'Unprocessable Entity' },
 TOO_MANY_REQUESTS: { status: 429, code: 'TOO_MANY_REQUESTS', message: 'Too Many Requests' },
 INTERNAL: { status: 500, code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
 BAD_GATEWAY: { status: 502, code: 'BAD_GATEWAY', message: 'Bad Gateway' },
 SERVICE_UNAVAILABLE: { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable' },
 GATEWAY_TIMEOUT: { status: 504, code: 'GATEWAY_TIMEOUT', message: 'Gateway Timeout' }
});

// ==================== ASYNC LOCAL STORAGE CONTEXT ====================
const requestContext = new AsyncLocalStorage();

const getRequestContext = () => requestContext.getStore() || {};

const getRequestId = () => {
 const store = requestContext.getStore();
 return store ? store.requestId : null;
};

// ==================== ERROR FACTORY ====================
const createAppError = (codeKey, details = {}) => {
 const template = ERROR_CODES[codeKey] || ERROR_CODES.INTERNAL;
 const error = new Error(details.message || template.message);
 error.status = details.status || template.status;
 error.code = details.code || template.code;
 error.details = details.details || null;
 error.suggestion = details.suggestion || null;
 error.requestId = getRequestId();
 error.timestamp = Date.now();
 error.isOperational = details.isOperational !== false;
 return error;
};

const createErrorWithCode = (msg, code) => {
 const e = new Error(msg);
 e.code = code;
 return e;
};

// ==================== STRUCTURED LOGGER ====================
const createLogger = (options = {}) => {
 const {
  level = 'INFO',
  format = 'json',
  output = process.stdout,
  context = {},
  redactKeys = ['password', 'secret', 'token', 'authorization', 'cookie', 'sessionSecret']
 } = options;

 const minLevel = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
 const redactSet = new Set(redactKeys.map(k => k.toLowerCase()));

 const redact = (obj) => {
  if (typeof obj !== 'object' || obj === null) return obj;
  const result = Array.isArray(obj) ? [] : {};
  for (const key of Object.keys(obj)) {
   if (redactSet.has(key.toLowerCase())) {
    result[key] = '[REDACTED]';
   } else if (typeof obj[key] === 'object' && obj[key] !== null) {
    result[key] = redact(obj[key]);
   } else {
    result[key] = obj[key];
   }
  }
  return result;
 };

 const formatEntry = (lvl, msg, data) => {
  const entry = {
   timestamp: new Date().toISOString(),
   level: lvl,
   message: msg,
   requestId: getRequestId(),
   ...context,
   ...(data ? { data: redact(data) } : {})
  };

  if (format === 'text') {
   const dataStr = data ? ' ' + safeJsonStringify(redact(data)) : '';
   return `[${entry.timestamp}] ${lvl} ${entry.requestId ? `(${entry.requestId}) ` : ''}${msg}${dataStr}\n`;
  }
  return safeJsonStringify(entry) + '\n';
 };

 const log = (lvl, msg, data) => {
  if (LOG_LEVELS[lvl] < minLevel) return;
  const formatted = formatEntry(lvl, msg, data);
  output.write(formatted);
 };

 return {
  trace: (msg, data) => log('TRACE', msg, data),
  debug: (msg, data) => log('DEBUG', msg, data),
  info: (msg, data) => log('INFO', msg, data),
  warn: (msg, data) => log('WARN', msg, data),
  error: (msg, data) => log('ERROR', msg, data),
  fatal: (msg, data) => log('FATAL', msg, data),
  child: (childContext) => createLogger({ level, format, output, context: { ...context, ...childContext }, redactKeys }),
  get level() { return level; },
  setLevel: (newLevel) => createLogger({ level: newLevel, format, output, context, redactKeys })
 };
};

const defaultLogger = createLogger({ format: 'text' });

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
  if (typeof val === 'bigint') return val.toString();
  return val;
 }) || '';
};

const safeJsonParse = (str, reviver) => {
 if (typeof str !== 'string') return null;
 const trimmed = str.trim();
 if (!trimmed) return null;
 try {
  return JSON.parse(trimmed, reviver);
 } catch {
  return null;
 }
};

const parseUrlSearchParams = (search) => Object.fromEntries(new URLSearchParams(search));

const createRegexPattern = (pattern) => {
 if (!pattern.includes(':') && !pattern.includes('*')) return null;
 const regexStr = pattern
  .replace(/\*/g, '(.*)')
  .replace(/:(\w+)/g, '(?<$1>[^/]+)');
 return new RegExp('^' + regexStr + '$');
};

const mapReplace = (string, regex, mapping) =>
 string.replace(regex, char => mapping[char] || char);

const toStringSafe = (value, options = {}) => {
 if (value == null) return '';
 if (typeof value === 'string') return options.normalize ? value.normalize('NFC') : value;
 if (typeof value === 'number' || typeof value === 'bigint' ||
  typeof value === 'boolean' || typeof value === 'symbol') return String(value);
 if (value instanceof Date) return isNaN(value.getTime()) ? '' : value.toISOString();

 const handleObjects = options.handleObjects || 'convert';
 if (handleObjects === 'empty') return '';
 if (handleObjects === 'json') return safeJsonStringify(value);
 if (handleObjects === 'throw') throw new TypeError('Non-primitive values not allowed');
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
 if (!options.inAttribute || !options.targetName) return 'htmlContent';
 const name = options.targetName.toLowerCase();
 if (/^on/.test(name)) return 'jsString';
 if (name === 'style') return 'cssString';
 if (/^(href|src|xlink:href|action|formaction|poster|data)$/i.test(name)) return 'url';
 return options.quote ? 'htmlAttribute' : 'htmlAttributeUnquoted';
};

const escapeAny = (value, options = {}) => {
 const opts = { ...DEFAULT_ESCAPE_OPTIONS, ...options };
 let string = toStringSafe(value, opts);
 if (opts.normalize && typeof string.normalize === 'function') string = string.normalize('NFC');
 const context = opts.context === 'auto' ? detectContext(string, opts) : opts.context;

 switch (context) {
  case 'htmlContent':
  case 'htmlAttribute':
   return mapReplace(string, HTML_RE, HTML_ESCAPES);
  case 'htmlAttributeUnquoted':
   return mapReplace(string, HTML_UNQUOTED_RE, HTML_UNQUOTED_ESCAPES);
  case 'htmlComment':
   return string.replace(/--/g, '&#45;&#45;').replace(/>/g, '>').replace(/</g, '<');
  case 'jsString':
   return jsEscapeString(string, opts.quote === "'" ? "'" : opts.quote === '`' ? '`' : '"');
  case 'scriptData':
   return string.replace(END_SCRIPT_RE, '<\\/script').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  case 'cssString':
   return cssEscapeString(string);
  case 'cssIdent':
   return cssEscapeIdent(string);
  case 'cssUrl':
   return `url("${mapReplace(sanitizeUrl(string, opts.urlPolicy), HTML_RE, HTML_ESCAPES)}")`;
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
  context: 'auto', inAttribute: true, targetName: name,
  quote: quoted ? '"' : '', ...options
 });
 return quoted ? `${name}="${escapedValue}"` : `${name}=${escapedValue}`;
};

const safeUrlAttr = (name, url, options = {}) => {
 const escapedUrl = escapeAny(url, {
  context: 'url', inAttribute: true, targetName: name, ...options
 });
 return `${name}="${mapReplace(escapedUrl, HTML_RE, HTML_ESCAPES)}"`;
};

// ==================== INPUT VALIDATION ====================
const createValidator = () => {
 const rules = {
  required: (val) => val != null && val !== '',
  string: (val) => typeof val === 'string',
  number: (val) => typeof val === 'number' && !isNaN(val),
  integer: (val) => Number.isInteger(val),
  boolean: (val) => typeof val === 'boolean',
  email: (val) => typeof val === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) && val.length <= 254,
  url: (val) => { try { new URL(val); return true; } catch { return false; } },
  uuid: (val) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val),
  minLength: (val, min) => typeof val === 'string' && val.length >= min,
  maxLength: (val, max) => typeof val === 'string' && val.length <= max,
  min: (val, min) => typeof val === 'number' && val >= min,
  max: (val, max) => typeof val === 'number' && val <= max,
  pattern: (val, regex) => typeof val === 'string' && regex.test(val),
  oneOf: (val, allowed) => allowed.includes(val),
  array: (val) => Array.isArray(val),
  object: (val) => typeof val === 'object' && val !== null && !Array.isArray(val),
  date: (val) => !isNaN(Date.parse(val)),
  alphanumeric: (val) => typeof val === 'string' && /^[a-zA-Z0-9]+$/.test(val),
  hex: (val) => typeof val === 'string' && /^[0-9a-fA-F]+$/.test(val),
  ip: (val) => typeof val === 'string' && (/^(\d{1,3}\.){3}\d{1,3}$/.test(val) || /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(val)),
  port: (val) => Number.isInteger(val) && val >= 0 && val <= 65535
 };

 const validate = (data, schema) => {
  const errors = [];
  const sanitized = {};

  for (const [field, fieldRules] of Object.entries(schema)) {
   const value = data[field];
   const fieldErrors = [];

   if (fieldRules.required && !rules.required(value)) {
    fieldErrors.push(`${field} is required`);
    errors.push(...fieldErrors);
    continue;
   }

   if (value == null || value === '') {
    if (fieldRules.default !== undefined) sanitized[field] = fieldRules.default;
    continue;
   }

   if (fieldRules.type && rules[fieldRules.type] && !rules[fieldRules.type](value)) {
    fieldErrors.push(`${field} must be of type ${fieldRules.type}`);
   }

   if (fieldRules.minLength && !rules.minLength(value, fieldRules.minLength)) {
    fieldErrors.push(`${field} must be at least ${fieldRules.minLength} characters`);
   }

   if (fieldRules.maxLength && !rules.maxLength(value, fieldRules.maxLength)) {
    fieldErrors.push(`${field} must be at most ${fieldRules.maxLength} characters`);
   }

   if (fieldRules.min !== undefined && !rules.min(Number(value), fieldRules.min)) {
    fieldErrors.push(`${field} must be >= ${fieldRules.min}`);
   }

   if (fieldRules.max !== undefined && !rules.max(Number(value), fieldRules.max)) {
    fieldErrors.push(`${field} must be <= ${fieldRules.max}`);
   }

   if (fieldRules.pattern && !rules.pattern(String(value), fieldRules.pattern)) {
    fieldErrors.push(`${field} has invalid format`);
   }

   if (fieldRules.oneOf && !rules.oneOf(value, fieldRules.oneOf)) {
    fieldErrors.push(`${field} must be one of: ${fieldRules.oneOf.join(', ')}`);
   }

   if (fieldRules.custom && typeof fieldRules.custom === 'function') {
    const customResult = fieldRules.custom(value, data);
    if (customResult !== true) {
     fieldErrors.push(typeof customResult === 'string' ? customResult : `${field} is invalid`);
    }
   }

   if (fieldRules.sanitize && typeof fieldRules.sanitize === 'function') {
    sanitized[field] = fieldRules.sanitize(value);
   } else if (fieldErrors.length === 0) {
    sanitized[field] = value;
   }

   errors.push(...fieldErrors);
  }

  return { valid: errors.length === 0, errors, data: sanitized };
 };

 return { validate, rules };
};

const xdValidate = createValidator();

// ==================== LRU CACHE ====================
const createCache = ({ max = 500, ttl = 0, updateAgeOnGet = true, dispose = null, stats = false } = {}) => {
 const cache = new Map();
 const expiries = new Map();
 let hits = 0;
 let misses = 0;

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
  if (!cache.has(key)) { misses++; return undefined; }
  if (isExpired(key)) { deleteKey(key); misses++; return undefined; }
  const value = cache.get(key);
  if (updateAgeOnGet) { cache.delete(key); cache.set(key, value); }
  hits++;
  return value;
 };

 const set = (key, value, setOpts = {}) => {
  const effectiveTtl = setOpts.ttl !== undefined ? setOpts.ttl : ttl;
  const expiry = effectiveTtl === Infinity || effectiveTtl <= 0 ? Infinity : Date.now() + effectiveTtl;
  if (cache.has(key)) { cache.delete(key); expiries.delete(key); }
  else if (cache.size >= max) evictOne();
  cache.set(key, value);
  expiries.set(key, expiry);
  return true;
 };

 const has = (key) => {
  if (!cache.has(key)) return false;
  if (isExpired(key)) { deleteKey(key); return false; }
  return true;
 };

 const clear = () => {
  if (dispose) { for (const [key, value] of cache) dispose(key, value, 'clear'); }
  cache.clear();
  expiries.clear();
  hits = 0;
  misses = 0;
 };

 const getKeys = () => {
  const validKeys = [];
  for (const key of cache.keys()) { if (!isExpired(key)) validKeys.push(key); }
  return validKeys[Symbol.iterator]();
 };

 const getSize = () => {
  let count = 0;
  for (const key of cache.keys()) { if (!isExpired(key)) count++; }
  return count;
 };

 const getStats = () => ({
  hits, misses,
  ratio: hits + misses > 0 ? (hits / (hits + misses)).toFixed(4) : '0.0000',
  size: getSize(),
  maxSize: max
 });

 return {
  get, set, has, delete: deleteKey, clear, keys: getKeys,
  size: getSize, stats: getStats
 };
};

const xdLRU = (opts = {}) => createCache({
 max: opts.max || 500,
 ttl: opts.ttl || 0,
 updateAgeOnGet: opts.updateAgeOnGet !== false,
 dispose: opts.dispose || null,
 stats: opts.stats || false
});

// ==================== REDIS-LIKE STORE ====================
const createRedisInstance = ({ max = 1000 } = {}) => {
 const wrap = (type, data) => ({ __type: type, data });
 const expiries = new Map();
 const cache = xdLRU({ max, ttl: Infinity, updateAgeOnGet: true, dispose: key => expiries.delete(key) });

 const expired = (key) => {
  const expiry = expiries.get(key);
  return expiry !== undefined && expiry !== Infinity && Date.now() > expiry;
 };

 const assertType = (entry, type) => {
  if (!entry || entry.__type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
 };

 const setWithTTL = (key, payload, ttlSeconds = -1) => {
  const expiry = ttlSeconds >= 0 ? Date.now() + ttlSeconds * 1000 : Infinity;
  expiries.set(key, expiry);
  cache.set(key, payload, { ttl: expiry === Infinity ? Infinity : expiry - Date.now() });
 };

 const touch = (key) => {
  if (expired(key)) { cache.delete(key); return false; }
  return true;
 };

 const getEntry = (key) => cache.get(key);

 const getTtlSeconds = (key) => {
  if (!touch(key) || !cache.has(key)) return -2;
  const expiry = expiries.get(key);
  if (expiry === Infinity) return -1;
  return Math.max(1, Math.ceil((expiry - Date.now()) / 1000));
 };

 const preserveTtl = (key) => { const t = getTtlSeconds(key); return t === -2 ? -1 : t; };

 const stringOps = {
  set: (key, value, { ttl = -1 } = {}) => { setWithTTL(key, wrap('string', value), ttl); return 'OK'; },
  get: (key) => { if (!touch(key)) return null; const e = getEntry(key); return e ? e.data : null; },
  incr: (key) => {
   const v = stringOps.get(key);
   const n = parseInt(v ?? 0, 10);
   if (Number.isNaN(n) && v !== null) throw new Error('ERR value is not an integer or out of range');
   const r = (Number.isNaN(n) ? 0 : n) + 1;
   stringOps.set(key, String(r), { ttl: preserveTtl(key) });
   return r;
  },
  decr: (key) => {
   const v = stringOps.get(key);
   const n = parseInt(v ?? 0, 10);
   if (Number.isNaN(n) && v !== null) throw new Error('ERR value is not an integer or out of range');
   const r = (Number.isNaN(n) ? 0 : n) - 1;
   stringOps.set(key, String(r), { ttl: preserveTtl(key) });
   return r;
  },
  append: (key, string) => {
   const c = String(stringOps.get(key) ?? '');
   const r = c + string;
   stringOps.set(key, r, { ttl: preserveTtl(key) });
   return r.length;
  },
  mset: (pairs) => {
   for (const [k, v] of Object.entries(pairs)) stringOps.set(k, v);
   return 'OK';
  },
  mget: (...keys) => keys.map(k => stringOps.get(k)),
  setnx: (key, value, { ttl = -1 } = {}) => {
   if (api.exists(key)) return 0;
   stringOps.set(key, value, { ttl });
   return 1;
  },
  getset: (key, value) => {
   const old = stringOps.get(key);
   stringOps.set(key, value, { ttl: preserveTtl(key) });
   return old;
  },
  incrby: (key, increment) => {
   const v = stringOps.get(key);
   const n = parseInt(v ?? 0, 10);
   if (Number.isNaN(n) && v !== null) throw new Error('ERR value is not an integer or out of range');
   const r = (Number.isNaN(n) ? 0 : n) + increment;
   stringOps.set(key, String(r), { ttl: preserveTtl(key) });
   return r;
  },
  decrby: (key, decrement) => stringOps.incrby(key, -decrement)
 };

 const listOps = {
  lpush: (key, ...elements) => {
   touch(key);
   const e = getEntry(key);
   const list = e ? (assertType(e, 'list'), e.data) : [];
   for (const el of elements) list.unshift(String(el));
   setWithTTL(key, wrap('list', list), preserveTtl(key));
   return list.length;
  },
  rpush: (key, ...elements) => {
   touch(key);
   const e = getEntry(key);
   const list = e ? (assertType(e, 'list'), e.data) : [];
   for (const el of elements) list.push(String(el));
   setWithTTL(key, wrap('list', list), preserveTtl(key));
   return list.length;
  },
  lpop: (key) => {
   if (!touch(key) || !cache.has(key)) return null;
   const e = getEntry(key); if (!e) return null;
   assertType(e, 'list');
   if (e.data.length === 0) return null;
   const v = e.data.shift();
   if (e.data.length) setWithTTL(key, wrap('list', e.data), preserveTtl(key));
   else api.del(key);
   return v;
  },
  rpop: (key) => {
   if (!touch(key) || !cache.has(key)) return null;
   const e = getEntry(key); if (!e) return null;
   assertType(e, 'list');
   if (e.data.length === 0) return null;
   const v = e.data.pop();
   if (e.data.length) setWithTTL(key, wrap('list', e.data), preserveTtl(key));
   else api.del(key);
   return v;
  },
  lrange: (key, start, end) => {
   if (!touch(key) || !cache.has(key)) return [];
   const e = getEntry(key); if (!e) return [];
   assertType(e, 'list');
   const len = e.data.length;
   const gi = (i) => i < 0 ? len + i : i;
   const from = Math.max(0, gi(start));
   const to = Math.min(len - 1, gi(end));
   return from <= to ? e.data.slice(from, to + 1) : [];
  },
  llen: (key) => {
   if (!touch(key) || !cache.has(key)) return 0;
   const e = getEntry(key); if (!e) return 0;
   assertType(e, 'list');
   return e.data.length;
  },
  lindex: (key, index) => {
   if (!touch(key) || !cache.has(key)) return null;
   const e = getEntry(key); if (!e) return null;
   assertType(e, 'list');
   const i = index < 0 ? e.data.length + index : index;
   return e.data[i] ?? null;
  }
 };

 const hashOps = {
  hset: (key, field, value) => {
   touch(key);
   const e = getEntry(key);
   const hash = e ? (assertType(e, 'hash'), e.data) : {};
   const isNew = !(String(field) in hash);
   hash[String(field)] = String(value);
   setWithTTL(key, wrap('hash', hash), preserveTtl(key));
   return isNew ? 1 : 0;
  },
  hget: (key, field) => {
   if (!touch(key) || !cache.has(key)) return null;
   const e = getEntry(key); if (!e) return null;
   assertType(e, 'hash');
   return e.data[String(field)] ?? null;
  },
  hdel: (key, ...fields) => {
   if (!touch(key) || !cache.has(key)) return 0;
   const e = getEntry(key); if (!e) return 0;
   assertType(e, 'hash');
   let count = 0;
   for (const f of fields) {
    const fk = String(f);
    if (Object.hasOwn(e.data, fk)) { delete e.data[fk]; count++; }
   }
   if (count > 0) {
    if (Object.keys(e.data).length) setWithTTL(key, wrap('hash', e.data), preserveTtl(key));
    else api.del(key);
   }
   return count;
  },
  hkeys: (key) => {
   if (!touch(key) || !cache.has(key)) return [];
   const e = getEntry(key); if (!e) return [];
   assertType(e, 'hash');
   return Object.keys(e.data);
  },
  hgetall: (key) => {
   if (!touch(key) || !cache.has(key)) return {};
   const e = getEntry(key); if (!e) return {};
   assertType(e, 'hash');
   return { ...e.data };
  },
  hvals: (key) => {
   if (!touch(key) || !cache.has(key)) return [];
   const e = getEntry(key); if (!e) return [];
   assertType(e, 'hash');
   return Object.values(e.data);
  },
  hlen: (key) => {
   if (!touch(key) || !cache.has(key)) return 0;
   const e = getEntry(key); if (!e) return 0;
   assertType(e, 'hash');
   return Object.keys(e.data).length;
  },
  hexists: (key, field) => {
   if (!touch(key) || !cache.has(key)) return 0;
   const e = getEntry(key); if (!e) return 0;
   assertType(e, 'hash');
   return Object.hasOwn(e.data, String(field)) ? 1 : 0;
  },
  hmset: (key, fieldValues) => {
   for (const [f, v] of Object.entries(fieldValues)) hashOps.hset(key, f, v);
   return 'OK';
  },
  hincrby: (key, field, increment) => {
   const current = hashOps.hget(key, field);
   const n = parseInt(current ?? 0, 10);
   if (Number.isNaN(n) && current !== null) throw new Error('ERR hash value is not an integer');
   const r = (Number.isNaN(n) ? 0 : n) + increment;
   hashOps.hset(key, field, String(r));
   return r;
  }
 };

 const setOps = {
  sadd: (key, ...members) => {
   touch(key);
   const e = getEntry(key);
   const s = e ? (assertType(e, 'set'), e.data) : new Set();
   let count = 0;
   for (const m of members) { const ms = String(m); if (!s.has(ms)) { s.add(ms); count++; } }
   if (count > 0 || !e) setWithTTL(key, wrap('set', s), preserveTtl(key));
   return count;
  },
  srem: (key, ...members) => {
   if (!touch(key) || !cache.has(key)) return 0;
   const e = getEntry(key); if (!e) return 0;
   assertType(e, 'set');
   let count = 0;
   for (const m of members) { if (e.data.delete(String(m))) count++; }
   if (count > 0) {
    if (e.data.size) setWithTTL(key, wrap('set', e.data), preserveTtl(key));
    else api.del(key);
   }
   return count;
  },
  smembers: (key) => {
   if (!touch(key) || !cache.has(key)) return [];
   const e = getEntry(key); if (!e) return [];
   assertType(e, 'set');
   return [...e.data];
  },
  sismember: (key, member) => {
   if (!touch(key) || !cache.has(key)) return 0;
   const e = getEntry(key); if (!e) return 0;
   assertType(e, 'set');
   return e.data.has(String(member)) ? 1 : 0;
  },
  scard: (key) => {
   if (!touch(key) || !cache.has(key)) return 0;
   const e = getEntry(key); if (!e) return 0;
   assertType(e, 'set');
   return e.data.size;
  },
  srandmember: (key) => {
   if (!touch(key) || !cache.has(key)) return null;
   const e = getEntry(key); if (!e) return null;
   assertType(e, 'set');
   const arr = [...e.data];
   return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
  },
  sunion: (...keys) => {
   const result = new Set();
   for (const key of keys) {
    const members = setOps.smembers(key);
    for (const m of members) result.add(m);
   }
   return [...result];
  },
  sinter: (...keys) => {
   if (keys.length === 0) return [];
   let result = new Set(setOps.smembers(keys[0]));
   for (let i = 1; i < keys.length; i++) {
    const members = new Set(setOps.smembers(keys[i]));
    result = new Set([...result].filter(m => members.has(m)));
   }
   return [...result];
  }
 };

 const api = {
  exists: (key) => touch(key) && cache.has(key),
  del: (key) => cache.delete(key),
  keys: (pattern = '*') => {
   const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
   const result = [];
   for (const key of cache.keys()) { if (touch(key) && cache.has(key) && regex.test(key)) result.push(key); }
   return result;
  },
  ttl: (key) => getTtlSeconds(key),
  expire: (key, seconds) => {
   if (!api.exists(key)) return 0;
   const newTtlMs = seconds * 1000;
   expiries.set(key, Date.now() + newTtlMs);
   const payload = cache.get(key);
   if (payload !== undefined) cache.set(key, payload, { ttl: newTtlMs });
   return 1;
  },
  persist: (key) => {
   if (!api.exists(key)) return 0;
   expiries.set(key, Infinity);
   const payload = cache.get(key);
   if (payload !== undefined) cache.set(key, payload, { ttl: Infinity });
   return 1;
  },
  rename: (key, newKey) => {
   if (!api.exists(key)) throw new Error('ERR no such key');
   const payload = cache.get(key);
   const ttl = preserveTtl(key);
   api.del(key);
   setWithTTL(newKey, payload, ttl);
   return 'OK';
  },
  type: (key) => {
   if (!touch(key) || !cache.has(key)) return 'none';
   const e = getEntry(key);
   return e ? e.__type : 'none';
  },
  flushAll: () => { cache.clear(); expiries.clear(); return 'OK'; },
  dbsize: () => {
   let count = 0;
   for (const key of cache.keys()) { if (touch(key) && cache.has(key)) count++; }
   return count;
  },
  ...stringOps, ...listOps, ...hashOps, ...setOps
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
   if (taskString == null) { running--; return; }
   let taskPayload;
   try { taskPayload = JSON.parse(taskString); }
   catch {
    api.rpush(dlqName, JSON.stringify({ malformedTaskString: taskString, error: 'Failed to parse task JSON', failedAt: new Date().toISOString() }));
    running--;
    if (!stopped) scheduleNext();
    return;
   }
   const { originalTask, retryCount = 0 } = taskPayload;
   try { await worker(originalTask); }
   catch (error) {
    const attempt = retryCount + 1;
    if (attempt <= maxRetries) {
     await new Promise(resolve => setTimeout(resolve, baseRetryDelay * Math.pow(2, attempt - 1)));
     api.rpush(queueKey, JSON.stringify({ originalTask, retryCount: attempt }));
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
    if (api.lrange(queueKey, 0, 0).length === 0 && running === 0) break;
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
    const length = api.rpush(queueKey, JSON.stringify({ originalTask: task, retryCount: 0 }));
    if (!stopped && running < concurrency) { clearTimeout(pollTimeout); startPolling(); }
    return length;
   },
   stop: () => { stopped = true; clearTimeout(pollTimeout); },
   get length() { return api.lrange(queueKey, 0, -1).length; },
   get isRunning() { return !stopped; },
   getDLQName: () => dlqName,
   get dlqLength() { return api.lrange(dlqName, 0, -1).length; },
   viewDLQ: (start = 0, end = -1) => api.lrange(dlqName, start, end).map(item => JSON.parse(item))
  };
 };

 return { ...api, createRedisQueue };
};

const xdRedis = createRedisInstance;

// ==================== EVENT BUS ====================
const createEventBus = () => {
 const emitter = new EventEmitter();
 emitter.setMaxListeners(100);
 const subscriptions = new Map();

 const subscribe = (event, handler, options = {}) => {
  const { once = false, priority = 0 } = options;
  const id = crypto.randomBytes(8).toString('hex');
  const wrapper = async (...args) => {
   try { await handler(...args); }
   catch (err) { emitter.emit('bus:error', { event, error: err, subscriptionId: id }); }
  };
  wrapper.__priority = priority;
  wrapper.__id = id;
  if (once) emitter.once(event, wrapper);
  else emitter.on(event, wrapper);
  subscriptions.set(id, { event, handler: wrapper, once });
  return id;
 };

 const unsubscribe = (id) => {
  const sub = subscriptions.get(id);
  if (!sub) return false;
  emitter.removeListener(sub.event, sub.handler);
  subscriptions.delete(id);
  return true;
 };

 const publish = (event, data, metadata = {}) => {
  const envelope = {
   event, data,
   timestamp: Date.now(),
   id: crypto.randomBytes(8).toString('hex'),
   requestId: getRequestId(),
   ...metadata
  };
  emitter.emit(event, envelope);
  emitter.emit('*', envelope);
  return envelope.id;
 };

 const clear = (event) => {
  if (event) {
   emitter.removeAllListeners(event);
   for (const [id, sub] of subscriptions) { if (sub.event === event) subscriptions.delete(id); }
  } else {
   emitter.removeAllListeners();
   subscriptions.clear();
  }
 };

 return {
  subscribe, unsubscribe, publish, clear,
  on: (event, handler) => subscribe(event, handler),
  once: (event, handler) => subscribe(event, handler, { once: true }),
  off: unsubscribe,
  get listenerCount() {
   let count = 0;
   for (const [, sub] of subscriptions) count++;
   return count;
  }
 };
};

const xdEventBus = createEventBus;

// ==================== HTTP UTILITIES ====================
const signData = (data, secret) =>
 crypto.createHmac('sha256', String(secret)).update(data).digest('base64url');

const verifySignature = (data, signature, secret) => {
 const expected = signData(data, secret);
 if (expected.length !== signature.length) return false;
 return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};

const generateSessionId = () => crypto.randomBytes(32).toString('base64url');

const generateRequestId = () => crypto.randomBytes(12).toString('hex');

const isSecureConnection = (request, trustProxy) =>
 Boolean(request.socket?.encrypted) ||
 (trustProxy && String(request.headers['x-forwarded-proto'] || '').toLowerCase().split(',')[0]?.trim() === 'https');

const getClientIp = (request, trustProxy) => {
 if (trustProxy && request.headers['x-forwarded-for']) {
  return String(request.headers['x-forwarded-for']).split(',')[0].trim();
 }
 return request.socket?.remoteAddress || '';
};

const getHostname = (request) => String(request.headers.host || '').trim().replace(/:.*/, '');

const generateEtag = (stats, weak = true) => {
 const tag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
 return weak ? `W/${tag}` : tag;
};

const generateContentEtag = (content) => {
 const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
 return `"${hash}"`;
};

const appendVaryHeader = (existing, value) => {
 if (!existing) return value;
 const headers = new Set(existing.split(',').map(h => h.trim()).filter(Boolean));
 value.split(',').map(h => h.trim()).forEach(h => headers.add(h));
 return Array.from(headers).join(', ');
};

const sanitizeRedirectUrl = (url) =>
 (typeof url !== 'string' || url.includes('\n') || url.includes('\r')) ? '/' : url;

// ==================== ENCRYPTION UTILITIES ====================
const encryptAES256GCM = (plaintext, secret) => {
 const key = crypto.createHash('sha256').update(String(secret)).digest();
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
 const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
 const authTag = cipher.getAuthTag();
 return iv.toString('base64url') + '.' + encrypted.toString('base64url') + '.' + authTag.toString('base64url');
};

const decryptAES256GCM = (ciphertext, secret) => {
 try {
  const parts = ciphertext.split('.');
  if (parts.length !== 3) return null;
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = Buffer.from(parts[0], 'base64url');
  const encrypted = Buffer.from(parts[1], 'base64url');
  const authTag = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
 } catch {
  return null;
 }
};

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
    if (name) { try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; } }
   }
  }
  return cookies;
 };

 const serialize = (name, value, options = {}) => {
  if (!name || typeof name !== 'string') throw new TypeError('Cookie name must be a non-empty string');
  if (!/^[\w!#$%&'*+\-.0-9^`|~]+$/.test(name)) throw new TypeError('Invalid cookie name');
  let cookieString = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  const { maxAge, expires, domain, path: cookiePath = '/', secure, httpOnly = true, sameSite } = options;
  if (Number.isFinite(maxAge) && maxAge >= 0) cookieString += `; Max-Age=${Math.floor(maxAge)}`;
  if (expires instanceof Date) cookieString += `; Expires=${expires.toUTCString()}`;
  if (domain) {
   if (!/^\.[a-z0-9.-]+$/i.test(domain)) throw new TypeError('Invalid domain');
   cookieString += `; Domain=${domain}`;
  }
  if (cookiePath) {
   if (!/^\/[\w!#$%&'()*+\-./:<>?@[\]\\^_`{|}~]*$/.test(cookiePath)) throw new TypeError('Invalid path');
   cookieString += `; Path=${cookiePath}`;
  }
  if (httpOnly) cookieString += '; HttpOnly';
  if (secure) cookieString += '; Secure';
  if (sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None') cookieString += `; SameSite=${sameSite}`;
  else if (sameSite !== undefined) throw new TypeError('Invalid SameSite value');
  return cookieString;
 };

 const setCookieHeader = (response, cookieHeader) => {
  const existing = response.getHeader('Set-Cookie');
  if (Array.isArray(existing)) response.setHeader('Set-Cookie', [...existing, cookieHeader]);
  else response.setHeader('Set-Cookie', [cookieHeader]);
 };

 const set = (response, name, value, options) => { setCookieHeader(response, serialize(name, value, options)); };

 const setAll = (response, cookieMap, options) => {
  if (!cookieMap || typeof cookieMap !== 'object') throw new TypeError('Cookie map is required');
  const cookies = Object.entries(cookieMap).map(([n, v]) => serialize(n, v, options));
  const existing = response.getHeader('Set-Cookie');
  if (Array.isArray(existing)) response.setHeader('Set-Cookie', [...existing, ...cookies]);
  else response.setHeader('Set-Cookie', cookies);
 };

 const clear = (response, name, options = {}) => { set(response, name, '', { ...options, maxAge: 0, expires: new Date(0) }); };
 const get = (cookies, name) => cookies[name];
 const has = (cookies, name) => name in cookies;

 const setEncrypted = (response, name, value, secret, options) => {
  const encrypted = encryptAES256GCM(String(value), secret);
  set(response, name, encrypted, options);
 };

 const getEncrypted = (cookies, name, secret) => {
  const val = cookies[name];
  if (!val) return null;
  return decryptAES256GCM(val, secret);
 };

 return { parse, serialize, set, setAll, clear, get, has, setEncrypted, getEncrypted };
};

const xdCookie = createCookieHandler();

// ==================== SECURITY HEADERS BUILDER ====================
const createSecurityHeaders = (options = {}) => {
 const headers = {};

 const defaults = {
  frameOptions: options.frameOptions || 'SAMEORIGIN',
  referrerPolicy: options.referrerPolicy || 'strict-origin-when-cross-origin',
  contentTypeOptions: options.contentTypeOptions !== false,
  xssProtection: options.xssProtection !== false,
  coep: options.coep || null,
  coop: options.coop || 'same-origin',
  corp: options.corp || 'same-origin',
  hsts: options.hsts || null,
  permissionsPolicy: options.permissionsPolicy || null,
  csp: options.csp || null
 };

 if (defaults.frameOptions) headers['x-frame-options'] = defaults.frameOptions;
 if (defaults.referrerPolicy) headers['referrer-policy'] = defaults.referrerPolicy;
 if (defaults.contentTypeOptions) headers['x-content-type-options'] = 'nosniff';
 if (defaults.xssProtection) headers['x-xss-protection'] = '0';
 if (defaults.coop) headers['cross-origin-opener-policy'] = defaults.coop;
 if (defaults.corp) headers['cross-origin-resource-policy'] = defaults.corp;
 if (defaults.coep) headers['cross-origin-embedder-policy'] = defaults.coep;

 if (defaults.hsts) {
  const hstsValue = typeof defaults.hsts === 'object'
   ? `max-age=${defaults.hsts.maxAge || 31536000}${defaults.hsts.includeSubDomains ? '; includeSubDomains' : ''}${defaults.hsts.preload ? '; preload' : ''}`
   : String(defaults.hsts);
  headers['strict-transport-security'] = hstsValue;
 }

 if (defaults.permissionsPolicy) {
  const ppValue = typeof defaults.permissionsPolicy === 'object'
   ? Object.entries(defaults.permissionsPolicy).map(([k, v]) => `${k}=(${Array.isArray(v) ? v.join(' ') : v})`).join(', ')
   : String(defaults.permissionsPolicy);
  headers['permissions-policy'] = ppValue;
 }

 if (defaults.csp) {
  const cspValue = typeof defaults.csp === 'object'
   ? Object.entries(defaults.csp).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' ') : v}`).join('; ')
   : String(defaults.csp);
  headers['content-security-policy'] = cspValue;
 }

 return {
  headers,
  apply: (response) => {
   for (const [k, v] of Object.entries(headers)) response.setHeader(k, v);
  },
  middleware: (request, response, next) => {
   for (const [k, v] of Object.entries(headers)) response.setHeader(k, v);
   next();
  }
 };
};

// ==================== CSRF MIDDLEWARE ====================
const createCsrfProtection = (options = {}) => {
 const {
  secret,
  tokenLength = 32,
  cookieName = '_csrf',
  headerName = 'x-csrf-token',
  fieldName = '_csrf',
  safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']),
  cookieOptions = {}
 } = options;

 const csrfSecret = secret || crypto.randomBytes(32).toString('hex');

 const generateToken = () => {
  const token = crypto.randomBytes(tokenLength).toString('hex');
  const sig = signData(token, csrfSecret);
  return `${token}.${sig}`;
 };

 const verifyToken = (token) => {
  if (!token || typeof token !== 'string') return false;
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;
  const tokenPart = token.slice(0, dotIndex);
  const sigPart = token.slice(dotIndex + 1);
  return verifySignature(tokenPart, sigPart, csrfSecret);
 };

 const middleware = (request, response, next) => {
  if (!request.csrfToken) {
   const existingToken = request.cookies[cookieName];
   if (existingToken && verifyToken(existingToken)) {
    request.csrfToken = existingToken;
   } else {
    request.csrfToken = generateToken();
    xdCookie.set(response, cookieName, request.csrfToken, {
     httpOnly: false, secure: request.secure,
     sameSite: 'Strict', path: '/', ...cookieOptions
    });
   }
  }

  request.generateCsrfToken = () => request.csrfToken;

  if (safeMethods.has(request.method)) return next();

  const submittedToken =
   request.headers[headerName] ||
   (request.body && request.body[fieldName]) ||
   request.query[fieldName];

  if (!submittedToken || !verifyToken(submittedToken)) {
   response.status(403).json({ error: 'CSRF token validation failed', code: 'CSRF_INVALID' });
   return;
  }

  next();
 };

 return { middleware, generateToken, verifyToken };
};

// ==================== COMPRESSION MIDDLEWARE ====================
const createCompressionMiddleware = (options = {}) => {
 const {
  threshold = 1024,
  level = zlib.constants.Z_DEFAULT_COMPRESSION,
  brotliEnabled = true,
  filter = null
 } = options;

 return (request, response, next) => {
  const acceptEncoding = String(request.headers['accept-encoding'] || '');
  if (!acceptEncoding) return next();

  const originalEnd = response.end;
  const originalWrite = response.write;
  let chunks = [];
  let totalLength = 0;
  let headersSent = false;

  response.write = function(chunk, encoding, callback) {
   if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
   if (chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
    chunks.push(buf);
    totalLength += buf.length;
   }
   if (callback) callback();
   return true;
  };

  response.end = function(chunk, encoding, callback) {
   if (typeof chunk === 'function') { callback = chunk; chunk = null; encoding = undefined; }
   if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }

   if (chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
    chunks.push(buf);
    totalLength += buf.length;
   }

   const body = Buffer.concat(chunks);
   chunks = [];

   const contentType = String(response.getHeader('content-type') || '');
   const baseType = contentType.split(';')[0].trim();
   const shouldCompress = filter
    ? filter(request, response)
    : COMPRESSIBLE_TYPES.has(baseType);

   if (!shouldCompress || body.length < threshold || response.statusCode === 204 || response.statusCode === 304) {
    response.setHeader('content-length', String(body.length));
    return originalEnd.call(response, body, callback);
   }

   // Prefer brotli > gzip > deflate
   let encoding_type = null;
   let compressor = null;

   if (brotliEnabled && acceptEncoding.includes('br')) {
    encoding_type = 'br';
    compressor = zlib.brotliCompressSync(body, {
     params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
    });
   } else if (acceptEncoding.includes('gzip')) {
    encoding_type = 'gzip';
    compressor = zlib.gzipSync(body, { level });
   } else if (acceptEncoding.includes('deflate')) {
    encoding_type = 'deflate';
    compressor = zlib.deflateSync(body, { level });
   }

   if (compressor && compressor.length < body.length) {
    response.removeHeader('content-length');
    response.setHeader('content-encoding', encoding_type);
    response.setHeader('content-length', String(compressor.length));
    response.setHeader('vary', appendVaryHeader(String(response.getHeader('vary') || ''), 'Accept-Encoding'));
    return originalEnd.call(response, compressor, callback);
   }

   response.setHeader('content-length', String(body.length));
   return originalEnd.call(response, body, callback);
  };

  next();
 };
};

// ==================== RATE LIMITER (TOKEN BUCKET + SLIDING WINDOW) ====================
const createRateLimiter = (options = {}) => {
 const {
  windowMs = 15 * 60 * 1000,
  max: maxRequests = 100,
  algorithm = 'sliding-window',
  keyGenerator = (request) => request.ip || request.connection?.remoteAddress || 'unknown',
  skipFailedRequests = false,
  skip = null,
  message = 'Too many requests',
  store = null
 } = typeof options === 'number' ? { windowMs: arguments[0], max: arguments[1] } : options;

 const rateLimiterCache = store || xdLRU({ max: 50000, ttl: windowMs, updateAgeOnGet: false });

 if (algorithm === 'token-bucket') {
  const refillRate = maxRequests / (windowMs / 1000);

  return (request, response, next) => {
   if (skip && skip(request)) return next();
   const key = keyGenerator(request);

   let bucket = rateLimiterCache.get(key);
   const now = Date.now();

   if (!bucket) {
    bucket = { tokens: maxRequests - 1, lastRefill: now };
    rateLimiterCache.set(key, bucket, { ttl: windowMs });
    response.setHeader('X-RateLimit-Limit', String(maxRequests));
    response.setHeader('X-RateLimit-Remaining', String(bucket.tokens));
    return next();
   }

   const elapsed = (now - bucket.lastRefill) / 1000;
   bucket.tokens = Math.min(maxRequests, bucket.tokens + elapsed * refillRate);
   bucket.lastRefill = now;

   if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    rateLimiterCache.set(key, bucket, { ttl: windowMs });
    response.setHeader('X-RateLimit-Limit', String(maxRequests));
    response.setHeader('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));
    return next();
   }

   const retryAfter = Math.ceil((1 - bucket.tokens) / refillRate);
   response.setHeader('X-RateLimit-Limit', String(maxRequests));
   response.setHeader('X-RateLimit-Remaining', '0');
   response.setHeader('Retry-After', String(retryAfter));
   return response.status(429).json({ error: message, retryAfter });
  };
 }

 // Sliding window (default)
 return (request, response, next) => {
  if (skip && skip(request)) return next();
  const key = keyGenerator(request);
  const now = Date.now();

  let record = rateLimiterCache.get(key);
  if (!record) {
   record = { count: 0, reset: now + windowMs, timestamps: [] };
   rateLimiterCache.set(key, record, { ttl: windowMs });
  }

  // Clean expired timestamps
  record.timestamps = record.timestamps.filter(t => t > now - windowMs);
  record.timestamps.push(now);
  record.count = record.timestamps.length;

  const remaining = Math.max(0, maxRequests - record.count);
  response.setHeader('X-RateLimit-Limit', String(maxRequests));
  response.setHeader('X-RateLimit-Remaining', String(remaining));
  response.setHeader('X-RateLimit-Reset', String(Math.floor((now + windowMs) / 1000)));

  if (record.count > maxRequests) {
   const retryAfter = Math.ceil(windowMs / 1000);
   response.setHeader('Retry-After', String(retryAfter));
   return response.status(429).json({ error: message, retryAfter });
  }

  rateLimiterCache.set(key, record, { ttl: windowMs });
  next();
 };
};

const rateLimiterMiddleware = createRateLimiter();

// ==================== CORS MIDDLEWARE ====================
const createCorsMiddleware = (options = {}) => {
 const {
  origin = '*',
  methods = 'GET, POST, PUT, DELETE, HEAD, OPTIONS, PATCH',
  allowedHeaders = 'Content-Type, Authorization, X-API-Key, X-CSRF-Token, X-Request-ID',
  exposedHeaders = 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-Response-Time',
  credentials = true,
  maxAge = 86400,
  preflightContinue = false
 } = options;

 const originWhitelist = Array.isArray(origin) ? new Set(origin) : null;
 const originRegex = origin instanceof RegExp ? origin : null;

 const resolveOrigin = (requestOrigin) => {
  if (origin === '*') return credentials ? requestOrigin || '*' : '*';
  if (typeof origin === 'string') return origin;
  if (originWhitelist && originWhitelist.has(requestOrigin)) return requestOrigin;
  if (originRegex && originRegex.test(requestOrigin)) return requestOrigin;
  if (typeof origin === 'function') return origin(requestOrigin) ? requestOrigin : null;
  return null;
 };

 return (request, response, next) => {
  const requestOrigin = request.headers.origin || '';
  const resolvedOrigin = resolveOrigin(requestOrigin);

  response.setHeader('vary', appendVaryHeader(
   String(response.getHeader('vary') || ''),
   'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
  ));

  if (!resolvedOrigin) return next();

  response.setHeader('access-control-allow-origin', resolvedOrigin);
  response.setHeader('access-control-allow-methods', methods);
  response.setHeader('access-control-allow-headers', allowedHeaders);
  response.setHeader('access-control-max-age', String(maxAge));
  if (exposedHeaders) response.setHeader('access-control-expose-headers', exposedHeaders);
  if (credentials) response.setHeader('access-control-allow-credentials', 'true');

  if (request.method === 'OPTIONS') {
   if (preflightContinue) return next();
   response.statusCode = 204;
   response.setHeader('content-length', '0');
   response.end();
   return;
  }

  next();
 };
};

const corsMiddleware = createCorsMiddleware();

// ==================== ERROR HANDLER MIDDLEWARE ====================
const errorHandlerMiddleware = (error, request, response, next) => {
 if (response.headersSent) { try { response.end(); } catch {} return; }

 const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev';
 const status = error?.status || error?.statusCode || 500;
 const requestId = getRequestId();

 if (error?.code === 'LIMIT_FILE_SIZE') return response.status(400).json({ error: 'File too large', code: 'LIMIT_FILE_SIZE', requestId });
 if (error?.type === 'entity.parse.failed') return response.status(400).json({ error: 'Invalid JSON', code: 'PARSE_ERROR', requestId });

 const body = {
  error: error?.isOperational ? (error.message || 'Error') : 'Internal server error',
  code: error?.code || 'INTERNAL_ERROR',
  requestId
 };

 if (isDev) {
  body.message = String(error?.message || error);
  body.stack = error?.stack?.split('\n').slice(0, 10);
  body.details = error?.details || null;
 }

 if (error?.suggestion) body.suggestion = error.suggestion;

 response.status(status).json(body);
};

// ==================== IDEMPOTENCY MIDDLEWARE ====================
const createIdempotencyMiddleware = (options = {}) => {
 const {
  headerName = 'idempotency-key',
  ttl = 86400000,
  methods = new Set(['POST', 'PUT', 'PATCH']),
  store = null
 } = options;

 const idempotencyCache = store || xdLRU({ max: 10000, ttl, updateAgeOnGet: false });

 return (request, response, next) => {
  const key = request.headers[headerName];
  if (!key || !methods.has(request.method)) return next();

  const cacheKey = `idem:${request.method}:${request.path}:${key}`;
  const cached = idempotencyCache.get(cacheKey);

  if (cached) {
   response.setHeader('x-idempotent-replayed', 'true');
   response.status(cached.status);
   for (const [h, v] of Object.entries(cached.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(h.toLowerCase())) response.setHeader(h, v);
   }
   response.end(cached.body);
   return;
  }

  const originalEnd = response.end;
  const chunks = [];

  response.write = function(chunk) {
   if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
   return true;
  };

  response.end = function(chunk, encoding, callback) {
   if (typeof chunk === 'function') { callback = chunk; chunk = null; }
   if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
   if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));

   const body = Buffer.concat(chunks);
   const headers = {};
   const headerNames = response.getHeaderNames ? response.getHeaderNames() : [];
   for (const h of headerNames) headers[h] = response.getHeader(h);

   idempotencyCache.set(cacheKey, { status: response.statusCode, headers, body }, { ttl });
   return originalEnd.call(response, body, callback);
  };

  next();
 };
};

// ==================== STATIC FILE SERVING ====================
const createStaticFileServer = (options = {}) => {
 const {
  root,
  maxAge = 0,
  mimeTypes = DEFAULT_MIME_TYPES,
  secureHeaders = true,
  dotFiles = 'ignore',
  index = 'index.html',
  statCacheTtl = 60000,
  statCacheMax = 2000
 } = options;

 // File stat cache for performance
 const statCache = xdLRU({ max: statCacheMax, ttl: statCacheTtl, updateAgeOnGet: true });

 const getStatCached = async (absolutePath) => {
  const cached = statCache.get(absolutePath);
  if (cached) return cached;
  try {
   const stats = await fs.stat(absolutePath);
   if (stats.isFile()) { statCache.set(absolutePath, stats); return stats; }
   return null;
  } catch { return null; }
 };

 const invalidateStatCache = (filePath) => {
  if (filePath) statCache.delete(filePath);
  else statCache.clear();
 };

 const serve = async (request, response, relativePath, method = 'GET') => {
  let requestPath = relativePath === '/' ? `/${index}` : relativePath;
  try { requestPath = decodeURIComponent(requestPath); } catch { return false; }

  // Prevent path traversal
  requestPath = path.posix.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');

  // Dot files check
  if (dotFiles === 'ignore' || dotFiles === 'deny') {
   const parts = requestPath.split('/');
   const hasDotFile = parts.some(p => p.startsWith('.') && p !== '.' && p !== '..');
   if (hasDotFile) {
    if (dotFiles === 'deny') { response.status(403).end('Forbidden'); return true; }
    return false;
   }
  }

  const absolutePath = path.resolve(root, '.' + requestPath);
  if (!absolutePath.startsWith(root + path.sep) && absolutePath !== root) return false;

  const stats = await getStatCached(absolutePath);
  if (!stats) return false;

  const extension = path.extname(absolutePath).slice(1).toLowerCase();
  const contentType = mimeTypes[extension] || 'application/octet-stream';
  const etag = generateEtag(stats);

  response.setHeader('etag', etag);
  response.setHeader('last-modified', stats.mtime.toUTCString());
  response.setHeader('accept-ranges', 'bytes');
  response.setHeader('cache-control', maxAge > 0
   ? `public, max-age=${maxAge}${maxAge > 86400 ? ', immutable' : ''}`
   : 'public, max-age=0, must-revalidate');
  response.setHeader('content-type', contentType);

  if (secureHeaders) response.setHeader('x-content-type-options', 'nosniff');

  // Conditional requests
  const ifNoneMatch = String(request.headers['if-none-match'] || '');
  const ifModifiedSince = request.headers['if-modified-since'] ? new Date(request.headers['if-modified-since']) : null;

  if ((ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === etag.replace(/^W\//, ''))) ||
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

  // Range request support
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
   readStream.on('error', (err) => {
    if (!response.headersSent) response.status(500).end('Internal Server Error');
    else try { response.end(); } catch {}
   });
   readStream.pipe(response);
   return true;
  }

  // Full file serving with backpressure
  response.setHeader('content-length', String(stats.size));
  const readStream = fsSync.createReadStream(absolutePath);
  readStream.on('error', (err) => {
   if (!response.headersSent) response.status(500).end('Internal Server Error');
   else try { response.end(); } catch {}
  });

  // Backpressure handling
  readStream.on('data', (chunk) => {
   const canContinue = response.write(chunk);
   if (!canContinue) {
    readStream.pause();
    response.once('drain', () => readStream.resume());
   }
  });
  readStream.on('end', () => response.end());

  return true;
 };

 return { serve, invalidateStatCache, getStats: () => statCache.stats() };
};

// ==================== BODY PARSING ====================
const parseMultipartData = async (buffer, boundary, parseOptions = {}) => {
 const { maxFileSize = 10 * 1024 * 1024, maxFiles = 10, maxFields = 100, maxFieldSize = 1024 * 1024 } = parseOptions;
 const result = { fields: {}, files: [] };
 const separator = Buffer.from('--' + boundary);
 const doubleCrlf = Buffer.from('\r\n\r\n');

 let position = buffer.indexOf(separator);
 if (position === -1) return result;
 position += separator.length;

 while (position < buffer.length) {
  if (buffer.slice(position, position + 2).equals(Buffer.from('--'))) break;
  if (buffer.slice(position, position + 2).equals(Buffer.from('\r\n'))) position += 2;
  const headerEnd = buffer.indexOf(doubleCrlf, position);
  if (headerEnd === -1) break;

  const headerString = buffer.slice(position, headerEnd).toString('utf8');
  const headers = {};
  headerString.split('\r\n').forEach((line) => {
   const colonIndex = line.indexOf(':');
   if (colonIndex > 0) headers[line.slice(0, colonIndex).trim().toLowerCase()] = line.slice(colonIndex + 1).trim();
  });

  const bodyStart = headerEnd + 4;
  const nextSeparator = buffer.indexOf(separator, bodyStart);
  const body = buffer.slice(bodyStart, nextSeparator === -1 ? buffer.length : nextSeparator - 2);
  const disposition = headers['content-disposition'] || '';
  const nameMatch = disposition.match(/\bname="([^"]+)"/);
  const filenameMatch = disposition.match(/\bfilename="([^"]+)"/);
  const name = nameMatch ? nameMatch[1] : '';
  const filename = filenameMatch ? filenameMatch[1] : null;

  if (filename) {
   if (result.files.length >= maxFiles) throw createErrorWithCode('Too many files', 'LIMIT_FILE_COUNT');
   if (body.length > maxFileSize) throw createErrorWithCode('File too large', 'LIMIT_FILE_SIZE');
   // Sanitize filename
   const safeName = path.basename(filename).replace(/[^\w.\-]/g, '_');
   result.files.push({ name, filename: safeName, originalFilename: filename, contentType: headers['content-type'] || 'application/octet-stream', data: body, size: body.length });
  } else if (name) {
   if (Object.keys(result.fields).length >= maxFields) throw createErrorWithCode('Too many fields', 'LIMIT_FIELD_COUNT');
   if (body.length > maxFieldSize) throw createErrorWithCode('Field too large', 'LIMIT_FIELD_SIZE');
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

  const cleanup = () => {
   request.removeListener('data', onData);
   request.removeListener('end', onEnd);
   request.removeListener('error', onError);
  };

  const onData = (chunk) => {
   if (exceededLimit) return;
   totalSize += chunk.length;
   if (totalSize > maxBodySize) {
    exceededLimit = true;
    cleanup();
    request.destroy(new Error('Payload Too Large'));
    resolve(null);
    return;
   }
   chunks.push(chunk);
  };

  const onEnd = async () => {
   cleanup();
   if (exceededLimit) return;
   try {
    const buffer = Buffer.concat(chunks);
    if (contentType.includes('json')) {
     const parsed = safeJsonParse(buffer.toString('utf8'));
     if (parsed === null && buffer.length > 0) {
      resolve(null);
     } else {
      resolve(parsed);
     }
    } else if (contentType.includes('x-www-form-urlencoded')) {
     resolve(parseUrlSearchParams(buffer.toString('utf8')));
    } else if (contentType.includes('multipart/form-data')) {
     const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
     if (!boundaryMatch) throw new Error('Invalid boundary');
     const boundary = boundaryMatch[1] || boundaryMatch[2];
     resolve(await parseMultipartData(buffer, boundary, parseOptions));
    } else {
     resolve(buffer);
    }
   } catch (error) {
    if (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_FIELD_COUNT' || error.code === 'LIMIT_FIELD_SIZE') {
     resolve(null);
    } else if (error instanceof SyntaxError) {
     resolve(null);
    } else {
     reject(error);
    }
   }
  };

  const onError = (error) => { cleanup(); reject(error); };

  request.on('data', onData);
  request.on('end', onEnd);
  request.on('error', onError);
 });

// ==================== SESSION MANAGEMENT ====================
const createSessionManager = (sessionSecret, sessionStore, options = {}) => {
 const { encrypt = false, ttl = 3600 } = options;
 const sessionLocks = new Map();

 const withSessionLock = async (sessionId, callback) => {
  const previousLock = sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const currentLock = new Promise(resolve => { release = resolve; });
  sessionLocks.set(sessionId, previousLock.then(() => currentLock));
  await previousLock;
  try { return await callback(); }
  finally {
   release();
   if (sessionLocks.get(sessionId) === previousLock.then(() => currentLock)) sessionLocks.delete(sessionId);
  }
 };

 const getSessionData = async (sessionId) => {
  if (!sessionId) return null;
  try {
   const rawData = sessionStore.get(`sess:${sessionId}`);
   if (!rawData) return null;
   if (encrypt) {
    const decrypted = decryptAES256GCM(rawData, sessionSecret);
    return decrypted ? JSON.parse(decrypted) : null;
   }
   return JSON.parse(rawData);
  } catch { return null; }
 };

 const setSessionData = async (sessionId, data) => {
  const serialized = safeJsonStringify(data);
  const value = encrypt ? encryptAES256GCM(serialized, sessionSecret) : serialized;
  sessionStore.set(`sess:${sessionId}`, value, { ttl: ttl * 1000 });
 };

 const destroySessionData = async (sessionId) => { sessionStore.del(`sess:${sessionId}`); };

 const getSessionId = async (request, secret) => {
  const sessionId = request.cookies.sid;
  if (sessionId?.includes('.')) {
   const [idPart, signaturePart] = sessionId.split('.', 2);
   if (verifySignature(idPart, signaturePart, secret)) return idPart;
  }
  return generateSessionId();
 };

 return { withSessionLock, getSessionData, setSessionData, destroySessionData, getSessionId };
};

// ==================== WEBSOCKET IMPLEMENTATION ====================
const createWebSocket = (socket, request, wsOptions = {}) => {
 const emitter = new EventEmitter();
 const {
  maxPayload = 16 * 1024 * 1024,
  pingInterval = 30000,
  pingTimeout = 10000,
  maxBufferSize = 64 * 1024 * 1024
 } = wsOptions;

 let readyState = WS_READY_STATES.OPEN;
 let fragmentBuffer = [];
 let fragmentTotalSize = 0;
 let fragmentOpcode = null;
 let pingTimer = null;
 let pongTimer = null;
 let closeCode = null;
 let closeReason = '';
 let bytesReceived = 0;
 let bytesSent = 0;
 let messagesSent = 0;
 let messagesReceived = 0;

 const websocket = {
  get readyState() { return readyState; },
  get CONNECTING() { return WS_READY_STATES.CONNECTING; },
  get OPEN() { return WS_READY_STATES.OPEN; },
  get CLOSING() { return WS_READY_STATES.CLOSING; },
  get CLOSED() { return WS_READY_STATES.CLOSED; },
  socket, request,

  get stats() {
   return { bytesReceived, bytesSent, messagesSent, messagesReceived, readyState };
  },

  on: (event, listener) => { emitter.on(event, listener); return websocket; },
  once: (event, listener) => { emitter.once(event, listener); return websocket; },
  off: (event, listener) => { emitter.off(event, listener); return websocket; },
  removeListener: (event, listener) => { emitter.removeListener(event, listener); return websocket; },

  send: (data, options = {}) => {
   if (readyState !== WS_READY_STATES.OPEN) return false;
   const isBinary = options.binary || Buffer.isBuffer(data);
   const opcode = isBinary ? WS_OPCODES.BINARY : WS_OPCODES.TEXT;
   const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');

   if (payload.length > maxPayload) {
    emitter.emit('error', new Error('Payload exceeds maxPayload'));
    return false;
   }

   const frame = createFrame(opcode, payload, true);
   try {
    const canContinue = socket.write(frame);
    bytesSent += frame.length;
    messagesSent++;
    // Backpressure
    if (!canContinue) socket.once('drain', () => emitter.emit('drain'));
    return true;
   } catch { return false; }
  },

  close: (code = 1000, reason = '') => {
   if (readyState === WS_READY_STATES.CLOSED || readyState === WS_READY_STATES.CLOSING) return;
   readyState = WS_READY_STATES.CLOSING;
   closeCode = code;
   closeReason = reason;
   const responsePayload = Buffer.alloc(2 + Buffer.byteLength(reason));
   if (reason) responsePayload.write(reason, 2, 'utf8');
   responsePayload.writeUInt16BE(code, 0);
   const frame = createFrame(WS_OPCODES.CLOSE, responsePayload, true);
   try { socket.write(frame); } catch {}
   setTimeout(() => { if (readyState !== WS_READY_STATES.CLOSED) terminateConnection(); }, 5000);
  },

  ping: (data = Buffer.alloc(0)) => {
   if (readyState !== WS_READY_STATES.OPEN) return false;
   const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
   try { socket.write(createFrame(WS_OPCODES.PING, payload, true)); return true; }
   catch { return false; }
  },

  pong: (data = Buffer.alloc(0)) => {
   if (readyState !== WS_READY_STATES.OPEN) return false;
   const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
   try { socket.write(createFrame(WS_OPCODES.PONG, payload, true)); return true; }
   catch { return false; }
  },

  terminate: () => terminateConnection()
 };

 const createFrame = (opcode, payload, fin = true) => {
  const length = payload.length;
  let headerLength = 2;
  let extendedLengthBytes = 0;
  if (length > 65535) { headerLength += 8; extendedLengthBytes = 8; }
  else if (length > 125) { headerLength += 2; extendedLengthBytes = 2; }
  const frame = Buffer.alloc(headerLength + length);
  frame[0] = (fin ? 0x80 : 0x00) | opcode;
  if (extendedLengthBytes === 0) frame[1] = length;
  else if (extendedLengthBytes === 2) { frame[1] = 126; frame.writeUInt16BE(length, 2); }
  else { frame[1] = 127; frame.writeBigUInt64BE(BigInt(length), 2); }
  payload.copy(frame, headerLength);
  return frame;
 };

 const unmaskPayload = (data, mask) => {
  const result = Buffer.allocUnsafe(data.length);
  // Optimize 4-byte XOR
  const mask32 = mask.readUInt32BE(0);
  let i = 0;
  const len32 = data.length - 3;
  for (; i < len32; i += 4) {
   result.writeUInt32BE(data.readUInt32BE(i) ^ mask32, i);
  }
  for (; i < data.length; i++) {
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

   if (rsv1 || rsv2 || rsv3) { closeWithError(1002, 'RSV bits must be 0'); return; }
   if (!masked) { closeWithError(1002, 'Client frames must be masked'); return; }

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
    const highBits = receiveBuffer.readUInt32BE(offset);
    const lowBits = receiveBuffer.readUInt32BE(offset + 4);
    if (highBits > 0 || lowBits > maxPayload) { closeWithError(1009, 'Payload too large'); return; }
    payloadLength = lowBits;
    offset += 8;
   }

   if (payloadLength > maxPayload) { closeWithError(1009, 'Payload too large'); return; }

   const totalLength = headerLength + payloadLength;
   if (receiveBuffer.length < totalLength) return;

   const mask = receiveBuffer.slice(offset, offset + 4);
   offset += 4;
   const maskedPayload = receiveBuffer.slice(offset, offset + payloadLength);
   const payload = unmaskPayload(maskedPayload, mask);
   bytesReceived += totalLength;

   receiveBuffer = receiveBuffer.slice(totalLength);
   handleFrame(fin, opcode, payload);
  }
 };

 const handleFrame = (fin, opcode, payload) => {
  if (opcode >= 0x8) { handleControlFrame(opcode, payload); return; }

  if (opcode === WS_OPCODES.CONTINUATION) {
   if (fragmentOpcode === null) { closeWithError(1002, 'Unexpected continuation frame'); return; }
   fragmentTotalSize += payload.length;
   if (fragmentTotalSize > maxPayload) { closeWithError(1009, 'Fragmented message too large'); return; }
   fragmentBuffer.push(payload);
   if (fin) {
    const fullPayload = Buffer.concat(fragmentBuffer);
    deliverMessage(fragmentOpcode, fullPayload);
    fragmentBuffer = [];
    fragmentTotalSize = 0;
    fragmentOpcode = null;
   }
  } else {
   if (fragmentOpcode !== null) { closeWithError(1002, 'Expected continuation frame'); return; }
   if (fin) { deliverMessage(opcode, payload); }
   else { fragmentOpcode = opcode; fragmentBuffer = [payload]; fragmentTotalSize = payload.length; }
  }
 };

 const handleControlFrame = (opcode, payload) => {
  if (opcode === WS_OPCODES.CLOSE) {
   let code = 1005;
   let reason = '';
   if (payload.length >= 2) { code = payload.readUInt16BE(0); reason = payload.slice(2).toString('utf8'); }
   if (readyState === WS_READY_STATES.OPEN) {
    readyState = WS_READY_STATES.CLOSING;
    const responsePayload = Buffer.alloc(2);
    responsePayload.writeUInt16BE(code, 0);
    try { socket.write(createFrame(WS_OPCODES.CLOSE, responsePayload, true)); } catch {}
   }
   closeCode = code;
   closeReason = reason;
   terminateConnection();
  } else if (opcode === WS_OPCODES.PING) {
   if (readyState === WS_READY_STATES.OPEN) {
    try { socket.write(createFrame(WS_OPCODES.PONG, payload, true)); } catch {}
   }
   emitter.emit('ping', payload);
  } else if (opcode === WS_OPCODES.PONG) {
   clearTimeout(pongTimer);
   pongTimer = null;
   emitter.emit('pong', payload);
  }
 };

 const deliverMessage = (opcode, payload) => {
  messagesReceived++;
  if (opcode === WS_OPCODES.TEXT) {
   try {
    const text = payload.toString('utf8');
    emitter.emit('message', text, false);
   } catch { closeWithError(1007, 'Invalid UTF-8'); }
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
  receiveBuffer = Buffer.alloc(0);
  fragmentBuffer = [];
  fragmentTotalSize = 0;
  fragmentOpcode = null;
  try { socket.end(); } catch {}
  try { socket.destroy(); } catch {}
  emitter.emit('close', closeCode || 1006, closeReason || '');
  emitter.removeAllListeners();
 };

 const startHeartbeat = () => {
  if (pingInterval <= 0) return;
  pingTimer = setInterval(() => {
   if (readyState !== WS_READY_STATES.OPEN) return;
   websocket.ping();
   pongTimer = setTimeout(() => {
    if (readyState === WS_READY_STATES.OPEN) closeWithError(1006, 'Pong timeout');
   }, pingTimeout);
  }, pingInterval);
  if (pingTimer.unref) pingTimer.unref();
 };

 socket.on('data', (chunk) => {
  receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
  // Buffer overflow protection
  if (receiveBuffer.length > maxBufferSize) {
   closeWithError(1009, 'Receive buffer overflow');
   return;
  }
  parseFrames();
 });

 socket.on('close', terminateConnection);
 socket.on('error', (error) => { emitter.emit('error', error); terminateConnection(); });
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
  if (route.pattern === pathname) { matchedRoute = route; params = {}; break; }
  if (route.regex) {
   const match = pathname.match(route.regex);
   if (match) { matchedRoute = route; params = match.groups || {}; break; }
  }
 }

 if (!matchedRoute) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }

 const key = request.headers['sec-websocket-key'];
 const version = request.headers['sec-websocket-version'];

 if (!key || version !== '13') { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }

 const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

 const responseHeaders = [
  'HTTP/1.1 101 Switching Protocols',
  'Upgrade: websocket',
  'Connection: Upgrade',
  `Sec-WebSocket-Accept: ${acceptKey}`
 ];

 const protocol = request.headers['sec-websocket-protocol'];
 if (protocol && wsOptions.protocols) {
  const requestedProtocols = protocol.split(',').map(p => p.trim());
  const supportedProtocols = Array.isArray(wsOptions.protocols) ? wsOptions.protocols : [wsOptions.protocols];
  const selectedProtocol = supportedProtocols.find(p => requestedProtocols.includes(p));
  if (selectedProtocol) responseHeaders.push(`Sec-WebSocket-Protocol: ${selectedProtocol}`);
 }

 socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

 const ws = createWebSocket(socket, request, wsOptions);
 ws.path = pathname;
 ws.query = parseUrlSearchParams(url.search);
 ws.params = params;
 ws.cookies = xdCookie.parse(request.headers.cookie || '');

 if (head && head.length > 0) socket.unshift(head);

 matchedRoute.handler(ws, request);
};

const xdWebSocket = {
 createSocket: createWebSocket,
 handleUpgrade: handleWebSocketUpgrade
};

// ==================== HEALTH CHECK ====================
const createHealthCheck = (options = {}) => {
 const {
  path: healthPath = '/health',
  checks = {},
  includeDetails = false
 } = options;

 const runChecks = async () => {
  const results = {};
  let healthy = true;

  for (const [name, check] of Object.entries(checks)) {
   try {
    const start = Date.now();
    const result = await check();
    results[name] = { status: 'ok', duration: Date.now() - start, ...(includeDetails && result ? { details: result } : {}) };
   } catch (err) {
    healthy = false;
    results[name] = { status: 'error', error: err.message, duration: 0 };
   }
  }

  return {
   status: healthy ? 'ok' : 'degraded',
   timestamp: new Date().toISOString(),
   uptime: process.uptime(),
   memory: process.memoryUsage(),
   checks: results
  };
 };

 return {
  path: healthPath,
  handler: async (request, response) => {
   const result = await runChecks();
   response.status(result.status === 'ok' ? 200 : 503).json(result);
  },
  runChecks,
  addCheck: (name, fn) => { checks[name] = fn; },
  removeCheck: (name) => { delete checks[name]; }
 };
};

// ==================== GRACEFUL SHUTDOWN ====================
const createGracefulShutdown = (server, options = {}) => {
 const {
  timeout = 30000,
  logger = defaultLogger,
  onShutdown = null,
  signals = ['SIGTERM', 'SIGINT']
 } = options;

 let shuttingDown = false;
 const connections = new Set();

 // Track connections
 server.on('connection', (conn) => {
  connections.add(conn);
  conn.on('close', () => connections.delete(conn));
 });

 const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Graceful shutdown initiated (${signal})`, { activeConnections: connections.size });

  // Stop accepting new connections
  server.close(() => { logger.info('Server closed, no more connections accepted'); });

  // Custom shutdown logic
  if (onShutdown) {
   try { await onShutdown(signal); }
   catch (err) { logger.error('Error during onShutdown callback', { error: err.message }); }
  }

  // Give existing connections time to finish
  const forceShutdownTimer = setTimeout(() => {
   logger.warn('Force shutdown - destroying remaining connections', { remaining: connections.size });
   for (const conn of connections) { try { conn.destroy(); } catch {} }
   process.exit(1);
  }, timeout);
  if (forceShutdownTimer.unref) forceShutdownTimer.unref();

  // Close idle connections
  for (const conn of connections) {
   if (!conn.destroyed) {
    conn.end();
    // Force destroy after half timeout
    setTimeout(() => { if (!conn.destroyed) conn.destroy(); }, timeout / 2).unref?.();
   }
  }

  // Wait for all connections to close
  const waitForClose = () => {
   if (connections.size === 0) {
    clearTimeout(forceShutdownTimer);
    logger.info('All connections closed, exiting');
    process.exit(0);
   } else {
    setTimeout(waitForClose, 100).unref?.();
   }
  };
  waitForClose();
 };

 // Register signal handlers
 for (const signal of signals) {
  process.on(signal, () => shutdown(signal));
 }

 // Uncaught exception handler
 process.on('uncaughtException', (err) => {
  logger.fatal('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
 });

 process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
 });

 return {
  shutdown,
  get isShuttingDown() { return shuttingDown; },
  get activeConnections() { return connections.size; },
  middleware: (request, response, next) => {
   if (shuttingDown) {
    response.setHeader('connection', 'close');
    return response.status(503).json({ error: 'Server is shutting down', code: 'SHUTTING_DOWN' });
   }
   next();
  }
 };
};

// ==================== REQUEST TIMEOUT ====================
const createRequestTimeout = (timeoutMs = 30000) => {
 return (request, response, next) => {
  const timer = setTimeout(() => {
   if (!response.headersSent) {
    response.status(408).json({ error: 'Request timeout', code: 'REQUEST_TIMEOUT', requestId: getRequestId() });
   }
  }, timeoutMs);
  if (timer.unref) timer.unref();

  response.on('finish', () => clearTimeout(timer));
  response.on('close', () => clearTimeout(timer));
  next();
 };
};

// ==================== CREATE SERVER APP ====================
const createServerApp = (options = {}) => {
 const routes = {
  GET: [], POST: [], PUT: [], DELETE: [], HEAD: [], PATCH: [], OPTIONS: []
 };

 const wsRoutes = [];
 const middlewares = [];
 const staticRoot = path.resolve(options.static || './public');
 const maxBodySize = options.maxBody || 1048576;
 const spaMode = options.spa !== false;
 const enableLogs = options.logs !== false;
 const sessionSecret = String(options.sessionSecret || crypto.randomBytes(32).toString('hex'));
 const trustProxy = options.trustProxy === true;
 const staticMaxAge = Number.isFinite(options.staticMaxAge) ? Math.max(0, options.staticMaxAge) : 0;
 const secureHeaders = options.secureHeaders !== false;
 const sessionStore = options.sessionStore || xdRedis({ max: 1000 });
 const mimeTypes = { ...DEFAULT_MIME_TYPES, ...(options.mimeTypes || {}) };
 const sessionOptions = { encrypt: options.sessionEncrypt === true, ttl: options.sessionTtl || 3600 };
 const requestTimeoutMs = options.requestTimeout || 0;

 const wsOptions = {
  maxPayload: options.wsMaxPayload || 16 * 1024 * 1024,
  pingInterval: options.wsPingInterval || 30000,
  pingTimeout: options.wsPingTimeout || 10000,
  protocols: options.wsProtocols || null,
  maxBufferSize: options.wsMaxBufferSize || 64 * 1024 * 1024
 };

 const wsClients = new Set();
 const sessionManager = createSessionManager(sessionSecret, sessionStore, sessionOptions);

 const logger = options.logger || (enableLogs ? createLogger({ format: options.logFormat || 'text', level: options.logLevel || 'INFO' }) : createLogger({ level: 'SILENT' }));

 const eventBus = options.eventBus || createEventBus();

 // Security headers
 const securityHeadersConfig = secureHeaders ? createSecurityHeaders(options.securityHeaders || {}) : null;

 // Static file server with stat caching
 const staticServer = createStaticFileServer({
  root: staticRoot, maxAge: staticMaxAge, mimeTypes, secureHeaders,
  dotFiles: options.dotFiles || 'ignore',
  index: options.index || 'index.html',
  statCacheTtl: options.statCacheTtl || 60000,
  statCacheMax: options.statCacheMax || 2000
 });

 // Health check
 const healthCheck = options.healthCheck !== false ? createHealthCheck(options.healthCheck || {}) : null;

 const useMiddleware = (pathPattern, middleware) => {
  if (typeof pathPattern === 'function') { middleware = pathPattern; pathPattern = '*'; }
  middlewares.push({ path: pathPattern, middleware });
 };

 const addRoute = (method, pattern, ...handlers) => {
  const regex = createRegexPattern(pattern);
  if (handlers.length === 1) {
   routes[method].push({ pattern, regex, handler: handlers[0], middlewares: [] });
  } else {
   const handler = handlers.pop();
   routes[method].push({ pattern, regex, handler, middlewares: handlers });
  }
 };

 const addWsRoute = (pattern, handler) => {
  const regex = createRegexPattern(pattern);
  wsRoutes.push({ pattern, regex, handler });
 };

 const matchRoute = (method, pathname) => {
  const methodRoutes = routes[method];
  if (!methodRoutes) return null;
  for (const route of methodRoutes) {
   if (route.pattern === pathname) return { handler: route.handler, params: {}, middlewares: route.middlewares };
   if (route.regex) {
    const match = pathname.match(route.regex);
    if (match) return { handler: route.handler, params: match.groups || {}, middlewares: route.middlewares };
   }
  }
  return null;
 };

 const executeMiddlewares = async (request, response, middlewareList, index = 0) => {
  if (index >= middlewareList.length || response.writableEnded) return true;
  let hasCalledNext = false;
  const next = (error) => {
   if (hasCalledNext) return;
   hasCalledNext = true;
   if (error) throw error;
   return executeMiddlewares(request, response, middlewareList, index + 1);
  };
  try {
   const mw = middlewareList[index];
   // Error middleware detection (4 args)
   const result = mw(request, response, next);
   if (result?.then) {
    await result;
    if (!hasCalledNext && !response.writableEnded) await next();
   }
  } catch (error) { throw error; }
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
  request.protocol = request.secure ? 'https' : 'http';
  request.originalUrl = request.url;

  response.status = (code) => { response.statusCode = code; return response; };
  response.set = (key, value) => { response.setHeader(key, value); return response; };
  response.get = (key) => response.getHeader(key);
  response.vary = (value) => {
   response.setHeader('vary', appendVaryHeader(String(response.getHeader('vary') || ''), value));
   return response;
  };
  response.type = (type) => response.set('content-type', type);

  response.json = (data) => {
   const body = safeJsonStringify(data);
   response.type(mimeTypes.json);
   response.setHeader('content-length', String(Buffer.byteLength(body)));
   response.end(body);
  };

  response.html = (html) => {
   response.type(mimeTypes.html);
   response.setHeader('content-length', String(Buffer.byteLength(html)));
   response.end(html);
  };

  response.send = (data) => {
   if (data === null || data === undefined) return response.end();
   if (Buffer.isBuffer(data)) {
    if (!response.getHeader('content-type')) response.type('application/octet-stream');
    response.setHeader('content-length', String(data.length));
    return response.end(data);
   }
   if (typeof data === 'object') return response.json(data);
   const str = String(data);
   if (!response.getHeader('content-type')) response.type(mimeTypes.html);
   response.setHeader('content-length', String(Buffer.byteLength(str)));
   return response.end(str);
  };

  response.redirect = (code, urlString) => {
   if (typeof code === 'string') { urlString = code; code = 302; }
   response.status(code).set('location', sanitizeRedirectUrl(urlString)).end();
  };

  response.download = (filePath, filename) => {
   const name = filename || path.basename(filePath);
   response.set('content-disposition', `attachment; filename="${name.replace(/"/g, '\\"')}"`);
   const stream = fsSync.createReadStream(filePath);
   stream.on('error', (err) => {
    if (!response.headersSent) response.status(404).json({ error: 'File not found' });
   });
   stream.pipe(response);
  };

  response.safeHtml = (html) => response.html(safeText(html));
  response.safeJson = (data) => response.json(data);

  response.cookie = (name, value, opts) => { xdCookie.set(response, name, value, opts); return response; };
  response.clearCookie = (name, opts) => { xdCookie.clear(response, name, opts); return response; };

  // Apply security headers
  if (securityHeadersConfig) securityHeadersConfig.apply(response);
 };

 const initSession = async (request, response) => {
  try {
   const sessionId = await sessionManager.getSessionId(request, sessionSecret);
   const sessionData = await sessionManager.getSessionData(sessionId);
   request.session = sessionData || {};
   request.currentSessionId = sessionId;

   request.saveSession = () => sessionManager.withSessionLock(sessionId, async () => {
    await sessionManager.setSessionData(sessionId, request.session);
    xdCookie.set(response, 'sid', `${sessionId}.${signData(sessionId, sessionSecret)}`, {
     httpOnly: true, secure: request.secure, maxAge: sessionOptions.ttl, path: '/', sameSite: 'Lax'
    });
   });

   request.destroySession = () => sessionManager.withSessionLock(sessionId, async () => {
    await sessionManager.destroySessionData(sessionId);
    request.session = {};
    xdCookie.clear(response, 'sid', { path: '/' });
   });

   request.regenerateSession = async () => {
    await sessionManager.destroySessionData(sessionId);
    const newSessionId = generateSessionId();
    request.currentSessionId = newSessionId;
    request.session = {};
    request.saveSession = () => sessionManager.withSessionLock(newSessionId, async () => {
     await sessionManager.setSessionData(newSessionId, request.session);
     xdCookie.set(response, 'sid', `${newSessionId}.${signData(newSessionId, sessionSecret)}`, {
      httpOnly: true, secure: request.secure, maxAge: sessionOptions.ttl, path: '/', sameSite: 'Lax'
     });
    });
   };
  } catch (error) {
   logger.error('Session initialization error', { error: error.message });
   request.session = {};
   request.currentSessionId = null;
  }
 };

 const requestHandler = async (request, response) => {
  const requestId = request.headers['x-request-id'] || generateRequestId();
  const startTime = process.hrtime.bigint();

  // AsyncLocalStorage context
  requestContext.run({ requestId, startTime, method: request.method, url: request.url }, async () => {
   response.setHeader('x-request-id', requestId);

   setupRequestResponse(request, response);
   await initSession(request, response);

   response.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e6;
    try { if (!response.headersSent) response.setHeader('x-response-time', duration.toFixed(2) + 'ms'); } catch {}
    logger.info(`${request.method} ${request.path} ${response.statusCode} ${duration.toFixed(1)}ms`, {
     method: request.method, path: request.path, status: response.statusCode,
     duration: parseFloat(duration.toFixed(2)), ip: request.ip, requestId
    });
    eventBus.publish('request:complete', {
     method: request.method, path: request.path, status: response.statusCode, duration, requestId
    });
   });

   // Health check
   if (healthCheck && request.path === healthCheck.path && request.method === 'GET') {
    return healthCheck.handler(request, response);
   }

   try {
    const globalMiddlewares = middlewares
     .filter(m => m.path === '*' || request.path.startsWith(m.path))
     .map(m => m.middleware);
    await executeMiddlewares(request, response, globalMiddlewares);
    if (response.headersSent || response.writableEnded) return;
   } catch (error) {
    return errorHandlerMiddleware(error, request, response, () => {});
   }

   // HEAD requests
   if (request.method === 'HEAD') {
    const routeMatch = matchRoute('GET', request.path);
    if (routeMatch) {
     request.params = routeMatch.params;
     const originalWrite = response.write;
     const originalEnd = response.end;
     response.write = () => true;
     response.end = function() { try { return originalEnd.call(response); } catch { return undefined; } };
     try {
      if (routeMatch.middlewares.length) await executeMiddlewares(request, response, routeMatch.middlewares);
      if (!response.writableEnded) await routeMatch.handler(request, response);
     } catch (error) { errorHandlerMiddleware(error, request, response, () => {}); }
     response.write = originalWrite;
     response.end = originalEnd;
     return;
    }
    if (await staticServer.serve(request, response, request.path, 'HEAD')) return;
    if (spaMode && await staticServer.serve(request, response, '/index.html', 'HEAD')) return;
    response.status(404).end();
    return;
   }

   // Route matching
   const routeMatch = matchRoute(request.method, request.path);
   if (routeMatch) {
    request.params = routeMatch.params;
    try {
     // Execute route-specific middlewares first
     if (routeMatch.middlewares.length) {
      await executeMiddlewares(request, response, routeMatch.middlewares);
      if (response.headersSent || response.writableEnded) return;
     }

     if (request.method === 'GET' || request.method === 'DELETE' || request.method === 'HEAD') {
      await routeMatch.handler(request, response);
     } else {
      const bodyResult = await parseRequestBody(request, maxBodySize, options.parseOptions || {});
      if (bodyResult === null && request.headers['content-length'] && parseInt(request.headers['content-length'], 10) > 0) {
       return response.status(413).json({ error: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE' });
      }
      request.body = bodyResult;
      await routeMatch.handler(request, response);
     }
    } catch (error) {
     errorHandlerMiddleware(error, request, response, () => {});
    }
    return;
   }

   // Static file serving
   if (await staticServer.serve(request, response, request.path)) return;
   if (spaMode && await staticServer.serve(request, response, '/index.html')) return;

   response.status(404).json({ error: 'Not Found', code: 'NOT_FOUND', path: request.path, requestId });
  });
 };

 const server = options.https
  ? httpsCreateServer(options.tls || {}, requestHandler)
  : httpCreateServer(requestHandler);

 server.on('upgrade', (request, socket, head) => {
  const upgradeHeader = String(request.headers.upgrade || '').toLowerCase();
  if (upgradeHeader !== 'websocket') { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  try { xdWebSocket.handleUpgrade(request, socket, head, wsRoutes, wsOptions); }
  catch (error) {
   logger.error('WebSocket upgrade error', { error: error.message });
   socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
   socket.destroy();
  }
 });

 // Graceful shutdown
 const gracefulShutdown = options.gracefulShutdown !== false
  ? createGracefulShutdown(server, {
   timeout: options.shutdownTimeout || 30000,
   logger,
   onShutdown: async () => {
    // Close all WebSocket connections
    for (const client of wsClients) {
     try { client.close(1001, 'Server shutting down'); } catch {}
    }
    eventBus.publish('server:shutdown', { timestamp: Date.now() });
   }
  })
  : null;

 const app = {
  get: (pattern, ...handlers) => { addRoute('GET', pattern, ...handlers); return app; },
  post: (pattern, ...handlers) => { addRoute('POST', pattern, ...handlers); return app; },
  put: (pattern, ...handlers) => { addRoute('PUT', pattern, ...handlers); return app; },
  delete: (pattern, ...handlers) => { addRoute('DELETE', pattern, ...handlers); return app; },
  patch: (pattern, ...handlers) => { addRoute('PATCH', pattern, ...handlers); return app; },
  options: (pattern, ...handlers) => { addRoute('OPTIONS', pattern, ...handlers); return app; },
  all: (pattern, ...handlers) => {
   for (const method of Object.keys(routes)) addRoute(method, pattern, ...handlers);
   return app;
  },
  use: (pathPattern, middleware) => { useMiddleware(pathPattern, middleware); return app; },

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
   const excludeSet = options.exclude ? new Set(Array.isArray(options.exclude) ? options.exclude : [options.exclude]) : new Set();
   let sent = 0;
   for (const client of wsClients) {
    if (client.readyState === WS_READY_STATES.OPEN && !excludeSet.has(client) && filterFn(client)) {
     try { client.send(data, options); sent++; } catch (error) { logger.error('Broadcast error', { error: error.message }); }
    }
   }
   return sent;
  },

  listen: (port, callback) => {
   server.listen(port, () => {
    logger.info(`Server started: http${options.https ? 's' : ''}://localhost:${port}`, { port, https: !!options.https, pid: process.pid });
    eventBus.publish('server:start', { port, pid: process.pid });
    if (callback) callback();
   });
   return app;
  },

  close: (callback) => {
   if (gracefulShutdown) gracefulShutdown.shutdown('manual');
   else server.close(callback);
   return app;
  },

  server,
  logger,
  eventBus,
  sessionStore,
  healthCheck,
  gracefulShutdown,

  // Utility accessors
  getRoutes: () => {
   const result = {};
   for (const [method, methodRoutes] of Object.entries(routes)) {
    result[method] = methodRoutes.map(r => r.pattern);
   }
   return result;
  },

  invalidateStatCache: (filePath) => staticServer.invalidateStatCache(filePath),
  getStatCacheStats: () => staticServer.getStats()
 };

 // Apply built-in middleware
 if (gracefulShutdown) app.use(gracefulShutdown.middleware);
 if (options.rateLimit !== false) app.use(typeof options.rateLimit === 'object' ? createRateLimiter(options.rateLimit) : rateLimiterMiddleware);
 if (options.cors !== false) app.use(typeof options.cors === 'object' ? createCorsMiddleware(options.cors) : corsMiddleware);
 if (options.compression) app.use(createCompressionMiddleware(typeof options.compression === 'object' ? options.compression : {}));
 if (requestTimeoutMs > 0) app.use(createRequestTimeout(requestTimeoutMs));

 return app;
};

const xdSrv = { createApp: createServerApp };

// ==================== EXPORTS ====================
export {
 xdRedis,
 xdLRU,
 xdCookie,
 xdValidate,
 xdEventBus,
 xdWebSocket,
 xdSrv,
 escapeAny,
 safeText,
 safeAttr,
 safeUrlAttr,
 safeJsonStringify,
 safeJsonParse,
 createLogger,
 createAppError,
 createSecurityHeaders,
 createCsrfProtection,
 createCompressionMiddleware,
 createRateLimiter,
 createCorsMiddleware,
 createIdempotencyMiddleware,
 createHealthCheck,
 createGracefulShutdown,
 createRequestTimeout,
 createStaticFileServer,
 encryptAES256GCM,
 decryptAES256GCM,
 signData,
 verifySignature,
 generateRequestId,
 generateSessionId,
 generateContentEtag,
 errorHandlerMiddleware as errorHandler,
 corsMiddleware as cors,
 rateLimiterMiddleware,
 ERROR_CODES,
 LOG_LEVELS,
 REQUEST_METHODS,
 WS_READY_STATES,
 WS_OPCODES,
 DEFAULT_MIME_TYPES,
 requestContext,
 getRequestContext,
 getRequestId
};

export default xdSrv;