// ── Wild Blog Worker ──────────────────────────────────────────────────────
// A tiny full-stack blog: Cloudflare Worker + KV storage.
// Posts are stored in KV under key `post:<slug>` as JSON.
// Writes (create / edit / delete) require the ADMIN_PASSWORD secret.

const SITE_NAME = '野蛮生长';
const SITE_TAGLINE = 'NEO-BRUTALIST NOTES · 未经修饰的想法';

// ── tiny markdown → html (enough for a personal blog) ──────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(md) {
  return md
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdToHtml(md) {
  const lines = escapeHtml(md).split('\n');
  let html = '';
  let inCode = false;
  let listType = null; // 'ul' | 'ol'

  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };

  for (let raw of lines) {
    if (raw.startsWith('```')) {
      if (!inCode) { closeList(); html += '<pre><code>'; inCode = true; }
      else { html += '</code></pre>'; inCode = false; }
      continue;
    }
    if (inCode) { html += raw + '\n'; continue; }

    const line = raw;
    if (/^\s*$/.test(line)) { closeList(); continue; }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const level = m[1].length;
      html += `<h${level}>${inline(m[2])}</h${level}>`;
      continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)$/))) {
      closeList();
      html += `<blockquote><p>${inline(m[1])}</p></blockquote>`;
      continue;
    }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      html += '<hr>';
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  if (inCode) html += '</code></pre>';
  return html;
}

function slugify(title) {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || `post-${Date.now()}`;
}

// ── layout ───────────────────────────────────────────────────────────────
function layout({ title, body, active = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} · ${SITE_NAME}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='black'/%3E%3Crect x='4' y='4' width='24' height='24' fill='%23F7DC6F'/%3E%3Crect x='9' y='9' width='14' height='14' fill='black'/%3E%3C/svg%3E" />
<link rel="stylesheet" href="/style.css" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;600;700&family=Noto+Sans+SC:wght@400;700;900&display=swap" rel="stylesheet" />
</head>
<body>
<header class="site-header">
  <a href="/" class="brand">
    <span class="brand-mark">■</span>
    <span class="brand-text">${SITE_NAME}</span>
  </a>
  <nav class="site-nav">
    <a href="/" class="${active === 'home' ? 'is-active' : ''}">首页</a>
    <a href="/new" class="btn-nav-new ${active === 'new' ? 'is-active' : ''}">+ 发新帖</a>
  </nav>
</header>
<main class="site-main">
${body}
</main>
<footer class="site-footer">
  <span>${SITE_NAME} · ${SITE_TAGLINE}</span>
</footer>
</body>
</html>`;
}

function tagChips(tags) {
  if (!tags || !tags.length) return '';
  return `<div class="tags">${tags.map((t, i) => `<span class="tag tag-${i % 4}">#${escapeHtml(t)}</span>`).join('')}</div>`;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { return iso; }
}

// ── pages ────────────────────────────────────────────────────────────────
function homePage(posts) {
  const cards = posts.length
    ? posts.map((p, i) => `
      <a href="/posts/${encodeURIComponent(p.slug)}" class="post-card tilt-${i % 3}">
        <span class="stamp">已发布</span>
        <div class="post-card-date">${fmtDate(p.pubDate)}</div>
        <h2 class="post-card-title">${escapeHtml(p.title)}</h2>
        <p class="post-card-desc">${escapeHtml(p.description || '')}</p>
        ${tagChips(p.tags)}
      </a>`).join('')
    : `<div class="empty-state">
         <p>信号还没接通。点右上角「+ 发新帖」写第一篇。</p>
       </div>`;

  const body = `
  <section class="hero">
    <div class="hero-tag">PERSONAL BLOG / NO FILTER</div>
    <h1 class="hero-title">野蛮生长<span class="hero-dot">.</span></h1>
    <p class="hero-sub">没有编辑部，只有想法和发布键。粗野一点，真实一点。</p>
    <button type="button" class="btn btn-chaos" onclick="toggleChaos()">🎲 混乱模式</button>
  </section>
  <section class="post-grid" id="post-grid">${cards}</section>

  <script>
    function toggleChaos() {
      const grid = document.getElementById('post-grid');
      const cards = grid.querySelectorAll('.post-card');
      const colors = ['var(--pink)', 'var(--green)', 'var(--blue)', 'var(--yellow)'];
      cards.forEach((card) => {
        const rot = (Math.random() * 6 - 3).toFixed(2);
        const color = colors[Math.floor(Math.random() * colors.length)];
        card.style.transform = 'rotate(' + rot + 'deg)';
        card.style.setProperty('--shadow-color', color);
      });
    }
  </script>`;
  return layout({ title: '首页', body, active: 'home' });
}

function postPage(post) {
  const contentHtml = mdToHtml(post.content || '');
  const body = `
  <article class="post-detail">
    <div class="post-detail-meta">
      <time>${fmtDate(post.pubDate)}</time>
      ${tagChips(post.tags)}
    </div>
    <h1 class="post-detail-title">${escapeHtml(post.title)}</h1>
    <p class="post-detail-desc">${escapeHtml(post.description || '')}</p>

    <div class="post-actions">
      <a href="/edit/${encodeURIComponent(post.slug)}" class="btn btn-edit">✎ 编辑</a>
      <button type="button" class="btn btn-delete" onclick="openDeletePanel()">🗑 删除</button>
    </div>

    <div class="prose">${contentHtml}</div>

    <a href="/" class="back-link">&larr; 返回首页</a>
  </article>

  <div id="delete-panel" class="delete-panel" hidden>
    <div class="delete-panel-inner">
      <p class="delete-warning">⚠ 这会永久删除《${escapeHtml(post.title)}》，无法撤销。</p>
      <input id="delete-password" type="password" placeholder="管理密码" autocomplete="current-password" />
      <div class="delete-panel-actions">
        <button type="button" class="btn btn-ghost" onclick="closeDeletePanel()">取消</button>
        <button type="button" class="btn btn-delete-confirm" onclick="confirmDelete('${post.slug}')">确认删除</button>
      </div>
      <p id="delete-error" class="form-error" hidden></p>
    </div>
  </div>

  <script>
    function openDeletePanel() { document.getElementById('delete-panel').hidden = false; }
    function closeDeletePanel() {
      document.getElementById('delete-panel').hidden = true;
      document.getElementById('delete-error').hidden = true;
    }
    async function confirmDelete(slug) {
      const password = document.getElementById('delete-password').value;
      const err = document.getElementById('delete-error');
      const res = await fetch('/api/posts/' + encodeURIComponent(slug) + '/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        const text = await res.text();
        err.textContent = text || '删除失败，请检查密码';
        err.hidden = false;
      }
    }
  </script>`;
  return layout({ title: post.title, body });
}

function editPage(post, isNew) {
  const p = post || { slug: '', title: '', description: '', tags: [], pubDate: new Date().toISOString().slice(0, 10), content: '' };
  const body = `
  <section class="editor">
    <h1 class="editor-title">${isNew ? '新建帖子' : '编辑帖子'}</h1>
    <form id="editor-form" class="editor-form">
      <label>标题
        <input name="title" required value="${escapeHtml(p.title)}" placeholder="给它起个够劲的名字" />
      </label>
      <label>一句话简介
        <input name="description" value="${escapeHtml(p.description || '')}" placeholder="列表页显示的摘要" />
      </label>
      <div class="editor-row">
        <label>发布日期
          <input name="pubDate" type="date" value="${p.pubDate ? p.pubDate.slice(0, 10) : ''}" required />
        </label>
        <label>标签（逗号分隔）
          <input name="tags" value="${escapeHtml((p.tags || []).join(', '))}" placeholder="随笔, 深夜" />
        </label>
      </div>
      <label>正文（支持 Markdown）
        <textarea name="content" rows="16" placeholder="## 小标题&#10;&#10;正文内容，支持 **加粗**、*斜体*、\`代码\`、列表、> 引用……">${escapeHtml(p.content || '')}</textarea>
      </label>
      <label>管理密码
        <input name="password" type="password" required placeholder="输入密码才能保存" autocomplete="current-password" />
      </label>
      <div class="editor-actions">
        <button type="submit" class="btn btn-save">${isNew ? '⚡ 发布' : '⚡ 保存修改'}</button>
        <a href="${isNew ? '/' : '/posts/' + encodeURIComponent(p.slug)}" class="btn btn-ghost">取消</a>
      </div>
      <p id="editor-error" class="form-error" hidden></p>
    </form>
  </section>

  <script>
    const form = document.getElementById('editor-form');
    const err = document.getElementById('editor-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const fd = new FormData(form);
      const payload = {
        title: fd.get('title'),
        description: fd.get('description'),
        pubDate: fd.get('pubDate'),
        tags: fd.get('tags').split(',').map(s => s.trim()).filter(Boolean),
        content: fd.get('content'),
        password: fd.get('password'),
      };
      const isNew = ${isNew ? 'true' : 'false'};
      const url = isNew ? '/api/posts' : '/api/posts/${encodeURIComponent(p.slug)}';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        window.location.href = '/posts/' + encodeURIComponent(data.slug);
      } else {
        err.textContent = await res.text() || '保存失败，请检查密码';
        err.hidden = false;
      }
    });
  </script>`;
  return layout({ title: isNew ? '新建帖子' : `编辑 · ${p.title}`, body, active: isNew ? 'new' : '' });
}

function notFoundPage() {
  const body = `<section class="not-found">
    <h1>404</h1>
    <p>信号丢失，这个页面不存在。</p>
    <a href="/" class="btn btn-edit">回到首页</a>
  </section>`;
  return layout({ title: '未找到', body });
}

// ── KV helpers ───────────────────────────────────────────────────────────
async function listPosts(env) {
  const list = await env.POSTS.list({ prefix: 'post:' });
  const posts = await Promise.all(list.keys.map((k) => env.POSTS.get(k.name, 'json')));
  return posts
    .filter(Boolean)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

async function getPost(env, slug) {
  return env.POSTS.get(`post:${slug}`, 'json');
}

async function savePost(env, slug, data) {
  await env.POSTS.put(`post:${slug}`, JSON.stringify(data));
}

async function deletePost(env, slug) {
  await env.POSTS.delete(`post:${slug}`);
}

function checkPassword(env, password) {
  return !!env.ADMIN_PASSWORD && password === env.ADMIN_PASSWORD;
}

// ── router ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Static assets (css, favicon, etc.)
    if (pathname === '/style.css') {
      return env.ASSETS.fetch(request);
    }

    try {
      // GET /
      if (request.method === 'GET' && pathname === '/') {
        const posts = await listPosts(env);
        return html(homePage(posts));
      }

      // GET /new
      if (request.method === 'GET' && pathname === '/new') {
        return html(editPage(null, true));
      }

      // GET /posts/:slug
      let m = pathname.match(/^\/posts\/([^/]+)\/?$/);
      if (request.method === 'GET' && m) {
        const post = await getPost(env, decodeURIComponent(m[1]));
        if (!post) return html(notFoundPage(), 404);
        return html(postPage(post));
      }

      // GET /edit/:slug
      m = pathname.match(/^\/edit\/([^/]+)\/?$/);
      if (request.method === 'GET' && m) {
        const post = await getPost(env, decodeURIComponent(m[1]));
        if (!post) return html(notFoundPage(), 404);
        return html(editPage(post, false));
      }

      // POST /api/posts  (create)
      if (request.method === 'POST' && pathname === '/api/posts') {
        const body = await request.json();
        if (!checkPassword(env, body.password)) return text('密码错误', 403);
        if (!body.title) return text('缺少标题', 400);
        let slug = slugify(body.title);
        // avoid collision
        let candidate = slug, n = 1;
        while (await getPost(env, candidate)) { candidate = `${slug}-${n++}`; }
        slug = candidate;
        const data = {
          slug,
          title: body.title,
          description: body.description || '',
          tags: body.tags || [],
          pubDate: body.pubDate || new Date().toISOString().slice(0, 10),
          content: body.content || '',
        };
        await savePost(env, slug, data);
        return json({ slug });
      }

      // POST /api/posts/:slug  (update)
      m = pathname.match(/^\/api\/posts\/([^/]+)$/);
      if (request.method === 'POST' && m) {
        const slug = decodeURIComponent(m[1]);
        const body = await request.json();
        if (!checkPassword(env, body.password)) return text('密码错误', 403);
        const existing = await getPost(env, slug);
        if (!existing) return text('帖子不存在', 404);
        const data = {
          slug,
          title: body.title || existing.title,
          description: body.description ?? existing.description,
          tags: body.tags ?? existing.tags,
          pubDate: body.pubDate || existing.pubDate,
          content: body.content ?? existing.content,
        };
        await savePost(env, slug, data);
        return json({ slug });
      }

      // POST /api/posts/:slug/delete
      m = pathname.match(/^\/api\/posts\/([^/]+)\/delete$/);
      if (request.method === 'POST' && m) {
        const slug = decodeURIComponent(m[1]);
        const body = await request.json();
        if (!checkPassword(env, body.password)) return text('密码错误', 403);
        await deletePost(env, slug);
        return json({ ok: true });
      }

      return html(notFoundPage(), 404);
    } catch (err) {
      return text('服务器出错：' + (err && err.message ? err.message : String(err)), 500);
    }
  },
};

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function text(str, status = 200) {
  return new Response(str, { status, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } });
}
