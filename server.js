/**
 * 流光 — 本地灵感画布
 * 零依赖 Node 服务：静态文件 + 网页元数据抓取 + 视觉 AI 分析
 * 需要 Node 18+（使用全局 fetch）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const os = require('os');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4521);
const MAX_BODY = 32 * 1024 * 1024; // 32MB（base64 图片）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ---------- 环境变量：可选，读取 server.js 同目录的 .env ----------
function loadEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
}
loadEnv(path.join(ROOT, '.env'));

const DASHSCOPE_BASE = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/?$/, '/');
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'qwen3.5-omni-plus';

// ---------- 视觉 AI ----------
async function callVision(imageDataUrl, prompt, maxTokens = 1400, cfg = {}) {
  const base = (cfg.baseUrl || DASHSCOPE_BASE).replace(/\/?$/, '/');
  const key = cfg.apiKey || DASHSCOPE_KEY || '';
  const model = cfg.model || VISION_MODEL || 'qwen3.5-omni-plus';
  if (!key || key === 'sk-xxx') {
    throw new Error('未配置 API Key，请先到「⋯ → AI 模型设置」填写');
  }
  const url = new URL(base + 'chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: prompt },
        ],
      }],
      stream: false,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`视觉 API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  return null;
}

// ---------- 网页元数据 ----------
async function fetchPage(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    let html = buf.toString('utf8');
    const cm = ct.match(/charset=([\w-]+)/i);
    if (cm) {
      try { html = buf.toString(cm[1]); } catch {}
    } else {
      const mm = html.match(/<meta[^>]+charset=["']?([\w-]+)/i);
      if (mm) {
        try { html = buf.toString(mm[1]); } catch {}
      }
    }
    return { html, finalUrl: res.url || url, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function parseMeta(html, finalUrl) {
  const get = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : '';
  };
  let host = '';
  try { host = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch {}
  const title = unescapeHtml(
    get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
    get(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']*)["']/i)
  );
  const desc = unescapeHtml(
    get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
  );
  const siteName = unescapeHtml(get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i)) || host;
  const ogImage = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']*)["']/i);
  let icon = get(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i) ||
    get(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
  if (icon && !/^data:/i.test(icon)) {
    try { icon = new URL(icon, finalUrl).href; } catch { icon = ''; }
  }
  let og = '';
  if (ogImage) {
    try { og = new URL(ogImage, finalUrl).href; } catch { og = ogImage; }
  }
  return { title, desc, siteName, icon, ogImage: og, host, finalUrl };
}

async function fetchImageDataUrl(url, maxBytes = 3 * 1024 * 1024) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: url }, redirect: 'follow', signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- HTTP 工具 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
  };
}

const TMP_DIR = (() => {
  const dir = path.join(os.tmpdir(), 'luminous-export');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
})();

function newTmpPath(name) {
  const safe = path.basename(String(name || 'export.bin')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'export.bin';
  return path.join(TMP_DIR, 'exp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe);
}

function cleanupTmp() {
  try {
    for (const f of fs.readdirSync(TMP_DIR)) {
      const fp = path.join(TMP_DIR, f);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
cleanupTmp();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders()));
  res.end(body);
}

async function sendError(res, err) {
  console.error('[error]', err.message);
  sendJson(res, 500, { ok: false, error: err.message });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    // API: 网页元数据
    if (p === '/api/metadata' && req.method === 'GET') {
      const raw = u.searchParams.get('url') || '';
      let url;
      try {
        url = new URL(raw);
        if (!/^https?:$/.test(url.protocol)) throw new Error('bad');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'URL 格式不正确' });
      }
      const { html, finalUrl } = await fetchPage(url.href);
      const meta = parseMeta(html, finalUrl);
      const iconData = meta.icon ? await fetchImageDataUrl(meta.icon, 256 * 1024) : null;
      const thumbData = meta.ogImage ? await fetchImageDataUrl(meta.ogImage) : null;
      return sendJson(res, 200, {
        ok: true,
        url: finalUrl,
        title: meta.title,
        desc: meta.desc,
        siteName: meta.siteName,
        host: meta.host,
        icon: iconData,
        thumb: thumbData,
      });
    }

    // API: 单图分析 -> 设计关键词
    if (p === '/api/analyze' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.image) return sendJson(res, 400, { ok: false, error: '缺少图片' });
      const aiCfg = (body.aiConfig && typeof body.aiConfig === 'object') ? body.aiConfig : {};
      const prompt =
        '你是资深视觉设计师。分析这张图片，提炼它的设计风格和特征。' +
        '严格只输出一个 JSON 对象，不要 markdown：' +
        '{"keywords":["6-10个中文设计关键词，如：玻璃感、柔和渐变、编辑式排版、高饱和"],"summary":"60-120字中文风格总结"}';
      const rawText = await callVision(body.image, prompt, 1400, aiCfg);
      const parsed = extractJson(rawText);
      if (!parsed) {
        return sendJson(res, 200, { ok: true, raw: rawText, error: '模型未返回 JSON，已展示原文' });
      }
      return sendJson(res, 200, {
        ok: true,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : rawText,
      });
    }

    // API: AI 看整张画布
    if (p === '/api/analyze-canvas' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.image) return sendJson(res, 400, { ok: false, error: '缺少画布截图' });
      const cards = Array.isArray(body.cards) ? body.cards : [];
      const list = cards.length
        ? cards.map((c, i) => `${i + 1}. ${c.title || c.type || '素材'}`).join('\n')
        : '（无文字列表）';
      const aiCfg = (body.aiConfig && typeof body.aiConfig === 'object') ? body.aiConfig : {};
      const prompt =
        '你是灵感画布助手。这是一张灵感收集画布的截图，上面散落着网页、图片、文字等灵感素材。' +
        '素材文字列表：\n' + list + '\n\n' +
        '请整体分析：1) 这些素材共同的方向/风格；2) 提炼 6-10 个关键词；3) 给出 2-3 条整理或发散建议。' +
        '严格只输出一个 JSON 对象，不要 markdown：' +
        '{"summary":"120字以内中文总结","keywords":["..."],"suggestions":["..."]}';
      const rawText = await callVision(body.image, prompt, 1400, aiCfg);
      const parsed = extractJson(rawText);
      if (!parsed) {
        return sendJson(res, 200, { ok: true, raw: rawText, error: '模型未返回 JSON，已展示原文' });
      }
      return sendJson(res, 200, {
        ok: true,
        summary: typeof parsed.summary === 'string' ? parsed.summary : rawText,
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      });
    }

    // API: AI 模型测试连接
    if (p === '/api/ai-test' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      try {
        const base = (body.baseUrl || DASHSCOPE_BASE).replace(/\/?$/, '/');
        const key = body.apiKey || DASHSCOPE_KEY || '';
        const model = body.model || VISION_MODEL || 'qwen3.5-omni-plus';
        if (!key || key === 'sk-xxx') throw new Error('未填写 API Key');
        const resp = await fetch(new URL(base + 'chat/completions'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: '请只回复：OK' }], max_tokens: 8, stream: false }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
        const data = await resp.json();
        const reply = data?.choices?.[0]?.message?.content || '';
        return sendJson(res, 200, { ok: true, reply: String(reply).slice(0, 50) });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message });
      }
    }

    // API: 读取服务端默认 AI 配置（不返回 Key）
    if (p === '/api/ai-config' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        baseUrl: DASHSCOPE_BASE,
        model: VISION_MODEL,
        hasKey: !!(DASHSCOPE_KEY && DASHSCOPE_KEY !== 'sk-xxx'),
      });
    }

    // API: 桌面版导出 — 接收媒体文件流，落盘到临时目录
    if (p === '/api/export-media' && req.method === 'POST') {
      let rawName = 'export.bin';
      try { rawName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']) : 'export.bin'; } catch {}
      const tmp = newTmpPath(rawName);
      const ws = fs.createWriteStream(tmp);
      req.pipe(ws);
      await new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      return sendJson(res, 200, { ok: true, tmpPath: tmp });
    }

    // API: 桌面版导出 — 下载远程文件到临时目录
    if (p === '/api/export-remote' && req.method === 'GET') {
      const raw = u.searchParams.get('url') || '';
      let url;
      try {
        url = new URL(raw);
        if (!/^https?:$/.test(url.protocol)) throw new Error('bad');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'URL 格式不正确' });
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000);
      try {
        const resp = await fetch(url, { headers: { 'User-Agent': UA, Referer: url.origin }, redirect: 'follow', signal: ctrl.signal });
        if (!resp.ok || !resp.body) return sendJson(res, 400, { ok: false, error: '下载失败 HTTP ' + resp.status });
        let name = 'export.bin';
        const cd = resp.headers.get('content-disposition') || '';
        const cm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
        if (cm) name = cm[1];
        else {
          try { name = decodeURIComponent(url.pathname.split('/').pop() || 'export.bin'); } catch {}
        }
        const tmp = newTmpPath(name);
        const ws = fs.createWriteStream(tmp);
        const reader = resp.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          await new Promise((resolve, reject) => ws.write(Buffer.from(value), (err) => (err ? reject(err) : resolve())));
        }
        await new Promise((resolve, reject) => { ws.end(() => resolve()); ws.on('error', reject); });
        return sendJson(res, 200, { ok: true, tmpPath: tmp });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: '下载失败：' + err.message });
      } finally {
        clearTimeout(timer);
      }
    }

    // 静态文件
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }, corsHeaders()));
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    await sendError(res, err);
  }
});

server.listen(PORT, () => {
  const addr = server.address();
  const realPort = addr && typeof addr === 'object' ? addr.port : PORT;
  console.log('LUMINOUS_PORT=' + realPort);
  console.log('流光 已启动: http://localhost:' + realPort);
});
