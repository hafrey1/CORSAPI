export default {
  async fetch(request, env, ctx) {
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }
    return handleRequest(request, ctx)
  }
}

// ---------------- 常量 ----------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding','content-length','transfer-encoding',
  'connection','keep-alive','set-cookie','set-cookie2'
])

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

// ---------------- 🚀 核心缓存（KV + Cache）----------------
async function getCachedJSON(url, ctx) {
  const cache = caches.default
  const cacheKey = new Request(url)

  // 1️⃣ Cache（主力）
  let res = await cache.match(cacheKey)
  if (res) return await res.json()

  // 2️⃣ KV（备用）
  if (typeof KV !== 'undefined') {
    const kv = await KV.get('CACHE_' + url)
    if (kv) {
      const data = JSON.parse(kv)

      const response = new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' }
      })

      ctx.waitUntil(cache.put(cacheKey, response.clone()))
      return data
    }
  }

  // 3️⃣ fetch（最少）
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Fetch failed ${response.status}`)
  const data = await response.json()

  if (typeof KV !== 'undefined') {
    ctx.waitUntil(KV.put('CACHE_' + url, JSON.stringify(data), {
      expirationTtl: 1800
    }))
  }

  const newRes = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=600'
    }
  })

  ctx.waitUntil(cache.put(cacheKey, newRes.clone()))
  return data
}

// ---------------- Base58 ----------------
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  let num = 0n
  for (let b of bytes) num = (num << 8n) + BigInt(b)

  let str = ''
  while (num > 0) {
    str = BASE58[num % 58n] + str
    num /= 58n
  }
  return str
}

// ---------------- JSON 前缀处理 ----------------
function addOrReplacePrefix(obj, prefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(i => addOrReplacePrefix(i, prefix))

  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let api = obj[key]
      const idx = api.indexOf('?url=')
      if (idx !== -1) api = api.slice(idx + 5)
      if (!api.startsWith(prefix)) api = prefix + api
      newObj[key] = api
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], prefix)
    }
  }
  return newObj
}

// ---------------- 主入口 ----------------
async function handleRequest(request, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const target = reqUrl.searchParams.get('url')
  const format = reqUrl.searchParams.get('format')
  const prefix = reqUrl.searchParams.get('prefix')
  const source = reqUrl.searchParams.get('source')

  const origin = reqUrl.origin
  const defaultPrefix = origin + '/?url='

  if (pathname === '/health') {
    return new Response('OK')
  }

  // ---------------- 代理 ----------------
  if (target) {
    if (target.startsWith(origin)) {
      return new Response('Loop blocked', { status: 400 })
    }

    if (!/^https?:\/\//i.test(target)) {
      return new Response('Bad URL', { status: 400 })
    }

    try {
      const res = await fetch(target, {
        method: request.method,
        headers: request.headers
      })

      const headers = new Headers(CORS_HEADERS)
      for (let [k, v] of res.headers) {
        if (!EXCLUDE_HEADERS.has(k.toLowerCase())) {
          headers.set(k, v)
        }
      }

      return new Response(res.body, {
        status: res.status,
        headers
      })
    } catch {
      return new Response('Proxy Error', { status: 502 })
    }
  }

  // ---------------- JSON ----------------
  if (format !== null) {
    const config = FORMAT_CONFIG[format]
    if (!config) return new Response('Bad format', { status: 400 })

    const selected = JSON_SOURCES[source] || JSON_SOURCES.full
    const data = await getCachedJSON(selected, ctx)

    const newData = config.proxy
      ? addOrReplacePrefix(data, prefix || defaultPrefix)
      : data

    if (config.base58) {
      return new Response(base58Encode(newData), {
        headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS }
      })
    }

    return new Response(JSON.stringify(newData), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    })
  }

  // ---------------- 首页 ----------------
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

// ---------- 统一错误响应处理 ----------
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}