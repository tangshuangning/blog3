// ── Wild Blog Worker ──────────────────────────────────────────────────────
// A tiny full-stack blog: Cloudflare Worker + KV storage.
// Posts are stored in KV under key `post:<slug>` as JSON.
// Writes (create / edit / delete) require the ADMIN_PASSWORD secret.

const SITE_NAME = '野蛮生长';
const SITE_TAGLINE = 'NEO-BRUTALIST NOTES · Chegada · CSP-S';

// ── tiny markdown → html (enough for a personal blog) ──────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeUrl(url) {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|tel:|data:|#|\/)/i.test(trimmed)) return trimmed;
  return 'https://' + trimmed;
}

function inline(md) {
  return md
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => `<img src="${normalizeUrl(url)}" alt="${alt}">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => `<a href="${normalizeUrl(url)}" target="_blank" rel="noopener">${text}</a>`);
}

function splitTableRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

function tableAlign(sep) {
  const s = sep.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

function renderTable(headers, aligns, rows) {
  let out = '<table><thead><tr>';
  headers.forEach((h, i) => {
    const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
    out += `<th${a}>${inline(h)}</th>`;
  });
  out += '</tr></thead><tbody>';
  rows.forEach((row) => {
    out += '<tr>';
    row.forEach((cell, i) => {
      const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
      out += `<td${a}>${inline(cell || '')}</td>`;
    });
    out += '</tr>';
  });
  out += '</tbody></table>';
  return out;
}

const TABLE_SEP_RE = /^\s*\|?(\s*:?-{1,}:?\s*\|)*\s*:?-{1,}:?\s*\|?\s*$/;
const CALLOUT_OPEN_RE = /^::::(info|success|warning|error)(?:\[(.*?)\])?(\{open\})?\s*$/;
const ALIGN_OPEN_RE = /^:::align\{(\w+)\}\s*$/;

// ── markdown → html, with Luogu-flavored extensions ────────────────────────
// Beyond standard markdown (headers, emphasis, lists, blockquote, code,
// links, hr) this also supports:
//   - tables with per-column alignment (|:---|:---:|---:|)
//   - collapsible callout boxes: ::::info[title]{open} ... ::::
//     (success / warning / error variants; {open} makes it expanded by default)
//   - centered blocks: :::align{center} ... :::
//   - $...$ / $$...$$ math, rendered client-side by KaTeX (see postPage)
function renderLines(lines) {
  let html = '';
  let inCode = false;
  let listType = null; // 'ul' | 'ol'
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];

    if (raw.startsWith('```')) {
      if (!inCode) { closeList(); html += '<pre><code>'; inCode = true; }
      else { html += '</code></pre>'; inCode = false; }
      i++; continue;
    }
    if (inCode) { html += raw + '\n'; i++; continue; }

    const line = raw;
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    let m;

    // collapsible callout box: ::::info[title]{open} ... ::::
    if ((m = line.match(CALLOUT_OPEN_RE))) {
      closeList();
      const type = m[1];
      const title = m[2];
      const openAttr = m[3] ? ' open' : '';
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '::::') j++;
      const inner = renderLines(lines.slice(i + 1, j));
      const label = title ? inline(title) : type.toUpperCase();
      html += `<details class="callout callout-${type}"${openAttr}><summary>${label}</summary><div class="callout-body">${inner}</div></details>`;
      i = j + 1;
      continue;
    }

    // centered/aligned block: :::align{center} ... :::
    if ((m = line.match(ALIGN_OPEN_RE))) {
      closeList();
      const alignValue = m[1];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      const inner = renderLines(lines.slice(i + 1, j));
      html += `<div class="md-align md-align-${alignValue}">${inner}</div>`;
      i = j + 1;
      continue;
    }

    // table: header row + separator row (|:---|:---:|---:|)
    if (line.includes('|') && lines[i + 1] && TABLE_SEP_RE.test(lines[i + 1])) {
      closeList();
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(tableAlign);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && lines[j].includes('|') && !/^\s*$/.test(lines[j])) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      html += renderTable(headers, aligns, rows);
      i = j;
      continue;
    }

    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const level = m[1].length;
      html += `<h${level}>${inline(m[2])}</h${level}>`;
      i++; continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)$/))) {
      closeList();
      html += `<blockquote><p>${inline(m[1])}</p></blockquote>`;
      i++; continue;
    }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      const task = m[1].match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
        html += `<li class="task-item"><input type="checkbox" disabled${checked}> ${inline(task[2])}</li>`;
      } else {
        html += `<li>${inline(m[1])}</li>`;
      }
      i++; continue;
    }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
      i++; continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      html += '<hr>';
      i++; continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
    i++;
  }
  closeList();
  if (inCode) html += '</code></pre>';
  return html;
}

function mdToHtml(md) {
  return renderLines(escapeHtml(md).split('\n'));
}

function slugify(title) {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || `post-${Date.now()}`;
}

// ── Aho-Corasick multi-pattern matcher ──────────────────────────────────────
// Used for search: splits the query into keywords and builds a single
// automaton so every post's text is scanned once (O(n)) to check whether
// ANY keyword occurs, instead of running indexOf() once per keyword.
// Matching is case-insensitive because both patterns and text are lower-cased
// before being fed in.
class AhoCorasick {
  constructor(patterns) {
    this.root = { children: new Map(), fail: null, output: new Set() };
    patterns.forEach((p, i) => this._insert(p, i));
    this._buildFailLinks();
  }

  _insert(pattern, idx) {
    let node = this.root;
    for (const ch of pattern) {
      if (!node.children.has(ch)) {
        node.children.set(ch, { children: new Map(), fail: null, output: new Set() });
      }
      node = node.children.get(ch);
    }
    node.output.add(idx);
  }

  _buildFailLinks() {
    const queue = [];
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    while (queue.length) {
      const current = queue.shift();
      for (const [ch, child] of current.children) {
        let failNode = current.fail;
        while (failNode && !failNode.children.has(ch)) {
          failNode = failNode.fail;
        }
        child.fail = failNode ? failNode.children.get(ch) : this.root;
        for (const o of child.fail.output) child.output.add(o);
        queue.push(child);
      }
    }
  }

  // Returns true as soon as any pattern is found anywhere in `text`.
  matchesAny(text) {
    let node = this.root;
    for (const ch of text) {
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail;
      }
      node = node.children.get(ch) || this.root;
      if (node.output.size) return true;
    }
    return false;
  }
}

function searchPosts(posts, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return posts;
  const automaton = new AhoCorasick(terms);
  return posts.filter((p) => {
    const haystack = `${p.title}\n${p.description || ''}\n${(p.tags || []).join(' ')}\n${p.content || ''}`.toLowerCase();
    return automaton.matchesAny(haystack);
  });
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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script defer>
  document.addEventListener('DOMContentLoaded', function () {
    if (window.renderMathInElement) {
      renderMathInElement(document.body, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false
      });
    }
  });
</script>
</head>
<body>
<div id="cursor-dot" class="cursor-dot" aria-hidden="true"></div>
<div id="cursor-ring" class="cursor-ring" aria-hidden="true"></div>
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
  <span>${SITE_TAGLINE}</span>
</footer>
<script>
  (function () {
    var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    if (prefersReducedMotion || isTouchDevice) return;

    var dot = document.getElementById('cursor-dot');
    var ring = document.getElementById('cursor-ring');
    if (!dot || !ring) return;
    document.body.classList.add('has-custom-cursor');

    var position = { x: 0, y: 0 };
    var target = { x: 0, y: 0 };
    var isHovering = false;
    var rafId = null;
    var isIdle = false;
    var idleTimeout = null;

    function stopAnimation() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      isIdle = true;
    }

    function animate() {
      if (isIdle) return;
      var ease = 0.15;
      position.x += (target.x - position.x) * ease;
      position.y += (target.y - position.y) * ease;

      var scale = isHovering ? 2.5 : 1;
      var ringScale = isHovering ? 1.5 : 1;

      dot.style.transform = 'translate3d(' + (position.x - 8) + 'px,' + (position.y - 8) + 'px,0) scale(' + scale + ')';
      ring.style.transform = 'translate3d(' + (position.x - 16) + 'px,' + (position.y - 16) + 'px,0) scale(' + ringScale + ')';

      rafId = requestAnimationFrame(animate);
    }

    function startAnimation() {
      if (!isIdle) return;
      isIdle = false;
      rafId = requestAnimationFrame(animate);
    }

    window.addEventListener('mousemove', function (e) {
      target = { x: e.clientX, y: e.clientY };
      if (isIdle) startAnimation();
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(stopAnimation, 1000);
    }, { passive: true });

    window.addEventListener('mouseover', function (e) {
      var t = e.target;
      isHovering = t.tagName === 'A' || t.tagName === 'BUTTON' || !!t.closest('a, button');
    }, { passive: true });

    rafId = requestAnimationFrame(animate);
  })();

  // Random hover colors for buttons and post cards — a bigger palette than
  // chaos-mode's, kept deliberately disjoint from it, plus two guarantees:
  // the picked shadow color never matches the element's original shadow
  // (black by default, or one of the chaos colors), and the shadow color
  // never matches the text color picked alongside it.
  (function () {
    var HOVER_PALETTE = [
      '#a855f7', // purple
      '#ff8c42', // orange
      '#a8ff60', // lime
      '#22d3ee', // cyan
      '#e930ff', // magenta
      '#14b8a6', // teal
      '#fb7185', // rose
      '#6366f1', // indigo
      '#fbbf24', // amber
      '#34d399', // emerald
      '#38bdf8', // sky
      '#c026d3', // fuchsia
    ];
    // "Original" shadow colors that a hover pick must never collide with:
    // black (the default) and the four chaos-mode colors.
    var BASE_SHADOW_COLORS = ['#000000', '#ff6b6b', '#4ecdc4', '#45b7d1', '#f7dc6f'];

    function pickFrom(pool) {
      return pool[Math.floor(Math.random() * pool.length)];
    }

    document.querySelectorAll('.btn, .btn-nav-new, .page-btn, .post-card').forEach(function (el) {
      el.addEventListener('mouseenter', function () {
        var shadowPool = HOVER_PALETTE.filter(function (c) { return BASE_SHADOW_COLORS.indexOf(c) === -1; });
        var shadowColor = pickFrom(shadowPool);
        var textPool = HOVER_PALETTE.filter(function (c) { return c !== shadowColor; });
        var textColor = pickFrom(textPool);
        el.style.setProperty('--hover-shadow-color', shadowColor);
        el.style.setProperty('--hover-text-color', textColor);
      });
      el.addEventListener('mouseleave', function () {
        el.style.removeProperty('--hover-shadow-color');
        el.style.removeProperty('--hover-text-color');
      });
    });
  })();
</script>
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

const PAGE_SIZE = 6;

function paginationControls(meta) {
  const { page, totalPages, q } = meta;
  if (totalPages <= 1) return '';
  const qParam = q ? `&q=${encodeURIComponent(q)}` : '';
  const link = (p, label, disabled, active) => disabled
    ? `<span class="page-btn is-disabled">${label}</span>`
    : `<a href="/?page=${p}${qParam}" class="page-btn ${active ? 'is-current' : ''}">${label}</a>`;

  let numbers = '';
  for (let p = 1; p <= totalPages; p++) {
    numbers += link(p, String(p), false, p === page);
  }
  return `<nav class="pagination">
    ${link(page - 1, '← 上一页', page <= 1, false)}
    <span class="pagination-numbers">${numbers}</span>
    ${link(page + 1, '下一页 →', page >= totalPages, false)}
  </nav>`;
}

function homePage(posts, meta) {
  const { q = '', page = 1, totalPages = 1, total = 0 } = meta || {};
  const startIndex = (page - 1) * PAGE_SIZE;

  const cards = posts.length
    ? posts.map((p, i) => `
      <a href="/posts/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener" class="post-card tilt-${i % 3}">
        <span class="stamp">已发布</span>
        <div class="post-card-date">${fmtDate(p.pubDate)}</div>
        <h2 class="post-card-title">${escapeHtml(p.title)}</h2>
        <p class="post-card-desc">${escapeHtml(p.description || '')}</p>
        ${tagChips(p.tags)}
      </a>`).join('')
    : q
      ? `<div class="empty-state"><p>没搜到「${escapeHtml(q)}」相关的内容，换个词试试。</p></div>`
      : `<div class="empty-state"><p>信号还没接通。点右上角「+ 发新帖」写第一篇。</p></div>`;

  const body = `
  <section class="hero">
    <div class="hero-tag">PERSONAL BLOG / NO FILTER</div>
    <h1 class="hero-title">野蛮生长<span class="hero-dot">.</span></h1>
    <p class="hero-sub">Metamorphosis. Chegada's blog</p>
    <button type="button" class="btn btn-chaos" onclick="toggleChaos()">🎲 混乱模式</button>
  </section>

  <form class="search-bar" action="/" method="get" onsubmit="return handleSearchSubmit(event)">
    <input type="text" name="q" value="${escapeHtml(q)}" placeholder="搜索标题 / 标签 / 正文……" class="search-input" />
    <button type="submit" class="btn btn-search">🔍 搜索</button>
    ${q ? '<a href="/" class="btn btn-ghost">清空</a>' : ''}
  </form>
  ${q ? `<p class="search-meta">「${escapeHtml(q)}」共找到 ${total} 篇</p>` : ''}

  <section class="post-grid" id="post-grid">${cards}</section>
  ${paginationControls({ page, totalPages, q })}

  <script>
    var CHAOS_KEY = 'wildblog-chaos';

    function handleSearchSubmit(e) {
      var input = e.target.querySelector('input[name="q"]');
      if (!input.value.trim()) {
        e.preventDefault();
        window.location.href = '/';
        return false;
      }
      return true;
    }

    function applyChaos() {
      var grid = document.getElementById('post-grid');
      if (!grid) return;
      var colors = ['var(--pink)', 'var(--green)', 'var(--blue)', 'var(--yellow)'];
      grid.querySelectorAll('.post-card').forEach(function (card) {
        var rot = (Math.random() * 6 - 3).toFixed(2);
        var color = colors[Math.floor(Math.random() * colors.length)];
        card.style.transform = 'rotate(' + rot + 'deg)';
        card.style.setProperty('--shadow-color', color);
      });
    }

    function resetChaos() {
      var grid = document.getElementById('post-grid');
      if (!grid) return;
      grid.querySelectorAll('.post-card').forEach(function (card) {
        card.style.transform = '';
        card.style.removeProperty('--shadow-color');
      });
    }

    function toggleChaos() {
      if (sessionStorage.getItem(CHAOS_KEY) === '1') {
        sessionStorage.removeItem(CHAOS_KEY);
        resetChaos();
      } else {
        sessionStorage.setItem(CHAOS_KEY, '1');
        applyChaos();
      }
    }

    // Re-apply chaos mode automatically after any full page load
    // (search, pagination, etc.) if it was left switched on.
    if (sessionStorage.getItem(CHAOS_KEY) === '1') {
      applyChaos();
    }
  </script>`;
  return layout({ title: q ? `搜索 · ${q}` : '首页', body, active: 'home' });
}

function postPage(post) {
  const contentHtml = mdToHtml(post.content || '');
  const body = `
  <article class="post-detail">
    <a href="/" class="home-link" data-tooltip="返回首页">
      <svg viewBox="0 0 20 20" width="18" height="18"><path d="M3 10 L10 3 L17 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 9 V17 H15 V9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="8.3" y="12" width="3.4" height="5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
    </a>
    <div class="post-detail-meta">
      <time>${fmtDate(post.pubDate)}</time>
      ${tagChips(post.tags)}
    </div>
    <div class="post-title-row">
      <h1 class="post-detail-title">${escapeHtml(post.title)}</h1>
      <div class="post-actions">
        <a href="/edit/${encodeURIComponent(post.slug)}" class="btn btn-sm btn-edit" title="编辑">✎ 编辑</a>
        <button type="button" class="btn btn-sm btn-delete" title="删除" onclick="openDeletePanel()">🗑 删除</button>
      </div>
    </div>
    <p class="post-detail-desc">${escapeHtml(post.description || '')}</p>

    <div class="prose">${contentHtml}</div>
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
      <div class="editor-split-wrap">
        <div class="editor-split" id="editor-split">
          <div class="editor-pane" id="editor-pane-left">
            <label for="content-input">正文（支持 Markdown，含洛谷风格扩展）</label>
            <div class="editor-toolbar" role="toolbar" aria-label="格式工具栏">
              <button type="button" class="tb-btn" data-tooltip="加粗" data-tb="bold"><b>B</b></button>
              <button type="button" class="tb-btn" data-tooltip="斜体" data-tb="italic"><i>I</i></button>
              <button type="button" class="tb-btn" data-tooltip="删除线" data-tb="strike"><s>S</s></button>
              <button type="button" class="tb-btn" data-tooltip="行内代码" data-tb="inline-code">
                <svg viewBox="0 0 20 20" width="16" height="16"><polyline points="7,5 3,10 7,15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="13,5 17,10 13,15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <span class="tb-sep"></span>
              <button type="button" class="tb-btn" data-tooltip="数学公式" data-tb="math">
                <svg viewBox="0 0 20 20" width="16" height="16"><polyline points="2,11 5,14 8,4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="8" y1="4" x2="18" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
              <button type="button" class="tb-btn" data-tooltip="代码块" data-tb="code-block">
                <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="3" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><polyline points="5,8 8,10 5,12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><line x1="10" y1="12" x2="14" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
              </button>
              <span class="tb-sep"></span>
              <button type="button" class="tb-btn" data-tooltip="链接" data-tb="link">
                <svg viewBox="0 0 20 20" width="16" height="16"><path d="M8 12a3 3 0 0 1 0-4l2-2a3 3 0 0 1 4 4l-1 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 8a3 3 0 0 1 0 4l-2 2a3 3 0 0 1-4-4l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
              <button type="button" class="tb-btn" data-tooltip="图片" data-tb="image">
                <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="3" width="16" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="8" r="1.5" fill="currentColor"/><polyline points="3,15 8,10 12,13 17,7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button type="button" class="tb-btn" data-tooltip="表格" data-tb="table">
                <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="3" width="16" height="14" fill="none" stroke="currentColor" stroke-width="2"/><line x1="2" y1="8" x2="18" y2="8" stroke="currentColor" stroke-width="1.6"/><line x1="2" y1="13" x2="18" y2="13" stroke="currentColor" stroke-width="1.6"/><line x1="9" y1="3" x2="9" y2="17" stroke="currentColor" stroke-width="1.6"/></svg>
              </button>
              <span class="tb-sep"></span>
              <button type="button" class="tb-btn" data-tooltip="无序列表" data-tb="ul">
                <svg viewBox="0 0 20 20" width="16" height="16"><circle cx="3.5" cy="5" r="1.5" fill="currentColor"/><line x1="8" y1="5" x2="17" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.5" cy="10" r="1.5" fill="currentColor"/><line x1="8" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.5" cy="15" r="1.5" fill="currentColor"/><line x1="8" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
              <button type="button" class="tb-btn" data-tooltip="有序列表" data-tb="ol">
                <svg viewBox="0 0 20 20" width="16" height="16"><text x="0" y="7" font-size="6" fill="currentColor" font-family="monospace">1</text><line x1="8" y1="5" x2="17" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><text x="0" y="12" font-size="6" fill="currentColor" font-family="monospace">2</text><line x1="8" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><text x="0" y="17" font-size="6" fill="currentColor" font-family="monospace">3</text><line x1="8" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
              <button type="button" class="tb-btn" data-tooltip="任务列表" data-tb="task">
                <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><polyline points="3.5,6 5,7.5 8.5,3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="13" y1="4" x2="18" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="2" y="12" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="13" y1="15" x2="18" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
              <button type="button" class="tb-btn" data-tooltip="引用" data-tb="quote">
                <svg viewBox="0 0 20 20" width="16" height="16"><line x1="4" y1="3" x2="4" y2="17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line x1="9" y1="6" x2="17" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="14" x2="14" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
            </div>
            <div class="editor-source-wrap">
              <pre id="content-highlight" class="editor-highlight" aria-hidden="true"></pre>
              <textarea id="content-input" name="content" spellcheck="false" placeholder="## 小标题&#10;&#10;支持 **加粗**、*斜体*、\`代码\`、列表、> 引用、表格&#10;&#10;数学公式：行内 \$a^2+b^2=c^2\$，独立成行 \$\$\\sum_{i=1}^n i\$\$&#10;&#10;信息框：&#10;::::info[标题]&#10;内容&#10;::::&#10;（success / warning / error 同理，加 {open} 默认展开）&#10;&#10;居中：&#10;:::align{center}&#10;内容&#10;:::">${escapeHtml(p.content || '')}</textarea>
            </div>
          </div>
          <div class="editor-v-divider" id="editor-v-divider" role="separator" aria-orientation="vertical" aria-label="拖动调整左右宽度"></div>
          <div class="editor-pane" id="editor-pane-right">
            <label>实时预览</label>
            <div id="content-preview" class="prose editor-preview"></div>
          </div>
        </div>
        <div class="editor-h-divider" id="editor-h-divider" role="separator" aria-orientation="horizontal" aria-label="拖动调整高度"></div>
      </div>

      <div id="code-modal" class="delete-panel" hidden>
        <div class="delete-panel-inner code-modal-inner">
          <p class="delete-warning">插入代码块</p>
          <select id="code-lang" class="code-lang-select">
            <option value="cpp">C++</option>
            <option value="c">C</option>
            <option value="python">Python</option>
            <option value="java">Java</option>
            <option value="javascript">JavaScript</option>
            <option value="typescript">TypeScript</option>
            <option value="csharp">C#</option>
            <option value="go">Go</option>
            <option value="rust">Rust</option>
            <option value="html">HTML</option>
            <option value="css">CSS</option>
            <option value="sql">SQL</option>
            <option value="bash">Bash</option>
            <option value="plaintext">纯文本</option>
          </select>
          <textarea id="code-input" class="code-modal-textarea" rows="8" placeholder="粘贴代码……"></textarea>
          <div class="delete-panel-actions">
            <button type="button" class="btn btn-ghost" onclick="closeCodeModal()">取消</button>
            <button type="button" class="btn btn-save" onclick="confirmCodeInsert()">确定</button>
          </div>
        </div>
      </div>

      <div id="link-modal" class="delete-panel" hidden>
        <div class="delete-panel-inner code-modal-inner">
          <p class="delete-warning" id="link-modal-title">插入链接</p>
          <input type="text" id="link-name" class="code-lang-select" placeholder="链接名称" />
          <input type="text" id="link-url" class="code-lang-select" placeholder="https://" />
          <div class="delete-panel-actions">
            <button type="button" class="btn btn-ghost" onclick="closeLinkModal()">取消</button>
            <button type="button" class="btn btn-save" onclick="confirmLinkInsert()">确定</button>
          </div>
        </div>
      </div>

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
    // ── client-side markdown renderer (mirrors src/index.js mdToHtml) ──────
    // Kept in sync by hand so the live preview matches what the server will
    // actually render once published.
    (function () {
      function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }
      function normalizeUrl(url) {
        var trimmed = url.trim();
        if (/^(https?:|mailto:|tel:|data:|#|\\/)/i.test(trimmed)) return trimmed;
        return 'https://' + trimmed;
      }
      function inline(md) {
        return md
          .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
          .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
          .replace(/~~([^~]+)~~/g, '<del>$1</del>')
          .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
          .replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, function (m, alt, url) { return '<img src="' + normalizeUrl(url) + '" alt="' + alt + '">'; })
          .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function (m, text, url) { return '<a href="' + normalizeUrl(url) + '" target="_blank" rel="noopener">' + text + '</a>'; });
      }
      function splitTableRow(line) {
        var t = line.trim();
        if (t.indexOf('|') === 0) t = t.slice(1);
        if (t.slice(-1) === '|') t = t.slice(0, -1);
        return t.split('|').map(function (c) { return c.trim(); });
      }
      function tableAlign(sep) {
        var s = sep.trim();
        var left = s.indexOf(':') === 0;
        var right = s.slice(-1) === ':';
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      }
      function renderTable(headers, aligns, rows) {
        var out = '<table><thead><tr>';
        headers.forEach(function (h, i) {
          var a = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
          out += '<th' + a + '>' + inline(h) + '</th>';
        });
        out += '</tr></thead><tbody>';
        rows.forEach(function (row) {
          out += '<tr>';
          row.forEach(function (cell, i) {
            var a = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
            out += '<td' + a + '>' + inline(cell || '') + '</td>';
          });
          out += '</tr>';
        });
        out += '</tbody></table>';
        return out;
      }
      var TABLE_SEP_RE = /^\\s*\\|?(\\s*:?-{1,}:?\\s*\\|)*\\s*:?-{1,}:?\\s*\\|?\\s*$/;
      var CALLOUT_OPEN_RE = /^::::(info|success|warning|error)(?:\\[(.*?)\\])?(\\{open\\})?\\s*$/;
      var ALIGN_OPEN_RE = /^:::align\\{(\\w+)\\}\\s*$/;

      function renderLines(lines) {
        var html = '';
        var inCode = false;
        var listType = null;
        function closeList() { if (listType) { html += '</' + listType + '>'; listType = null; } }

        var i = 0;
        while (i < lines.length) {
          var raw = lines[i];
          if (raw.indexOf('\`\`\`') === 0) {
            if (!inCode) { closeList(); html += '<pre><code>'; inCode = true; }
            else { html += '</code></pre>'; inCode = false; }
            i++; continue;
          }
          if (inCode) { html += raw + '\\n'; i++; continue; }

          var line = raw;
          if (/^\\s*$/.test(line)) { closeList(); i++; continue; }

          var m;
          if ((m = line.match(CALLOUT_OPEN_RE))) {
            closeList();
            var type = m[1], title = m[2], openAttr = m[3] ? ' open' : '';
            var j = i + 1;
            while (j < lines.length && lines[j].trim() !== '::::') j++;
            var inner = renderLines(lines.slice(i + 1, j));
            var label = title ? inline(title) : type.toUpperCase();
            html += '<details class="callout callout-' + type + '"' + openAttr + '><summary>' + label + '</summary><div class="callout-body">' + inner + '</div></details>';
            i = j + 1; continue;
          }
          if ((m = line.match(ALIGN_OPEN_RE))) {
            closeList();
            var alignValue = m[1];
            var j2 = i + 1;
            while (j2 < lines.length && lines[j2].trim() !== ':::') j2++;
            var inner2 = renderLines(lines.slice(i + 1, j2));
            html += '<div class="md-align md-align-' + alignValue + '">' + inner2 + '</div>';
            i = j2 + 1; continue;
          }
          if (line.indexOf('|') !== -1 && lines[i + 1] && TABLE_SEP_RE.test(lines[i + 1])) {
            closeList();
            var headers = splitTableRow(line);
            var aligns = splitTableRow(lines[i + 1]).map(tableAlign);
            var j3 = i + 2;
            var rows = [];
            while (j3 < lines.length && lines[j3].indexOf('|') !== -1 && !/^\\s*$/.test(lines[j3])) {
              rows.push(splitTableRow(lines[j3]));
              j3++;
            }
            html += renderTable(headers, aligns, rows);
            i = j3; continue;
          }
          if ((m = line.match(/^(#{1,6})\\s+(.*)$/))) {
            closeList();
            var level = m[1].length;
            html += '<h' + level + '>' + inline(m[2]) + '</h' + level + '>';
            i++; continue;
          }
          if ((m = line.match(/^&gt;\\s?(.*)$/))) {
            closeList();
            html += '<blockquote><p>' + inline(m[1]) + '</p></blockquote>';
            i++; continue;
          }
          if ((m = line.match(/^[-*]\\s+(.*)$/))) {
            if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
            var task = m[1].match(/^\\[( |x|X)\\]\\s+(.*)$/);
            if (task) {
              var checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
              html += '<li class="task-item"><input type="checkbox" disabled' + checked + '> ' + inline(task[2]) + '</li>';
            } else {
              html += '<li>' + inline(m[1]) + '</li>';
            }
            i++; continue;
          }
          if ((m = line.match(/^\\d+\\.\\s+(.*)$/))) {
            if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
            html += '<li>' + inline(m[1]) + '</li>';
            i++; continue;
          }
          if (/^(-{3,}|\\*{3,})$/.test(line.trim())) {
            closeList();
            html += '<hr>';
            i++; continue;
          }
          closeList();
          html += '<p>' + inline(line) + '</p>';
          i++;
        }
        closeList();
        if (inCode) html += '</code></pre>';
        return html;
      }

      function mdToHtml(md) {
        return renderLines(escapeHtml(md).split('\\n'));
      }

      var textarea = document.getElementById('content-input');
      var preview = document.getElementById('content-preview');
      var highlight = document.getElementById('content-highlight');

      // ── source-pane syntax highlighting ──────────────────────────────
      // Wraps recognized markdown tokens in colored spans so the left
      // editor itself shows, e.g., that "# p" is a real heading (space
      // after #) while "#p" is not (no space) — same distinction Luogu's
      // editor shows, and similarly for valid vs sloppy $...$ math.
      function wrap(cls, text) { return '<span class="' + cls + '">' + text + '</span>'; }

      function highlightLine(rawLine) {
        var line = escapeHtml(rawLine);

        // heading marker: "#"×1-6 followed by whitespace = valid
        if (/^#{1,6}\\s/.test(line)) {
          line = line.replace(/^(#{1,6}\\s+)/, function (m) { return wrap('hl-marker', m); });
        } else if (/^#{1,6}(?!#)/.test(line)) {
          // "#" at line start with no following space = not a real heading
          line = line.replace(/^(#{1,6})/, function (m) { return wrap('hl-invalid', m); });
        }

        // blockquote / list markers
        line = line.replace(/^(&gt;\\s?)/, function (m) { return wrap('hl-marker', m); });
        line = line.replace(/^([-*]\\s+)/, function (m) { return wrap('hl-marker', m); });
        line = line.replace(/^(\\d+\\.\\s+)/, function (m) { return wrap('hl-marker', m); });

        // math: display $$...$$ or inline $...$ (no space right after opening
        // $ or right before closing $, so "$ $" doesn't count) — one combined
        // pass so display math isn't re-matched by the inline rule afterward
        line = line.replace(/\\$\\$[^$]*?\\$\\$|\\$(?!\\s)[^$]*?(?<!\\s)\\$/g, function (m) { return wrap('hl-math', m); });

        // bold / italic / inline code markers
        line = line.replace(/\\*\\*[^*]+\\*\\*/g, function (m) { return wrap('hl-marker', m); });
        line = line.replace(/(?<!\\*)\\*[^*]+\\*(?!\\*)/g, function (m) { return wrap('hl-marker', m); });
        line = line.replace(/\`[^\`]+\`/g, function (m) { return wrap('hl-code', m); });

        return line || '\\n';
      }
      function updateHighlight() {
        var lines = textarea.value.split('\\n');
        highlight.innerHTML = lines.map(highlightLine).join('\\n');
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
      }

      textarea.addEventListener('scroll', function () {
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
      });

      function updatePreview() {
        preview.innerHTML = mdToHtml(textarea.value || '');
        if (window.renderMathInElement) {
          renderMathInElement(preview, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$', right: '$', display: false }
            ],
            throwOnError: false
          });
        }
      }

      textarea.addEventListener('input', updatePreview);
      textarea.addEventListener('input', updateHighlight);
      updatePreview();
      updateHighlight();
      // KaTeX loads via deferred <script> tags in <head>, so it may not be
      // ready yet at this point — re-render once more after it finishes.
      document.addEventListener('DOMContentLoaded', updatePreview);

      // ── toolbar: insert/wrap markdown at the cursor ─────────────────────
      // Uses document.execCommand('insertText', ...) rather than setting
      // textarea.value directly — direct .value assignment wipes the
      // browser's native undo history, so Ctrl+Z would stop working after
      // any toolbar click. execCommand keeps it intact. Falls back to
      // direct assignment only if execCommand is unavailable.
      function refresh() {
        textarea.dispatchEvent(new Event('input'));
      }

      function insertAtSelection(text) {
        textarea.focus();
        var ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
        if (!ok) {
          var start = textarea.selectionStart, end = textarea.selectionEnd;
          var value = textarea.value;
          textarea.value = value.slice(0, start) + text + value.slice(end);
          textarea.setSelectionRange(start + text.length, start + text.length);
        }
        refresh();
      }

      function wrapSelection(before, after, placeholder) {
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        var selected = textarea.value.slice(start, end) || placeholder || '';
        insertAtSelection(before + selected + after);
        var selStart = start + before.length;
        var selEnd = selStart + selected.length;
        textarea.setSelectionRange(selStart, selEnd);
      }

      function insertBlock(text) {
        var start = textarea.selectionStart;
        var value = textarea.value;
        var needsLeadingNewline = start > 0 && value[start - 1] !== '\\n';
        insertAtSelection((needsLeadingNewline ? '\\n' : '') + text);
      }

      function prefixLines(prefixFn) {
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        var value = textarea.value;
        var lineStart = value.lastIndexOf('\\n', start - 1) + 1;
        var lineEnd = value.indexOf('\\n', end);
        if (lineEnd === -1) lineEnd = value.length;
        var block = value.slice(lineStart, lineEnd);
        var newBlock = block.split('\\n').map(prefixFn).join('\\n');
        textarea.setSelectionRange(lineStart, lineEnd);
        insertAtSelection(newBlock);
        textarea.setSelectionRange(lineStart, lineStart + newBlock.length);
      }

      var TOOLBAR_ACTIONS = {
        'bold': function () { wrapSelection('**', '**', '加粗文字'); },
        'italic': function () { wrapSelection('*', '*', '斜体文字'); },
        'strike': function () { wrapSelection('~~', '~~', '删除线文字'); },
        'inline-code': function () { wrapSelection('\`', '\`', 'code'); },
        'math': function () { wrapSelection('$$', '$$', ''); },
        'code-block': function () { openCodeModal(); },
        'link': function () { openLinkModal(false); },
        'image': function () { openLinkModal(true); },
        'table': function () { insertBlock('| 列1 | 列2 |\\n|:---|:---:|\\n| 内容 | 内容 |\\n'); },
        'ul': function () { prefixLines(function (l) { return '- ' + l; }); },
        'ol': function () { prefixLines(function (l, i) { return (i + 1) + '. ' + l; }); },
        'task': function () { prefixLines(function (l) { return '- [ ] ' + l; }); },
        'quote': function () { prefixLines(function (l) { return '> ' + l; }); },
      };

      document.querySelectorAll('.tb-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var action = TOOLBAR_ACTIONS[btn.dataset.tb];
          if (action) action();
        });
      });

      // ── code-block modal ─────────────────────────────────────────────
      function openCodeModal() {
        document.getElementById('code-input').value = '';
        document.getElementById('code-modal').hidden = false;
        document.getElementById('code-input').focus();
      }
      function closeCodeModal() {
        document.getElementById('code-modal').hidden = true;
      }
      function confirmCodeInsert() {
        var lang = document.getElementById('code-lang').value;
        var code = document.getElementById('code-input').value;
        insertBlock('\`\`\`' + lang + '\\n' + code + '\\n\`\`\`\\n');
        closeCodeModal();
      }
      window.openCodeModal = openCodeModal;
      window.closeCodeModal = closeCodeModal;
      window.confirmCodeInsert = confirmCodeInsert;

      // ── link / image modal ───────────────────────────────────────────
      var linkModalIsImage = false;
      function openLinkModal(isImage) {
        linkModalIsImage = isImage;
        document.getElementById('link-modal-title').textContent = isImage ? '插入图片' : '插入链接';
        document.getElementById('link-name').placeholder = isImage ? '图片描述' : '链接名称';
        document.getElementById('link-url').placeholder = isImage ? 'https://，或直接粘贴剪贴板图片（Ctrl+V）' : 'https://';
        document.getElementById('link-name').value = '';
        document.getElementById('link-url').value = '';
        document.getElementById('link-modal').hidden = false;
        document.getElementById('link-name').focus();
      }
      function closeLinkModal() {
        document.getElementById('link-modal').hidden = true;
      }
      function confirmLinkInsert() {
        var name = document.getElementById('link-name').value || (linkModalIsImage ? '图片描述' : '链接文字');
        var url = document.getElementById('link-url').value || 'https://';
        var prefix = linkModalIsImage ? '![' : '[';
        insertAtSelection(prefix + name + '](' + url + ')');
        closeLinkModal();
      }
      window.openLinkModal = openLinkModal;
      window.closeLinkModal = closeLinkModal;
      window.confirmLinkInsert = confirmLinkInsert;

      // Resize + re-encode a pasted image so the resulting data URI stays
      // small — a raw pasted screenshot can easily be several MB; capping
      // the longest side at 1200px and encoding as JPEG (quality 0.82)
      // typically shrinks it by 5-20x with barely noticeable quality loss.
      function compressImageFile(file, callback) {
        var reader = new FileReader();
        reader.onload = function (e) {
          var img = new Image();
          img.onload = function () {
            var maxDim = 1200;
            var w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
              if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
              else { w = Math.round(w * maxDim / h); h = maxDim; }
            }
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            var ctx = canvas.getContext('2d');
            // white background first, since JPEG has no transparency —
            // pasted screenshots are almost always opaque anyway
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            callback(canvas.toDataURL('image/jpeg', 0.82));
          };
          img.onerror = function () { callback(e.target.result); }; // fallback: use the raw file
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      }

      // paste an image from the clipboard straight into the URL field —
      // compresses it and converts it to a data URI so no separate image
      // host is needed
      var linkUrlInput = document.getElementById('link-url');
      if (linkUrlInput) {
        linkUrlInput.addEventListener('paste', function (e) {
          var cd = e.clipboardData || window.clipboardData;
          if (!cd || !cd.items) return;
          for (var i = 0; i < cd.items.length; i++) {
            if (cd.items[i].type && cd.items[i].type.indexOf('image') !== -1) {
              var blob = cd.items[i].getAsFile();
              if (!blob) continue;
              e.preventDefault();
              linkUrlInput.value = '压缩中…';
              compressImageFile(blob, function (dataUrl) {
                linkUrlInput.value = dataUrl;
              });
              break;
            }
          }
        });
      }

      // ── resizable panes: drag the vertical divider to change the
      // left/right width ratio, drag the horizontal one to change height ──
      (function () {
        var split = document.getElementById('editor-split');
        var vDivider = document.getElementById('editor-v-divider');
        var hDivider = document.getElementById('editor-h-divider');
        var paneLeft = document.getElementById('editor-pane-left');
        var paneRight = document.getElementById('editor-pane-right');
        var sourceWrap = document.querySelector('.editor-source-wrap');
        var previewEl = document.getElementById('content-preview');
        if (!split || !vDivider || !hDivider) return;

        var draggingV = false;
        vDivider.addEventListener('mousedown', function (e) {
          draggingV = true;
          vDivider.classList.add('is-dragging');
          document.body.classList.add('is-col-resizing');
          e.preventDefault();
        });

        var draggingH = false;
        var startY = 0, startHeight = 0;
        hDivider.addEventListener('mousedown', function (e) {
          draggingH = true;
          startY = e.clientY;
          startHeight = sourceWrap.getBoundingClientRect().height;
          hDivider.classList.add('is-dragging');
          document.body.classList.add('is-row-resizing');
          e.preventDefault();
        });

        window.addEventListener('mousemove', function (e) {
          if (draggingV) {
            var rect = split.getBoundingClientRect();
            var pct = ((e.clientX - rect.left) / rect.width) * 100;
            pct = Math.max(20, Math.min(80, pct));
            paneLeft.style.flex = '0 0 ' + pct + '%';
            paneRight.style.flex = '1 1 0';
          }
          if (draggingH) {
            var delta = e.clientY - startY;
            var newHeight = Math.max(220, startHeight + delta);
            sourceWrap.style.height = newHeight + 'px';
            if (previewEl) previewEl.style.height = newHeight + 'px';
          }
        });

        window.addEventListener('mouseup', function () {
          if (draggingV) {
            draggingV = false;
            vDivider.classList.remove('is-dragging');
            document.body.classList.remove('is-col-resizing');
          }
          if (draggingH) {
            draggingH = false;
            hDivider.classList.remove('is-dragging');
            document.body.classList.remove('is-row-resizing');
          }
        });
      })();
    })();
  </script>

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
// Cloudflare KV's list() operation is only *eventually* consistent, so a
// freshly-created post can be briefly invisible in listPosts() if we relied
// on list(). Individual get()/put() calls, however, are strongly consistent.
// To avoid that lag, we maintain our own index — a single KV key holding a
// JSON array of slugs — and always read/write it with get()/put(), never
// list().
const INDEX_KEY = 'index';

async function getIndex(env) {
  const raw = await env.POSTS.get(INDEX_KEY, 'json');
  return Array.isArray(raw) ? raw : [];
}

async function addToIndex(env, slug) {
  const slugs = await getIndex(env);
  if (!slugs.includes(slug)) {
    slugs.push(slug);
    await env.POSTS.put(INDEX_KEY, JSON.stringify(slugs));
  }
}

async function removeFromIndex(env, slug) {
  const slugs = await getIndex(env);
  const next = slugs.filter((s) => s !== slug);
  if (next.length !== slugs.length) {
    await env.POSTS.put(INDEX_KEY, JSON.stringify(next));
  }
}

async function listPosts(env) {
  const slugs = await getIndex(env);
  const posts = await Promise.all(slugs.map((slug) => getPost(env, slug)));
  return posts
    .filter(Boolean)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

async function getPost(env, slug) {
  return env.POSTS.get(`post:${slug}`, 'json');
}

async function savePost(env, slug, data) {
  await env.POSTS.put(`post:${slug}`, JSON.stringify(data));
  await addToIndex(env, slug);
}

async function deletePost(env, slug) {
  await env.POSTS.delete(`post:${slug}`);
  await removeFromIndex(env, slug);
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
        const q = url.searchParams.get('q') || '';
        let posts = await listPosts(env);
        if (q.trim()) posts = searchPosts(posts, q);

        const total = posts.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const requestedPage = parseInt(url.searchParams.get('page') || '1', 10) || 1;
        const page = Math.min(Math.max(1, requestedPage), totalPages);
        const pagePosts = posts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

        return html(homePage(pagePosts, { q, page, totalPages, total }));
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
