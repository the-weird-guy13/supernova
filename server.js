'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');

// -- CONFIG -- //
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const MAX_TEXT_BYTES = 25 * 1024 * 1024;   // biggest HTML/CSS file we will rewrite
const UPSTREAM_TIMEOUT = 30000;            // ms to wait for a site

const ROOT = __dirname;
const PROXY_PREFIX = '/proxy/';
const ASSET_PREFIX = '/__taco/';
const TOOLBAR_TAG = '<script src="' + ASSET_PREFIX + 'js/toolbar.js"></script>';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const PAGES = new Set(['index.html', 'settings.html', 'newtab.html']);
const DIRS = new Set(['images', 'js', 'styles', 'config']);
const SHELL_ROUTES = new Set(['/', '/index.html', '/settings.html', '/newtab.html']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function resolveStatic(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (rel.includes('\\') || rel.includes('\0')) return null;

  rel = path.posix.normalize('/' + rel).slice(1);
  if (rel === '') rel = 'index.html';

  const parts = rel.split('/');
  const allowed =
    (parts.length === 1 && PAGES.has(rel)) ||
    (parts.length > 1 && DIRS.has(parts[0]) && parts.every((p) => p && !p.startsWith('.')));
  if (!allowed) return null;

  const full = path.join(ROOT, ...parts);
  return full.startsWith(ROOT + path.sep) ? full : null;
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendError(res, 404, 'Not found', 'That file does not exist.');
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function sendError(res, status, title, message) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) return res.destroy();
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>' +
    '<style>body{background:#000;color:#fff;font-family:"IBM Plex Sans","Segoe UI",sans-serif;text-align:center;padding-top:18vh}' +
    'h1{color:blueviolet}a{color:#a855f7}</style>' + TOOLBAR_TAG + '</head><body>' +
    '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(message) + '</p>' +
    '<p><a href="/">Back to Taco Proxy</a></p></body></html>';
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (l.startsWith('::ffff:')) return true;
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options = options || {};

  dns.lookup(hostname, Object.assign({}, options, { all: true }), (err, addresses) => {
    if (err) return callback(err);
    const ok = ALLOW_PRIVATE ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
    if (!ok.length) {
      const e = new Error('Taco Proxy will not connect to private or local addresses.');
      e.code = 'EBLOCKED';
      return callback(e);
    }
    if (options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

function friendlyError(err) {
  if (err.code === 'EBLOCKED') return err.message;
  if (err.code === 'ENOTFOUND') return 'Could not find that website. Check the address.';
  if (err.code === 'ECONNREFUSED') return 'The website refused the connection.';
  if (err.code === 'ECONNRESET') return 'The connection was reset.';
  return err.message || 'Something went wrong.';
}

const sessions = new Map();

function parseCookieHeader(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function getSession(req, res) {
  const sid = parseCookieHeader(req.headers.cookie).taco_sid;
  if (sid && sessions.has(sid)) return sessions.get(sid);

  const id = crypto.randomBytes(16).toString('hex');
  const session = { jar: [] };
  sessions.set(id, session);
  if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
  res.setHeader('Set-Cookie', 'taco_sid=' + id + '; Path=/; HttpOnly; SameSite=Lax');
  return session;
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function pathMatches(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/');
}

function defaultCookiePath(p) {
  if (!p || p[0] !== '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function storeCookies(session, target, setCookieHeaders) {
  if (!setCookieHeaders) return;
  for (const line of setCookieHeaders) {
    const parts = line.split(';');
    const eq = parts[0].indexOf('=');
    if (eq < 1) continue;

    const cookie = {
      name: parts[0].slice(0, eq).trim(),
      value: parts[0].slice(eq + 1).trim(),
      domain: target.hostname,
      hostOnly: true,
      path: defaultCookiePath(target.pathname),
      secure: false,
      expires: 0,
    };
    let maxAge = null;
    let expiresAttr = null;

    for (const attr of parts.slice(1)) {
      const i = attr.indexOf('=');
      const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const val = i === -1 ? '' : attr.slice(i + 1).trim();
      if (key === 'domain' && val) {
        const d = val.replace(/^\./, '').toLowerCase();
        if (domainMatches(target.hostname, d)) { cookie.domain = d; cookie.hostOnly = false; }
      } else if (key === 'path' && val[0] === '/') {
        cookie.path = val;
      } else if (key === 'secure') {
        cookie.secure = true;
      } else if (key === 'max-age') {
        const n = parseInt(val, 10);
        if (!isNaN(n)) maxAge = n;
      } else if (key === 'expires') {
        const t = Date.parse(val);
        if (!isNaN(t)) expiresAttr = t;
      }
    }
    if (maxAge !== null) cookie.expires = maxAge <= 0 ? 1 : Date.now() + maxAge * 1000;
    else if (expiresAttr !== null) cookie.expires = expiresAttr;

    session.jar = session.jar.filter(
      (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path)
    );
    if (cookie.expires && cookie.expires <= Date.now()) continue;
    session.jar.push(cookie);
  }
  if (session.jar.length > 300) session.jar.splice(0, session.jar.length - 300);
}

function cookiesFor(session, target) {
  const now = Date.now();
  session.jar = session.jar.filter((c) => !c.expires || c.expires > now);
  return session.jar
    .filter((c) =>
      (c.hostOnly ? target.hostname === c.domain : domainMatches(target.hostname, c.domain)) &&
      pathMatches(target.pathname, c.path) &&
      (!c.secure || target.protocol === 'https:'))
    .sort((a, b) => b.path.length - a.path.length)
    .map((c) => c.name + '=' + c.value)
    .join('; ');
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'background']);

const TOKEN = /<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script\s*>|<style\b([^>]*)>([\s\S]*?)<\/style\s*>|<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const ATTR = /([^\s"'<>\/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&';
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'quot') return '"';
    if (l === 'apos') return "'";
    const code = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try { return String.fromCodePoint(code); } catch (err) { return m; }
  });
}

function encodeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function toProxyUrl(value, base) {
  const v = String(value).trim();
  if (!v || v[0] === '#') return null;
  if (/^(javascript|data|blob|mailto|tel|sms|about|file|ws|wss):/i.test(v)) return null;
  let abs;
  try { abs = new URL(v, base); } catch (e) { return null; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  return PROXY_PREFIX + abs.href;
}

function rewriteSrcset(value, base) {
  if (/data:/i.test(value)) return value;
  return value.split(',').map((part) => {
    const m = /^(\s*)(\S+)([\s\S]*)$/.exec(part);
    if (!m) return part;
    return m[1] + (toProxyUrl(m[2], base) || m[2]) + m[3];
  }).join(',');
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi, (m, dq, sq, uq) => {
      const raw = dq !== undefined ? dq : sq !== undefined ? sq : uq;
      const p = toProxyUrl(raw, base);
      return p ? 'url("' + p + '")' : m;
    })
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (m, dq, sq) => {
      const p = toProxyUrl(dq !== undefined ? dq : sq, base);
      return p ? '@import "' + p + '"' : m;
    });
}

function getAttr(attrStr, wanted) {
  let found = null;
  attrStr.replace(ATTR, (m, name, eq, dq, sq, uq) => {
    if (found === null && name.toLowerCase() === wanted) {
      found = dq !== undefined ? dq : sq !== undefined ? sq : uq !== undefined ? uq : '';
    }
    return m;
  });
  return found;
}

function rewriteAttrs(tag, attrStr, ctx) {
  return attrStr.replace(ATTR, (m, name, eq, dq, sq, uq) => {
    const lname = name.toLowerCase();
    const raw = dq !== undefined ? dq : sq !== undefined ? sq : uq;
    if (raw === undefined) return m;

    if (lname === 'integrity' || lname === 'nonce') return '';

    const value = decodeEntities(raw);
    let next = null;
    if (URL_ATTRS.has(lname)) {
      next = toProxyUrl(value, ctx.base);
    } else if (lname === 'srcset' || lname === 'imagesrcset') {
      next = rewriteSrcset(value, ctx.base);
    } else if (lname === 'style') {
      next = rewriteCss(value, ctx.base);
    } else if (tag === 'meta' && lname === 'content' && ctx.metaRefresh) {
      next = value.replace(/^(\s*[\d.]+\s*;\s*(?:url\s*=\s*)?)(['"]?)(.+?)\2\s*$/i, (mm, lead, q, u) => {
        const p = toProxyUrl(u, ctx.base);
        return p ? lead + p : mm;
      });
    }
    if (next === null || next === value) return m;
    return name + eq + '"' + encodeAttr(next) + '"';
  });
}

function rewriteTag(name, attrStr, ctx) {
  const lname = name.toLowerCase();

  if (lname === 'base') {
    const href = getAttr(attrStr, 'href');
    if (href !== null) {
      try { ctx.base = new URL(decodeEntities(href), ctx.base); } catch (e) { }
    }
    return '';
  }

  ctx.metaRefresh = false;
  if (lname === 'meta') {
    const httpEquiv = (getAttr(attrStr, 'http-equiv') || '').toLowerCase();
    const metaName = (getAttr(attrStr, 'name') || '').toLowerCase();
    if (httpEquiv === 'content-security-policy' || httpEquiv === 'content-security-policy-report-only' || metaName === 'referrer') {
      return '';
    }
    ctx.metaRefresh = httpEquiv === 'refresh';
  }
  return '<' + name + rewriteAttrs(lname, attrStr, ctx) + '>';
}

function rewriteHtml(html, target, addToolbar) {
  const ctx = { base: target, metaRefresh: false };

  let out = html.replace(TOKEN, (match, scriptAttrs, scriptBody, styleAttrs, styleBody, tagName, tagAttrs) => {
    if (match.startsWith('<!--')) return match;
    if (scriptAttrs !== undefined) {
      return '<script' + rewriteAttrs('script', scriptAttrs, ctx) + '>' + scriptBody + '</script>';
    }
    if (styleAttrs !== undefined) {
      return '<style' + rewriteAttrs('style', styleAttrs, ctx) + '>' + rewriteCss(styleBody, ctx.base) + '</style>';
    }
    return rewriteTag(tagName, tagAttrs, ctx);
  });

  if (addToolbar) {
    if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => m + TOOLBAR_TAG);
    else out = out.replace(/^(\s*<!doctype[^>]*>)?/i, (m) => m + TOOLBAR_TAG);
  }
  return out;
}

function detectCharset(contentType, buf) {
  let m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (!m) m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'));
  return m ? m[1].toLowerCase() : 'utf-8';
}

function decodeText(buf, charset) {
  try { return new TextDecoder(charset).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}

const DROP_RESPONSE = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'permissions-policy', 'strict-transport-security', 'referrer-policy', 'clear-site-data',
  'report-to', 'nel', 'alt-svc', 'link', 'public-key-pins',
  'set-cookie',
  'connection', 'keep-alive', 'transfer-encoding',
]);

const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer',
  'transfer-encoding', 'accept-encoding', 'cookie',
]);

function parseTarget(rest) {
  let s = rest;
  if (/^https?%3A/i.test(s)) { try { s = decodeURIComponent(s); } catch (e) { } }
  s = s.replace(/^(https?):\/+/i, '$1://');
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}

function buildUpstreamHeaders(req, target, session) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (DROP_REQUEST.has(k) || k.startsWith('sec-fetch-') || k.startsWith('x-forwarded-')) continue;
    h[k] = v;
  }
  h.host = target.host;
  h['accept-encoding'] = 'gzip, deflate, br';

  const cookie = cookiesFor(session, target);
  if (cookie) h.cookie = cookie;

  if (h.referer) {
    const i = h.referer.indexOf(PROXY_PREFIX);
    if (i !== -1) h.referer = h.referer.slice(i + PROXY_PREFIX.length).replace(/^(https?):\/+/i, '$1://');
    else delete h.referer;
  }
  if (h.origin) h.origin = target.origin;
  return h;
}

function filterResponseHeaders(src, target) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!DROP_RESPONSE.has(k)) out[k] = v;
  }
  if (out.location) {
    try { out.location = PROXY_PREFIX + new URL(out.location, target).href; } catch (e) { }
  }
  if (out.refresh) {
    out.refresh = String(out.refresh).replace(/(url\s*=\s*)(\S+)/i, (m, lead, u) => {
      try { return lead + PROXY_PREFIX + new URL(u, target).href; } catch (e) { return m; }
    });
  }
  return out;
}

function decodeStream(upRes) {
  const enc = String(upRes.headers['content-encoding'] || '').toLowerCase().trim();
  if (enc === 'gzip' || enc === 'x-gzip') return upRes.pipe(zlib.createGunzip());
  if (enc === 'deflate') return upRes.pipe(zlib.createInflate());
  if (enc === 'br') return upRes.pipe(zlib.createBrotliDecompress());
  return upRes;
}

function onUpstreamResponse(req, res, target, session, upRes) {
  storeCookies(session, target, upRes.headers['set-cookie']);

  const headers = filterResponseHeaders(upRes.headers, target);
  const type = String(upRes.headers['content-type'] || '');
  const lowerType = type.toLowerCase();
  const isHtml = lowerType.includes('text/html') || lowerType.includes('application/xhtml+xml');
  const isCss = lowerType.includes('text/css');
  const hasBody = req.method !== 'HEAD' && upRes.statusCode !== 204 && upRes.statusCode !== 304;

  upRes.on('error', () => res.destroy());

  if (!hasBody || !(isHtml || isCss)) {
    res.writeHead(upRes.statusCode, headers);
    return upRes.pipe(res);
  }

  const stream = decodeStream(upRes);
  const chunks = [];
  let size = 0;

  stream.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_TEXT_BYTES) { stream.destroy(new Error('That page is too large.')); return; }
    chunks.push(chunk);
  });
  stream.on('error', (err) => sendError(res, 502, 'Could not load that page', friendlyError(err)));
  stream.on('end', () => {
    const buf = Buffer.concat(chunks);
    let text = decodeText(buf, detectCharset(type, buf));

    if (isHtml) {
      const addToolbar = req.headers['sec-fetch-dest'] !== 'empty';
      text = rewriteHtml(text, target, addToolbar);
    } else {
      text = rewriteCss(text, target);
    }

    const out = Buffer.from(text, 'utf8');
    delete headers['content-encoding'];
    headers['content-type'] = type.replace(/;\s*charset=[^;]*/i, '') + '; charset=utf-8';
    headers['content-length'] = out.length;
    if (isHtml) headers.vary = headers.vary ? headers.vary + ', Sec-Fetch-Dest' : 'Sec-Fetch-Dest';
    res.writeHead(upRes.statusCode, headers);
    res.end(out);
  });
}

function handleProxy(req, res, rest) {
  const target = parseTarget(rest);
  if (!target) return sendError(res, 400, 'Invalid address', 'That does not look like a web address.');

  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOW_PRIVATE && net.isIP(hostname) && isPrivateAddress(hostname)) {
    return sendError(res, 403, 'Blocked', 'Taco Proxy will not connect to private or local addresses.');
  }

  const session = getSession(req, res);
  const isHttps = target.protocol === 'https:';

  const upstream = (isHttps ? https : http).request({
    hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: buildUpstreamHeaders(req, target, session),
    lookup: safeLookup,
    agent: isHttps ? httpsAgent : httpAgent,
    timeout: UPSTREAM_TIMEOUT,
  });

  upstream.on('timeout', () => upstream.destroy(new Error('The website took too long to respond.')));
  upstream.on('error', (err) => sendError(res, 502, 'Could not load that page', friendlyError(err)));
  upstream.on('response', (upRes) => onUpstreamResponse(req, res, target, session, upRes));
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });

  req.pipe(upstream);
}

function refererTarget(req) {
  const ref = req.headers.referer;
  if (!ref) return null;
  let u;
  try { u = new URL(ref); } catch (e) { return null; }
  if (u.host !== req.headers.host || !u.pathname.startsWith(PROXY_PREFIX)) return null;
  const m = /^(https?):\/+([^\/?#]+)/i.exec(u.pathname.slice(PROXY_PREFIX.length));
  return m ? m[1].toLowerCase() + '://' + m[2] : null;
}

const LOCAL_ONLY = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

const server = http.createServer((req, res) => {
  if (LOCAL_ONLY && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) {
    return sendError(res, 403, 'Blocked', 'Open Taco Proxy at http://localhost:' + PORT);
  }

  const rawUrl = req.url || '/';
  if (rawUrl.startsWith(PROXY_PREFIX)) return handleProxy(req, res, rawUrl.slice(PROXY_PREFIX.length));

  const pathname = rawUrl.split('?')[0];

  if (pathname.startsWith(ASSET_PREFIX)) {
    const file = resolveStatic(pathname.slice(ASSET_PREFIX.length - 1));
    return file ? serveFile(req, res, file) : sendError(res, 404, 'Not found', 'That file does not exist.');
  }

  if (SHELL_ROUTES.has(pathname)) return serveFile(req, res, resolveStatic(pathname));

  const site = refererTarget(req);
  if (site) {
    res.writeHead(307, { location: PROXY_PREFIX + site + rawUrl, 'cache-control': 'no-store' });
    return res.end();
  }

  if (pathname === '/favicon.ico') return serveFile(req, res, path.join(ROOT, 'images', 'favicon.ico'));

  const file = resolveStatic(pathname);
  if (file) return serveFile(req, res, file);
  sendError(res, 404, 'Not found', 'That page does not exist.');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error('Port ' + PORT + ' is already in use. Try:  PORT=8081 node server.js');
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('Taco Proxy running at http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  if (!LOCAL_ONLY) console.log('Warning: listening on ' + HOST + ' means other devices can use this proxy.');
});
