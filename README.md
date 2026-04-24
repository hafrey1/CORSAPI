🚀 CORS API Proxy（Cloudflare Worker）

一个基于 Cloudflare Workers 的高性能 API 中转代理服务，支持：

🌍 任意 API 跨域访问（CORS）
🔄 JSON 配置动态处理
⚡ 双层缓存（Memory + KV）
🔐 SSRF 安全防护
📦 Base58 编码输出
🧩 多数据源切换
📦 项目地址

👉 https://github.com/hafrey1/CORSAPI

✨ 功能特性
✅ 支持 GET / POST / PUT / DELETE / PATCH
✅ 自动透传请求头 & 请求体
✅ 自动处理 CORS（全开放）
✅ 支持大部分 API 代理
✅ 内置超时保护（默认 8 秒）
✅ 内存缓存 + KV 持久缓存
✅ JSON 数据动态改写（API 前缀替换）
✅ Base58 编码输出（适用于订阅场景）
🚀 快速开始
1️⃣ 安装依赖
npm install -g wrangler

登录 Cloudflare：

wrangler login
2️⃣ 初始化项目
wrangler init cors-api
cd cors-api

把你的代码放进：

/worker.js
3️⃣ 配置 wrangler.toml
name = "cors-api"
main = "worker.js"
compatibility_date = "2024-01-01"

# KV（可选）
[[kv_namespaces]]
binding = "KV"
id = "你的KV_ID"
4️⃣ 设置环境变量（可选）
wrangler secret put ALLOWED_HOSTS
wrangler secret put PROXY_TIMEOUT
wrangler secret put MAX_BODY_SIZE
wrangler secret put MEMORY_CACHE_TTL
wrangler secret put KV_CACHE_TTL
5️⃣ 部署
wrangler deploy

部署完成后得到：

https://your-domain.workers.dev
🧠 使用方式
🔄 1. API 代理
https://your-domain.workers.dev/?url=目标API地址
示例：
curl "https://your-domain.workers.dev/?url=https://api.github.com"
📦 2. JSON 配置订阅
参数说明：
参数	说明
format	输出格式
source	数据源
prefix	自定义代理前缀
🎯 format 参数
值	说明
0 / raw	原始 JSON
1 / proxy	添加代理
2 / base58	Base58 编码
3 / proxy-base58	代理 + Base58
📁 source 参数
值	说明
jin18	精简版
jingjian	精简+成人
full	完整版（默认）
🔗 示例
原始 JSON
https://your-domain.workers.dev/?format=0
代理 JSON
https://your-domain.workers.dev/?format=1
Base58
https://your-domain.workers.dev/?format=2
代理 + Base58
https://your-domain.workers.dev/?format=3
⚙️ 环境变量说明
变量	默认值	说明
ALLOWED_HOSTS	空	允许访问的域名（正则）
PROXY_TIMEOUT	8000	请求超时（ms）
MAX_BODY_SIZE	10485760	最大请求体（10MB）
MEMORY_CACHE_TTL	300000	内存缓存时间
KV_CACHE_TTL	1800	KV缓存时间（秒）
ENABLE_BASE58	true	是否启用 Base58
🧩 架构设计
用户请求
   ↓
Worker
   ↓
├── 内存缓存（优先）
├── KV缓存（持久）
└── 远程 API 请求
        ↓
   返回结果 + CORS
🔐 安全设计
🚫 防止 SSRF（限制协议 + 域名）
🚫 禁止访问自身（防循环）
🚫 限制请求体大小
🚫 过滤敏感 Header
⚡ 性能优化
⚡ 内存缓存（毫秒级响应）
⚡ KV 缓存（跨实例共享）
⚡ Cloudflare 边缘缓存
⚡ 懒清理缓存（避免 CPU 浪费）
🧪 测试接口
健康检查
curl https://your-domain.workers.dev/health

返回：

OK
📌 常见问题
❓ 为什么有些 API 请求失败？

可能原因：

目标网站限制 IP（Cloudflare）
目标 API 禁止代理访问
HTTPS 证书问题
❓ 如何限制代理域名？

设置：

ALLOWED_HOSTS=^api\.github\.com$,^example\.com$
❓ KV 不生效？

确认：

已绑定 KV namespace
wrangler.toml 配置正确
🛠 后续优化建议
🔄 增加缓存命中率统计
📊 接入日志分析（Logpush）
🔐 加 API Key 限流
🌍 多区域负载策略
📦 支持 gzip / brotli
📄 License

MIT License

❤️ 作者

hafrey
