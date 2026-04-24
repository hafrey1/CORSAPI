// ==============================
//  CORS API 代理 
// ==============================

// ---------- 环境变量配置（通过 wrangler.toml 或 Pages 环境变量设置）----------
const ENV = {
  // 代理目标允许的域名白名单（正则表达式数组，留空表示允许所有公开域名）
  ALLOWED_TARGET_HOSTS: (globalThis.ALLOWED_HOSTS || '').split(',').filter(Boolean).map(h => new RegExp(h.trim())),
  // 代理超时时间（毫秒）
  PROXY_TIMEOUT: parseInt(globalThis.PROXY_TIMEOUT || '8000', 10),
  // 请求体最大字节数 (10MB)
  MAX_BODY_SIZE: parseInt(globalThis.MAX_BODY_SIZE || '10485760', 10),
  // 内存缓存 TTL（毫秒）
  MEMORY_CACHE_TTL: parseInt(globalThis.MEMORY_CACHE_TTL || '300000', 10),
  // KV 缓存 TTL（秒）
  KV_CACHE_TTL: parseInt(globalThis.KV_CACHE_TTL || '1800', 10),
  // 是否启用 Base58 编码（默认true）
  ENABLE_BASE58: globalThis.ENABLE_BASE58 !== 'false',
};

// 常量配置
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'set-cookie', 'set-cookie2', 'host', 'cf-ray', 'cf-connecting-ip'
]);

const JSON_SOURCES = {
  jin18: globalThis.CONFIG_JIN18 || 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
  jingjian: globalThis.CONFIG_JINGJIAN || 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jingjian.json',
  full: globalThis.CONFIG_FULL || 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/LunaTV-config.json',
};

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false }, 'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false }, 'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true }, 'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true }, 'proxy-base58': { proxy: true, base58: true },
};

// ---------- 内存缓存（懒清理，不使用 setInterval）----------
const memoryCache = globalThis.__MEMORY_CACHE__ || new Map();
globalThis.__MEMORY_CACHE__ = memoryCache;

// 懒清理函数：在每次访问缓存时顺便清理过期项（限制每次最多清理50个，避免性能影响）
function cleanExpiredCache() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, val] of memoryCache.entries()) {
    if (val.expireAt <= now) {
      memoryCache.delete(key);
      cleaned++;
      if (cleaned >= 50) break; // 限制单次清理数量
    }
  }
}

// 安全的内存缓存读取
function getMemoryCache(key) {
  cleanExpiredCache(); // 每次读取前清理部分过期项
  const cached = memoryCache.get(key);
  if (cached && cached.expireAt > Date.now()) {
    return cached.data;
  }
  if (cached) memoryCache.delete(key);
  return null;
}

function setMemoryCache(key, data, ttl) {
  memoryCache.set(key, {
    data,
    expireAt: Date.now() + ttl
  });
}

// ---------- Base58 编码 ----------
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(obj) {
  try {
    const str = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(str);
    let intVal = 0n;
    for (let b of bytes) intVal = (intVal << 8n) + BigInt(b);
    if (intVal === 0n) return BASE58_ALPHABET[0];
    let result = '';
    while (intVal > 0n) {
      const mod = Number(intVal % 58n);
      result = BASE58_ALPHABET[mod] + result;
      intVal /= 58n;
    }
    for (let b of bytes) {
      if (b === 0) result = BASE58_ALPHABET[0] + result;
      else break;
    }
    return result;
  } catch (err) {
    throw new Error(`Base58 encoding failed: ${err.message}`);
  }
}

// ---------- 递归替换 JSON 中的 api 字段前缀 ----------
function addOrReplacePrefix(obj, newPrefix) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix));
  const newObj = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'api' && typeof value === 'string') {
      let apiUrl = value;
      const urlIndex = apiUrl.indexOf('?url=');
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5);
      if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl;
      newObj[key] = apiUrl;
    } else {
      newObj[key] = addOrReplacePrefix(value, newPrefix);
    }
  }
  return newObj;
}

// ---------- 统一错误响应 ----------
function errorResponse(message, details = {}, status = 500) {
  console.error(`[ERROR ${status}]`, message, details);
  return new Response(JSON.stringify({
    success: false, error: message, details, timestamp: new Date().toISOString()
  }), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS }
  });
}

// ---------- Worker + KV 双层缓存 ----------
async function getCachedJSON(url, env) {
  const cacheKey = `CACHE_${url}`;
  const now = Date.now();

  // 1. 内存缓存（使用懒清理版本）
  const memData = getMemoryCache(cacheKey);
  if (memData) return memData;

  // 2. KV 缓存
  const kv = env?.KV || globalThis.KV;
  if (kv && typeof kv.get === 'function') {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        setMemoryCache(cacheKey, parsed, ENV.MEMORY_CACHE_TTL);
        return parsed;
      }
    } catch (err) {
      console.error('[KV READ ERROR]', err);
      await kv.delete(cacheKey).catch(() => {});
    }
  }

  // 3. 远程获取
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CORSProxy/1.0' },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`Upstream ${res.status}: ${res.statusText}`);
  const data = await res.json();

  // 4. 写入内存
  setMemoryCache(cacheKey, data, ENV.MEMORY_CACHE_TTL);

  // 5. 写入 KV（异步）
  if (kv && typeof kv.put === 'function') {
    kv.put(cacheKey, JSON.stringify(data), { expirationTtl: ENV.KV_CACHE_TTL }).catch(e =>
      console.error('[KV WRITE ERROR]', e)
    );
  }
  return data;
}

// ---------- 安全校验：防止 SSRF 攻击 ----------
function isTargetAllowed(targetUrl) {
  try {
    const url = new URL(targetUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (ENV.ALLOWED_TARGET_HOSTS.length === 0) return true;
    return ENV.ALLOWED_TARGET_HOSTS.some(regex => regex.test(url.hostname));
  } catch {
    return false;
  }
}

// ---------- 代理请求处理 ----------
async function handleProxyRequest(request, targetUrlParam, currentOrigin, env) {
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400);
  }
  if (!isTargetAllowed(targetUrlParam)) {
    return errorResponse('Target URL not allowed', { url: targetUrlParam }, 403);
  }
  let fullTargetUrl = targetUrlParam;
  const urlMatch = request.url.match(/[?&]url=([^&]+(?:&.*)?)/);
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1]);

  let targetURL;
  try {
    targetURL = new URL(fullTargetUrl);
  } catch {
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400);
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > ENV.MAX_BODY_SIZE) {
    return errorResponse(`Request body too large (max ${ENV.MAX_BODY_SIZE} bytes)`, {}, 413);
  }

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: 'half',
    });
    proxyRequest.headers.delete('host');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ENV.PROXY_TIMEOUT);
    const response = await fetch(proxyRequest, { signal: controller.signal });
    clearTimeout(timeoutId);

    const responseHeaders = new Headers(CORS_HEADERS);
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[PROXY ERROR]', err);
    return errorResponse('Proxy Error', { message: err.message, target: fullTargetUrl }, 502);
  }
}

// ---------- JSON 格式处理 ----------
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env) {
  try {
    const config = FORMAT_CONFIG[formatParam];
    if (!config) return errorResponse('Invalid format parameter', { format: formatParam }, 400);

    const sourceUrl = JSON_SOURCES[sourceParam] || JSON_SOURCES.full;
    if (!sourceUrl) return errorResponse('Invalid source', { source: sourceParam }, 400);

    const data = await getCachedJSON(sourceUrl, env);
    let processed = config.proxy ? addOrReplacePrefix(data, prefixParam || defaultPrefix) : data;

    if (config.base58 && ENV.ENABLE_BASE58) {
      const encoded = base58Encode(processed);
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS }
      });
    }
    return new Response(JSON.stringify(processed), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS }
    });
  } catch (err) {
    console.error('[FORMAT ERROR]', err);
    return errorResponse(err.message, {}, 500);
  }
}

// ---------- 首页文档处理 ----------
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .example { background: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 20px 0; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>通用 API 中转代理，用于访问被墙或限制的接口。</p>
  
  <h2>使用方法</h2>
  <p>中转任意 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}<示例API地址></pre>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
    
  <div class="section">
    <h3>📦 精简版（jin18）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jin18</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 精简版+成人（jingjian）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jingjian</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，默认）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <h2>支持的功能</h2>
  <ul>
    <li>✅ 支持 GET、POST、PUT、DELETE 等所有 HTTP 方法</li>
    <li>✅ 自动转发请求头和请求体</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ 超时保护（9 秒）</li>
    <li>✅ 支持多种配置源切换</li>
    <li>✅ 支持 Base58 编码输出</li>
  </ul>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, { 
    status: 200, 
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } 
  })
}

// ---------- 主入口 ----------
export default {
  async fetch(request, env, ctx) {
    if (env?.KV && !globalThis.KV) globalThis.KV = env.KV;
    // 注入环境变量
    if (env) {
      if (env.ALLOWED_HOSTS) ENV.ALLOWED_TARGET_HOSTS = env.ALLOWED_HOSTS.split(',').filter(Boolean).map(h => new RegExp(h.trim()));
      if (env.PROXY_TIMEOUT) ENV.PROXY_TIMEOUT = parseInt(env.PROXY_TIMEOUT, 10);
      if (env.MAX_BODY_SIZE) ENV.MAX_BODY_SIZE = parseInt(env.MAX_BODY_SIZE, 10);
      if (env.MEMORY_CACHE_TTL) ENV.MEMORY_CACHE_TTL = parseInt(env.MEMORY_CACHE_TTL, 10);
      if (env.KV_CACHE_TTL) ENV.KV_CACHE_TTL = parseInt(env.KV_CACHE_TTL, 10);
    }

    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200, headers: CORS_HEADERS });
    }

    const targetUrl = url.searchParams.get('url');
    const format = url.searchParams.get('format');
    const source = url.searchParams.get('source');
    const prefix = url.searchParams.get('prefix');
    const currentOrigin = `${url.protocol}//${url.host}`;
    const defaultPrefix = `${currentOrigin}/?url=`;

    if (targetUrl) {
      return handleProxyRequest(request, targetUrl, currentOrigin, env);
    }
    if (format !== null) {
      return handleFormatRequest(format, source, prefix, defaultPrefix, env);
    }
    return handleHomePage(currentOrigin, defaultPrefix);
  }
};
