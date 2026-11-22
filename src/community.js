const PAGE_SIZE = 20;
const USERNAME = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/;
const RECORD_ID = /^[a-f0-9]{24}$/;
const RECEIPT = /^[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/;
const BOARDS = new Map([
  ['general', '综合讨论'], ['problems', '题目讨论'], ['announcements', '站务公告'],
]);

const schema = [
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activity_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, activity INTEGER NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
    author TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS activity_replies_activity ON activity_replies(activity, id)',
  `CREATE TABLE IF NOT EXISTS activity_likes (
    activity INTEGER NOT NULL REFERENCES activity(id) ON DELETE CASCADE, actor TEXT NOT NULL, PRIMARY KEY (activity, actor)
  )`,
  `CREATE TABLE IF NOT EXISTS follows (
    actor TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (actor, target)
  )`,
  'CREATE INDEX IF NOT EXISTS follows_target ON follows(target)',
  `CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, author TEXT NOT NULL, name TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, latest INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS topics_board ON topics(board, pinned DESC, latest DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS topics_latest ON topics(pinned DESC, latest DESC, id DESC)',
  `CREATE TABLE IF NOT EXISTS topic_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, topic INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    author TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS topic_replies_topic ON topic_replies(topic, id)',
];

const inboxSchema = [
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, sender_name TEXT NOT NULL,
    recipient_name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender, recipient, id)',
  'CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, sender, id)',
];

const recordsSchema = [
  `CREATE TABLE IF NOT EXISTS records (
    rid TEXT PRIMARY KEY, problem TEXT NOT NULL, owner TEXT NOT NULL, account_date TEXT NOT NULL,
    name TEXT NOT NULL, receipt TEXT NOT NULL, at INTEGER NOT NULL, status INTEGER,
    verdict TEXT, score REAL, language TEXT, time_ms REAL, memory_kib REAL
  )`,
  'CREATE INDEX IF NOT EXISTS records_problem ON records(problem, at DESC, rid DESC)',
];

class CommunityError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function scope(account) {
  return JSON.stringify([account.key, account.createdAt || '']);
}

function identity(user) {
  return user ? { id: scope(user), name: user.username, admin: user.role === 'admin' || user.isRootAdmin === true } : null;
}

function requireMember(actor) {
  if (!actor) throw new CommunityError('请先登录。', 401);
  return actor;
}

function requireAdmin(actor) {
  if (!requireMember(actor).admin) throw new CommunityError('只有管理员可以执行此操作。', 403);
}

function canEdit(actor, row) {
  return actor && (actor.admin || actor.id === row.author);
}

function itemId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new CommunityError('记录不存在。', 404);
  return id;
}

function input(value, max, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > max) throw new CommunityError(label + '应为 1 至 ' + max + ' 个字符。');
  return result;
}

function pageNumber(value) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? Math.min(500, page) : 1;
}

function paginate(rows) {
  return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
}

export class CommunityStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
  }

  async fetch(request) {
    const [, area, action] = new URL(request.url).pathname.split('/');
    const args = await request.json();
    try {
      if (area === 'records') {
        this.initialize(recordsSchema);
        return Response.json(await this.records(action, args));
      }
      if (area === 'messages') {
        this.initialize(inboxSchema);
        return Response.json(this.messages(action, args));
      }
      this.initialize(schema);
      return Response.json(this.community(action, args));
    } catch (error) {
      if (!(error instanceof CommunityError)) throw error;
      return Response.json({ error: error.message }, { status: error.status });
    }
  }

  initialize(statements) {
    if (this.initialized) return;
    this.ctx.storage.transactionSync(() => {
      for (const statement of statements) this.sql.exec(statement);
    });
    this.initialized = true;
  }

  rows(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  row(query, ...params) {
    return this.rows(query, ...params)[0];
  }

  community(action, args) {
    const { actor, target } = args;
    const offset = (pageNumber(args.page) - 1) * PAGE_SIZE;
    switch (action) {
      case 'feed': {
        const viewer = actor?.id ?? '';
        const following = Boolean(args.following && actor);
        const entries = this.rows(`SELECT a.*,
          (SELECT count(*) FROM activity_likes WHERE activity = a.id) AS likes,
          EXISTS(SELECT 1 FROM activity_likes WHERE activity = a.id AND actor = ?) AS liked,
          (SELECT count(*) FROM activity_replies WHERE activity = a.id) AS replies
          FROM activity a
          WHERE ? = 0 OR a.author = ? OR a.author IN (SELECT target FROM follows WHERE actor = ?)
          ORDER BY a.id DESC LIMIT ? OFFSET ?`, viewer, Number(following), viewer, viewer, PAGE_SIZE + 1, offset);
        return paginate(entries);
      }
      case 'activity': {
        const id = itemId(args.id);
        const activity = this.row(`SELECT a.*, (SELECT count(*) FROM activity_likes WHERE activity = a.id) AS likes,
          EXISTS(SELECT 1 FROM activity_likes WHERE activity = a.id AND actor = ?) AS liked FROM activity a WHERE id = ?`,
          actor?.id ?? '', id);
        if (!activity) throw new CommunityError('这条犇犇已不存在。', 404);
        return { activity, ...paginate(this.rows('SELECT * FROM activity_replies WHERE activity = ? ORDER BY id LIMIT ? OFFSET ?', id, PAGE_SIZE + 1, offset)) };
      }
      case 'profile': {
        const id = target.id;
        return this.row(`SELECT
          (SELECT count(*) FROM follows WHERE actor = ?) AS following,
          (SELECT count(*) FROM follows WHERE target = ?) AS followers,
          EXISTS(SELECT 1 FROM follows WHERE actor = ? AND target = ?) AS followed`,
          id, id, actor?.id ?? '', id);
      }
      case 'topics': {
        const board = BOARDS.has(args.board) ? args.board : '';
        const filter = board ? 'WHERE t.board = ?' : '';
        return paginate(this.rows(`SELECT t.id, t.board, t.author, t.name, t.title, t.at, t.pinned, t.latest,
          (SELECT count(*) FROM topic_replies WHERE topic = t.id) AS replies
          FROM topics t ${filter} ORDER BY t.pinned DESC, t.latest DESC, t.id DESC LIMIT ? OFFSET ?`,
          ...(board ? [board] : []), PAGE_SIZE + 1, offset));
      }
      case 'topic': {
        const id = itemId(args.id);
        const topic = this.row('SELECT * FROM topics WHERE id = ?', id);
        if (!topic) throw new CommunityError('帖子不存在。', 404);
        return { topic, ...paginate(this.rows('SELECT * FROM topic_replies WHERE topic = ? ORDER BY id LIMIT ? OFFSET ?', id, PAGE_SIZE + 1, offset)) };
      }
    }
    const { id, name } = requireMember(actor);
    const now = Date.now();
    switch (action) {
      case 'post-activity':
        return this.row('INSERT INTO activity (author, name, body, at) VALUES (?, ?, ?, ?) RETURNING id',
          id, name, input(args.body, 500, '动态'), now);
      case 'follow':
        if (!target || id === target.id) throw new CommunityError('请选择其他用户。');
        if (args.enabled) this.sql.exec('INSERT OR IGNORE INTO follows (actor, target) VALUES (?, ?)', id, target.id);
        else this.sql.exec('DELETE FROM follows WHERE actor = ? AND target = ?', id, target.id);
        return {};
      case 'like': {
        const activity = itemId(args.id);
        if (!this.row('SELECT id FROM activity WHERE id = ?', activity)) throw new CommunityError('这条犇犇已不存在。', 404);
        if (args.enabled) this.sql.exec('INSERT OR IGNORE INTO activity_likes (activity, actor) VALUES (?, ?)', activity, id);
        else this.sql.exec('DELETE FROM activity_likes WHERE activity = ? AND actor = ?', activity, id);
        return {};
      }
      case 'reply-activity': {
        const activity = itemId(args.id);
        if (!this.row('SELECT id FROM activity WHERE id = ?', activity)) throw new CommunityError('这条犇犇已不存在。', 404);
        this.sql.exec('INSERT INTO activity_replies (activity, author, name, body, at) VALUES (?, ?, ?, ?, ?)',
          activity, id, name, input(args.body, 500, '回复'), now);
        return {};
      }
      case 'delete-activity':
        return this.remove('activity', itemId(args.id), actor);
      case 'post-topic': {
        if (!BOARDS.has(args.board)) throw new CommunityError('请选择讨论板块。');
        if (args.board === 'announcements') requireAdmin(actor);
        return this.row(`INSERT INTO topics (board, author, name, title, body, at, latest)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, args.board, id, name, input(args.title, 100, '标题'), input(args.body, 6000, '正文'), now, now);
      }
      case 'reply-topic': {
        const topic = itemId(args.id);
        const body = input(args.body, 2000, '回复');
        this.ctx.storage.transactionSync(() => {
          if (!this.row('SELECT id FROM topics WHERE id = ?', topic)) throw new CommunityError('帖子不存在。', 404);
          this.sql.exec('INSERT INTO topic_replies (topic, author, name, body, at) VALUES (?, ?, ?, ?, ?)', topic, id, name, body, now);
          this.sql.exec('UPDATE topics SET latest = ? WHERE id = ?', now, topic);
        });
        return {};
      }
      case 'pin':
        requireAdmin(actor);
        if (!this.row('UPDATE topics SET pinned = ? WHERE id = ? RETURNING id', Number(Boolean(args.enabled)), itemId(args.id))) {
          throw new CommunityError('帖子不存在。', 404);
        }
        return {};
      case 'delete-topic':
        return this.remove('topics', itemId(args.id), actor);
      default:
        throw new CommunityError('操作不存在。', 404);
    }
  }

  remove(table, id, actor) {
    const row = this.row(`SELECT author FROM ${table} WHERE id = ?`, id);
    if (!row) throw new CommunityError('记录不存在。', 404);
    if (!canEdit(actor, row)) throw new CommunityError('没有删除权限。', 403);
    this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, id);
    return {};
  }

  messages(action, { actor, target, body, page }) {
    const { id, name } = requireMember(actor);
    const offset = (pageNumber(page) - 1) * PAGE_SIZE;
    if (action === 'inbox') {
      return paginate(this.rows(`WITH related AS (
        SELECT id, recipient AS peer FROM messages WHERE sender = ?
        UNION ALL SELECT id, sender AS peer FROM messages WHERE recipient = ?
      ), latest AS (SELECT max(id) AS id FROM related GROUP BY peer)
      SELECT m.id, m.at, m.body, CASE WHEN m.sender = ? THEN m.recipient_name ELSE m.sender_name END AS name
      FROM latest l JOIN messages m ON m.id = l.id ORDER BY m.id DESC LIMIT ? OFFSET ?`,
      id, id, id, PAGE_SIZE + 1, offset));
    }
    if (!target || id === target.id) throw new CommunityError('请选择其他用户。');
    if (action === 'thread') {
      return paginate(this.rows(`SELECT id, sender_name AS name, body, at, sender = ? AS mine
        FROM messages WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
        ORDER BY id DESC LIMIT ? OFFSET ?`, id, id, target.id, target.id, id, PAGE_SIZE + 1, offset));
    }
    if (action !== 'send') throw new CommunityError('操作不存在。', 404);
    this.sql.exec('INSERT INTO messages (sender, recipient, sender_name, recipient_name, body, at) VALUES (?, ?, ?, ?, ?, ?)',
      id, target.id, name, target.name, input(body, 2000, '私信'), Date.now());
    return {};
  }

  insertRecord(row) {
    this.sql.exec(`INSERT INTO records (rid, problem, owner, account_date, name, receipt, at, status, verdict, score, language, time_ms, memory_kib)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (rid) DO UPDATE SET
        status = coalesce(excluded.status, records.status), verdict = coalesce(excluded.verdict, records.verdict),
        score = coalesce(excluded.score, records.score), language = coalesce(excluded.language, records.language),
        time_ms = coalesce(excluded.time_ms, records.time_ms), memory_kib = coalesce(excluded.memory_kib, records.memory_kib)
      WHERE records.owner = excluded.owner AND records.account_date = excluded.account_date AND records.problem = excluded.problem
        AND (records.status IS NULL OR records.status IN (0,20,21,22) OR excluded.status NOT IN (0,20,21,22))`,
      row.rid, row.problem, row.owner, row.accountDate, row.name, row.receipt, row.at,
      row.status ?? null, row.verdict ?? null, row.score ?? null, row.language ?? null, row.timeMs ?? null, row.memoryKiB ?? null);
  }

  async importRecords() {
    const state = this.ctx.storage.kv.get('record-import');
    if (state === true) return;
    if (this.importing) return this.importing;
    this.importing = this.importRecordPage(state);
    try { await this.importing; }
    finally { this.importing = null; }
  }

  async importRecordPage(cursor) {
    const prefix = 'judge-history:';
    const { keys, list_complete, cursor: next } = await this.env.POSTS.list({ prefix, limit: 75, ...(cursor ? { cursor } : {}) });
    const rows = [];
    for (const key of keys) {
      const match = /^judge-history:([^:]+):(.*):([A-Z0-9]+):\d{13}:([a-f0-9]{24})$/.exec(key.name);
      const receipt = key.metadata?.receipt;
      if (!match || !RECEIPT.test(receipt || '')) continue;
      const [, owner, accountDate, problem, rid] = match;
      if (rid !== receipt.slice(0, 24)) continue;
      rows.push({ owner, accountDate, problem, rid, receipt, name: owner,
        at: parseInt(rid.slice(0, 8), 16) * 1000,
        resultKey: 'judge-result:' + owner + ':' + accountDate + ':' + problem + ':' + rid });
    }
    const summaries = rows.length ? await this.env.POSTS.get(rows.map(row => row.resultKey), 'json') : new Map();
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        const result = summaries.get(row.resultKey);
        this.sql.exec(`INSERT OR IGNORE INTO records (rid, problem, owner, account_date, name, receipt, at, status, verdict, score, language)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.rid, row.problem, row.owner, row.accountDate, row.name,
          row.receipt, row.at, result?.status ?? null, result?.verdict ?? null, result?.score ?? null, result?.language ?? null);
      }
      this.ctx.storage.kv.put('record-import', list_complete ? true : next);
    });
  }

  async records(action, args) {
    if (action === 'save') {
      this.insertRecord(args);
      return {};
    }
    if (!this.importRetryAt || Date.now() >= this.importRetryAt) {
      try { await this.importRecords(); }
      catch (error) {
        this.importRetryAt = Date.now() + 60000;
        console.warn('Unable to import legacy submission history', error?.message);
      }
    }
    const visible = 'rid, owner, name, at, status, verdict, score, language, time_ms, memory_kib';
    if (action === 'list') {
      return paginate(this.rows(`SELECT ${visible} FROM records WHERE problem = ? ORDER BY at DESC, rid DESC LIMIT ? OFFSET ?`,
        args.problem, PAGE_SIZE + 1, (pageNumber(args.page) - 1) * PAGE_SIZE));
    }
    if (action !== 'record') throw new CommunityError('操作不存在。', 404);
    const row = this.row(`SELECT ${visible}, account_date, receipt FROM records WHERE problem = ? AND rid = ?`, args.problem, args.rid);
    if (!row) throw new CommunityError('提交记录不存在。', 404);
    const { receipt, account_date, ...result } = row;
    const owner = scope({ key: row.owner, createdAt: account_date });
    return args.actor && (args.actor.admin || args.actor.id === owner)
      ? { ...result, receipt, accountDate: account_date }
      : result;
  }
}

async function callStore(env, area, action, args) {
  const binding = env.COMMUNITY_STORE;
  if (!binding) throw new CommunityError('社区功能正在发布，请稍后再试。', 503);
  const stub = binding.get(binding.idFromName(area));
  const response = await stub.fetch('https://community.internal/' + area + '/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const result = await response.json();
  if (!response.ok) throw new CommunityError(result.error || '暂时无法完成此操作。', response.status);
  return result;
}

export async function saveCommunityRecord(env, user, problem, receipt, result = {}) {
  if (!env.COMMUNITY_STORE) return;
  const rid = receipt.slice(0, 24);
  const { status, verdict, score, language, timeMs, memoryKiB } = result;
  try {
    await callStore(env, 'records', 'save', {
      rid, problem, owner: user.key, name: user.username, accountDate: user.createdAt || '', receipt,
      at: parseInt(rid.slice(0, 8), 16) * 1000, status, verdict, score, language, timeMs, memoryKiB,
    });
  } catch (error) {
    console.warn('Unable to index submission', error?.message);
  }
}

const htmlEscape = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);
const userPath = (name) => '/users/' + encodeURIComponent(name);
const chatPath = (name) => '/messages/' + encodeURIComponent(name);
const topicPath = (id) => '/discuss/' + id;
const activityPath = (id) => '/benben/' + id;
const threadLink = (name) => '<a href="' + userPath(name) + '">' + htmlEscape(name) + '</a>';
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short',
});

function date(timestamp) {
  const d = new Date(timestamp);
  return '<time datetime="' + d.toISOString() + '">' + timeFormat.format(d) + '</time>';
}

function selected(active, href, text) {
  return '<a href="' + href + '"' + (active ? ' aria-current="page"' : '') + '>' + text + '</a>';
}

function pageLinks(url, page, more) {
  if (page === 1 && !more) return '';
  const href = (index) => htmlEscape(url + (url.includes('?') ? '&' : '?') + 'page=' + index);
  return `<nav class="community-pages" aria-label="分页">
    ${page > 1 ? `<a href="${href(page - 1)}">上一页</a>` : ''}
    <span>第 ${page} 页</span>
    ${more && page < 500 ? `<a href="${href(page + 1)}">下一页</a>` : ''}
  </nav>`;
}

function actionForm(url, text, enabled) {
  return `<form method="post" action="${htmlEscape(url)}" class="community-action">
    ${enabled === undefined ? '' : `<input type="hidden" name="enabled" value="${enabled ? '1' : '0'}">`}
    <button type="submit" class="community-button community-button-quiet">${text}</button>
  </form>`;
}

function writeForm(url, text, label, length) {
  return `<form method="post" action="${htmlEscape(url)}" class="community-compose">
    <label>${label}<textarea name="body" required maxlength="${length}" rows="3"></textarea></label>
    <button type="submit" class="community-button">${text}</button>
  </form>`;
}

async function namesFor(env, rows, tools) {
  return tools.getPublicAuthors(env, rows.map(row => row.name));
}

function postByline(row, accounts, tools) {
  return `<div class="community-byline">${tools.authorName(row.name, accounts)}${date(row.at)}</div>`;
}

function feedCard(row, accounts, tools, actor, individual = false) {
  const path = activityPath(row.id);
  const returnTo = individual ? '?thread=1' : '';
  return `<article class="community-card">
    ${postByline(row, accounts, tools)}
    <p class="community-text">${htmlEscape(row.body)}</p>
    <div class="community-actions">
      ${individual ? '' : `<a href="${path}">回复 <span>${row.replies}</span></a>`}
      ${actor ? actionForm(path + '/like' + returnTo, (row.liked ? '已赞 ' : '赞 ') + row.likes, !row.liked) : `<span>${row.likes} 赞</span>`}
      ${canEdit(actor, row) ? actionForm(path + '/delete', '删除') : ''}
    </div>
  </article>`;
}

function communityPage(tools, user, title, active, body, aside = '') {
  return tools.html(tools.layout({ user, title, active, community: true, body: `
    <div class="community-layout${aside ? ' has-aside' : ''}">
      <div class="community-main">${body}</div>${aside ? `<aside class="community-sidebar">${aside}</aside>` : ''}
    </div>` }));
}

function heading(title, actions = '') {
  return `<header class="community-heading"><h1>${htmlEscape(title)}</h1>${actions}</header>`;
}

function loginLine(action) {
  return `<div class="community-card community-empty"><a href="/login">登录</a>后可以${action}。</div>`;
}

async function renderFeed(env, user, actor, url, page, tools) {
  const following = Boolean(actor && url.searchParams.get('view') === 'following');
  const data = await callStore(env, 'social', 'feed', { actor, following, page });
  const accounts = await namesFor(env, data.rows, tools);
  const path = following ? '/?view=following' : '/';
  const tabs = `<nav class="community-tabs" aria-label="动态筛选">
    ${selected(!following, '/', '全站动态')}${actor ? selected(following, '/?view=following', '我关注的') : ''}
  </nav>`;
  const aside = `<div class="community-card community-sidebar-card">
    <h2>社区</h2>
    ${[ ['/discuss', '讨论区'], ['/members', '找用户'], ['/problems', '题库'], ['/articles', '全部文章'],
      ...(user ? [['/my/articles', '我的文章'], ['/messages', '私信']] : [])].map(([href, text]) => selected(false, href, text)).join('')}
  </div>`;
  const empty = following ? '还没有关注用户的动态。' : '还没有犇犇，来发第一条动态吧。';
  return communityPage(tools, user, '犇犇', 'home', [
    heading('犇犇'), tabs,
    actor ? `<section class="community-card">${writeForm('/benben', '发布犇犇', '说点什么', 500)}</section>` : loginLine('发布犇犇'),
    data.rows.length ? data.rows.map(row => feedCard(row, accounts, tools, actor)).join('') : `<div class="community-card community-empty">${empty}</div>`,
    pageLinks(path, page, data.more),
  ].join(''), aside);
}

function renderReplies(rows, accounts, tools, empty = '还没有回复。') {
  if (!rows.length) return `<p class="community-empty">${empty}</p>`;
  return rows.map(row => `<article class="community-reply">${postByline(row, accounts, tools)}
    <p class="community-text">${htmlEscape(row.body)}</p></article>`).join('');
}

async function renderActivity(env, user, actor, id, page, tools) {
  const data = await callStore(env, 'social', 'activity', { actor, id, page });
  const accounts = await namesFor(env, [data.activity, ...data.rows], tools);
  return communityPage(tools, user, '犇犇详情', 'home', [
    heading('犇犇详情', '<a href="/">返回全站动态</a>'),
    feedCard(data.activity, accounts, tools, actor, true),
    `<section class="community-card"><h2>回复</h2>${renderReplies(data.rows, accounts, tools)}
      ${pageLinks(activityPath(id), page, data.more)}
      ${actor ? writeForm(activityPath(id) + '/reply', '回复', '写回复', 500) : loginLine('回复')}</section>`,
  ].join(''));
}

async function renderForums(env, user, actor, url, page, tools) {
  const board = url.searchParams.get('board') || '';
  if (board && !BOARDS.has(board)) throw new CommunityError('板块不存在。', 404);
  const data = await callStore(env, 'social', 'topics', { board, page });
  const accounts = await namesFor(env, data.rows, tools);
  const tabs = `<nav class="community-tabs" aria-label="讨论区板块">${selected(!board, '/discuss', '全部')}
    ${Array.from(BOARDS, ([id, name]) => selected(board === id, '/discuss?board=' + id, name)).join('')}</nav>`;
  const path = '/discuss' + (board ? '?board=' + board : '');
  const composer = '/discuss/new' + (board ? '?board=' + board : '');
  const topics = data.rows.map(row => `<article class="community-topic">
    <div>
      ${row.pinned ? '<span class="community-pin">置顶</span>' : ''}
      <a class="community-topic-title" href="${topicPath(row.id)}">${htmlEscape(row.title)}</a>
      <div class="community-byline">${tools.authorName(row.name, accounts)}
        <a href="/discuss?board=${row.board}">${BOARDS.get(row.board)}</a>${date(row.latest)}</div>
    </div>
    <span class="community-reply-count">${row.replies} 回复</span>
  </article>`).join('');
  return communityPage(tools, user, '讨论区', 'discuss', [
    heading('讨论区', actor && (board !== 'announcements' || actor.admin) ? `<a class="community-button" href="${composer}">发起讨论</a>` : ''),
    tabs,
    `<section class="community-card community-topic-list">${topics || '<p class="community-empty">这个板块还没有帖子。</p>'}</section>`,
    pageLinks(path, page, data.more),
  ].join(''));
}

function renderNewTopic(tools, user, actor, boardValue) {
  const board = BOARDS.has(boardValue) ? boardValue : 'general';
  const options = Array.from(BOARDS, ([id, text]) => {
    if (id === 'announcements' && !actor.admin) return '';
    return `<option value="${id}"${id === board ? ' selected' : ''}>${text}</option>`;
  }).join('');
  return communityPage(tools, user, '发起讨论', 'discuss', heading('发起讨论') + `
    <section class="community-card">
      <form method="post" action="/discuss/new" class="community-compose">
        <label>板块<select name="board">${options}</select></label>
        <label>标题<input name="title" required maxlength="100"></label>
        <label>正文<textarea name="body" required maxlength="6000" rows="10"></textarea></label>
        <button type="submit" class="community-button">发布讨论</button>
      </form>
    </section>`);
}

async function renderTopic(env, user, actor, id, page, tools) {
  const data = await callStore(env, 'social', 'topic', { actor, id, page });
  const { topic } = data;
  const accounts = await namesFor(env, [topic, ...data.rows], tools);
  const path = topicPath(id);
  return communityPage(tools, user, topic.title, 'discuss', [
    `<nav class="community-trail"><a href="/discuss">讨论区</a> / <a href="/discuss?board=${topic.board}">${BOARDS.get(topic.board)}</a></nav>`,
    heading(topic.title),
    `<article class="community-card">
      ${topic.pinned ? '<span class="community-pin">置顶</span>' : ''}${postByline(topic, accounts, tools)}
      <p class="community-text">${htmlEscape(topic.body)}</p>
      <div class="community-actions">
        ${actor?.admin ? actionForm(path + '/pin', topic.pinned ? '取消置顶' : '置顶', !topic.pinned) : ''}
        ${canEdit(actor, topic) ? actionForm(path + '/delete', '删除帖子') : ''}
      </div>
    </article>`,
    `<section class="community-card"><h2>回复</h2>${renderReplies(data.rows, accounts, tools)}
      ${pageLinks(path, page, data.more)}
      ${actor ? writeForm(path + '/reply', '回复', '写回复', 2000) : loginLine('参与讨论')}</section>`,
  ].join(''));
}

async function targetAccount(env, name, tools) {
  if (!USERNAME.test(name)) throw new CommunityError('用户不存在。', 404);
  const account = (await tools.getPublicAuthors(env, [name], false)).get(name);
  if (!account) throw new CommunityError('用户不存在。', 404);
  return { id: scope(account), name };
}

export async function profileCommunity(env, user, name, account) {
  if (!env.COMMUNITY_STORE || !account) return '';
  const actor = identity(user);
  const target = { id: scope(account), name };
  const data = await callStore(env, 'social', 'profile', { actor, target });
  const buttons = actor && actor.id !== target.id ? [
    actionForm(userPath(name) + '/follow', data.followed ? '取消关注' : '关注', !data.followed),
    `<a class="community-button community-button-quiet" href="${chatPath(name)}">发私信</a>`,
  ].join('') : '';
  return `<div class="community-actions community-profile">
    <span>关注 <strong>${data.following}</strong></span>
    <span>粉丝 <strong>${data.followers}</strong></span>${buttons}</div>`;
}

async function renderMembers(env, user, url, tools) {
  const query = (url.searchParams.get('q') || '').trim().slice(0, 20);
  const valid = !query || /^[a-zA-Z0-9_\u4e00-\u9fa5]{1,20}$/.test(query);
  const members = valid ? await tools.findMentionUsernames(env, query) : [];
  const accounts = await tools.getPublicAuthors(env, members);
  return communityPage(tools, user, '找用户', '', heading('找用户') + `
    <section class="community-card">
      <form class="community-search" action="/members" method="get">
        <input name="q" type="search" aria-label="用户名" maxlength="20" placeholder="搜索用户名" value="${htmlEscape(query)}">
        <button type="submit" class="community-button">搜索</button>
      </form>
      <ul class="community-member-list">${members.map(member => '<li>' + tools.authorName(member, accounts) + '</li>').join('')}</ul>
      ${members.length ? '' : '<p class="community-empty">没有找到匹配的用户。</p>'}
    </section>`);
}

async function renderMessages(env, user, actor, name, page, tools) {
  if (!actor) return tools.redirect('/login');
  if (!name) {
    const { rows, more } = await callStore(env, 'messages', 'inbox', { actor, page });
    return communityPage(tools, user, '私信', 'messages', heading('私信', '<a href="/members">查找联系人</a>') + `
      <section class="community-card community-topic-list">
        ${rows.map(row => `<a class="community-conversation" href="${chatPath(row.name)}">
          <strong>${htmlEscape(row.name)}</strong>${date(row.at)}
          <span>${htmlEscape(row.body.slice(0, 100))}</span>
        </a>`).join('') || '<p class="community-empty">还没有私信。可以在对方主页发起私信。</p>'}
      </section>${pageLinks('/messages', page, more)}`);
  }
  const target = await targetAccount(env, name, tools);
  const { rows, more } = await callStore(env, 'messages', 'thread', { actor, target, page });
  return communityPage(tools, user, '与 ' + name + ' 的私信', 'messages', [
    heading('与 ' + name + ' 的私信', '<a href="/messages">返回私信列表</a>'),
    `<section class="community-card">
      <div class="community-chat">${rows.reverse().map(row => `<article class="community-bubble${row.mine ? ' is-mine' : ''}">
        <div class="community-byline">${threadLink(row.name)}${date(row.at)}</div>
        <p class="community-text">${htmlEscape(row.body)}</p></article>`).join('') || '<p class="community-empty">还没有聊天记录。</p>'}</div>
      ${pageLinks(chatPath(name), page, more)}
      ${writeForm(chatPath(name), '发送私信', '写私信', 2000)}
    </section>`,
  ].join(''));
}

function recordStatus(row) {
  return htmlEscape(row.verdict || '等待评测结果');
}

function recordScore(value) {
  return Number.isFinite(value) ? htmlEscape(value + ' 分') : '—';
}

async function renderRecords(env, user, actor, id, rid, page, tools) {
  const problem = tools.problem(id);
  if (!problem?.hydroPid) throw new CommunityError('这道题尚未开放评测。', 404);
  const path = '/problems/' + id + '/records';
  const back = `<a href="/problems/${id}">返回题面</a>`;
  if (rid) {
    const row = await callStore(env, 'records', 'record', { actor, problem: id, rid });
    const accountNames = await tools.recordNames(env, [row]);
    const name = accountNames.get(row.owner) || row.name;
    let result;
    let codeNote = '';
    if (row.receipt) {
      const settings = tools.hydroSettings(env);
      if (settings) {
        try {
          result = await tools.resultFromHydro(settings, { key: row.owner, createdAt: row.accountDate }, problem.hydroPid, row.receipt, true);
        } catch {
          codeNote = '评测服务暂时不可用，请稍后刷新。';
        }
      }
      if (!result?.source && !codeNote) codeNote = '这条记录暂时没有可显示的源代码。';
    }
    const display = result || row;
    const code = row.receipt ? `<section class="community-card"><h2>源代码</h2>
      ${result?.source ? `<pre class="community-code"><code>${htmlEscape(result.source)}</code></pre>` : `<p>${codeNote}</p>`}</section>` : '';
    return communityPage(tools, user, '提交详情', 'problems', heading('提交详情', `<a href="${path}">返回提交记录</a>`) + `
      <div class="community-card">
        <div class="community-byline">${threadLink(name)}${date(row.at)}${back}</div>
        <dl class="community-record-stats">
          <div><dt>评测结果</dt><dd>${recordStatus(display)}</dd></div>
          <div><dt>得分</dt><dd>${recordScore(display.score)}</dd></div>
          <div><dt>语言</dt><dd>${htmlEscape(display.language || '—')}</dd></div>
          <div><dt>用时</dt><dd>${htmlEscape(display.timeMs ?? display.time_ms ?? '—')} ms</dd></div>
          <div><dt>内存</dt><dd>${htmlEscape(display.memoryKiB ?? display.memory_kib ?? '—')} KiB</dd></div>
        </dl>
      </div>${code}`);
  }
  const data = await callStore(env, 'records', 'list', { problem: id, page });
  const names = await tools.recordNames(env, data.rows);
  const records = data.rows.map(row => {
    const statusClass = row.status === 1 ? ' is-accepted' : Number.isInteger(row.status) && ![0,20,21,22].includes(row.status) ? ' is-judged' : '';
    return `<tr><td>${threadLink(names.get(row.owner) || row.name)}</td>
      <td><a href="${path}/${row.rid}" class="community-record-verdict${statusClass}">${recordStatus(row)}</a></td>
      <td>${recordScore(row.score)}</td><td>${htmlEscape(row.language || '—')}</td><td>${date(row.at)}</td></tr>`;
  }).join('');
  return communityPage(tools, user, id + ' 提交记录', 'problems', heading(id + ' 提交记录', back) + `
    <section class="community-card community-table-wrap">
      ${records ? `<table class="community-table"><thead><tr><th>提交者</th><th>评测结果</th><th>得分</th><th>语言</th><th>提交时间</th></tr></thead>
        <tbody>${records}</tbody></table>` : '<p class="community-empty">这道题还没有提交记录。</p>'}
    </section>${pageLinks(path, page, data.more)}`);
}

async function readForm(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) {
    throw new CommunityError('表单格式不正确。', 415);
  }
  if (Number(request.headers.get('Content-Length')) > 65536) throw new CommunityError('内容太长。', 413);
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let message = '';
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new CommunityError('内容太长。', 413);
    }
    message += decoder.decode(value, { stream: true });
  }
  return new URLSearchParams(message + decoder.decode());
}

async function postCommunity(request, env, user, actor, path, url, tools) {
  const activity = /^\/benben\/(\d+)\/(like|reply|delete)$/.exec(path);
  const topic = /^\/discuss\/(\d+)\/(pin|reply|delete)$/.exec(path);
  const follow = /^\/users\/([^/]+)\/follow$/.exec(path);
  const chat = /^\/messages\/([^/]+)$/.exec(path);
  if (!activity && !topic && !follow && !chat && path !== '/benben' && path !== '/discuss/new') return null;
  if (!actor) return tools.redirect('/login');
  const form = await readForm(request);
  const body = form.get('body');
  const enabled = form.get('enabled') === '1';
  await tools.enforceRate(request, env, chat ? 'private-message' : 'community-post', chat ? 20 : 40, user);
  if (path === '/benben') {
    await callStore(env, 'social', 'post-activity', { actor, body });
    return tools.redirect('/');
  }
  if (activity) {
    const [, id, verb] = activity;
    const action = verb === 'like' ? verb : verb + '-activity';
    await callStore(env, 'social', action, { actor, id, body, enabled });
    return tools.redirect(verb === 'reply' || (verb === 'like' && url.searchParams.get('thread') === '1') ? activityPath(id) : '/');
  }
  if (follow) {
    const target = await targetAccount(env, decodeURIComponent(follow[1]), tools);
    await callStore(env, 'social', 'follow', { actor, target, enabled });
    return tools.redirect(userPath(target.name));
  }
  if (chat) {
    const target = await targetAccount(env, decodeURIComponent(chat[1]), tools);
    await callStore(env, 'messages', 'send', { actor, target, body });
    return tools.redirect(chatPath(target.name));
  }
  if (path === '/discuss/new') {
    const { id } = await callStore(env, 'social', 'post-topic', { actor, body, title: form.get('title'), board: form.get('board') });
    return tools.redirect(topicPath(id));
  }
  const [, id, verb] = topic;
  await callStore(env, 'social', verb === 'pin' ? verb : verb + '-topic', { actor, id, enabled, body });
  return tools.redirect(verb === 'delete' ? '/discuss' : topicPath(id));
}

export async function communityRoute(request, env, user, tools) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const actor = identity(user);
  const page = pageNumber(url.searchParams.get('page'));
  try {
    if (request.method === 'POST') return await postCommunity(request, env, user, actor, path, url, tools);
    if (request.method !== 'GET') return null;
    if (path === '/' && env.COMMUNITY_STORE) return await renderFeed(env, user, actor, url, page, tools);
    if (path === '/discuss') return await renderForums(env, user, actor, url, page, tools);
    if (path === '/discuss/new') return actor ? renderNewTopic(tools, user, actor, url.searchParams.get('board')) : tools.redirect('/login');
    if (path === '/members') return await renderMembers(env, user, url, tools);
    const activity = /^\/benben\/(\d+)$/.exec(path);
    if (activity) return await renderActivity(env, user, actor, activity[1], page, tools);
    const topic = /^\/discuss\/(\d+)$/.exec(path);
    if (topic) return await renderTopic(env, user, actor, topic[1], page, tools);
    const chat = /^\/messages(?:\/([^/]+))?$/.exec(path);
    if (chat) return await renderMessages(env, user, actor, chat[1] && decodeURIComponent(chat[1]), page, tools);
    const records = /^\/problems\/([A-Z0-9]+)\/records(?:\/([a-z0-9]+))?$/i.exec(path);
    if (records) {
      if (records[2] && !RECORD_ID.test(records[2])) throw new CommunityError('提交记录不存在。', 404);
      return await renderRecords(env, user, actor, records[1].toUpperCase(), records[2], page, tools);
    }
    return null;
  } catch (error) {
    if (error instanceof URIError) return tools.text('链接无效。', 400);
    if (!(error instanceof CommunityError)) throw error;
    return tools.html(tools.layout({ user, title: '社区', community: true, body:
      `<section class="community-layout"><div class="community-card"><p>${htmlEscape(error.message)}</p><a href="/">返回首页</a></div></section>`,
    }), error.status);
  }
}

export const communityCss = `
.community-layout{max-width:960px;margin:38px auto 76px;display:grid;gap:22px}
.community-layout.has-aside{grid-template-columns:minmax(0,1fr) 220px}
.community-main{min-width:0;display:grid;gap:14px;align-content:start}
.community-heading{display:flex;align-items:center;justify-content:space-between;gap:14px}
.community-heading h1{font-size:clamp(1.65rem,4.6vw,2.6rem);line-height:1.18;margin:0;overflow-wrap:anywhere}
.community-heading>a{white-space:nowrap}
.community-card{min-width:0;border:1px solid color-mix(in srgb,var(--ink) 24%,transparent);background:var(--paper);
  border-radius:12px;padding:17px 19px;box-shadow:0 3px 0 color-mix(in srgb,var(--ink) 9%,transparent)}
.community-card h2{font-size:1.02rem;margin:0 0 12px}
.community-sidebar-card{display:grid;gap:5px}
.community-sidebar-card h2{margin:0 0 6px}
.community-sidebar-card a{border-radius:6px;padding:7px 8px;text-decoration:none}
.community-sidebar-card a:hover{background:var(--paper-alt)}
.community-tabs,.community-actions,.community-byline,.community-pages{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.community-tabs{border-bottom:1px solid color-mix(in srgb,var(--ink) 21%,transparent)}
.community-tabs a{font-weight:700;text-decoration:none;border-bottom:2px solid transparent;padding:9px 6px}
.community-tabs a[aria-current=page]{border-color:var(--blue);color:var(--ink)}
.community-byline{gap:5px 12px;font-size:.88rem}
.community-byline time,.community-conversation time,.community-reply-count,.community-empty{color:var(--gray)}
.community-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.66;margin:10px 0}
.community-actions{font-size:.85rem}
.community-action{display:inline;margin:0}
.community-compose{display:grid;gap:9px}
.community-compose label{display:grid;gap:6px;font-size:.91rem;font-weight:700}
.community-compose input,.community-compose select,.community-compose textarea,.community-search input{
  font:inherit;color:var(--ink);background:var(--paper-alt);border:1px solid color-mix(in srgb,var(--ink) 28%,transparent);
  border-radius:7px;padding:9px 10px;width:100%;min-width:0;
}
.community-compose textarea{font-weight:400;resize:vertical;min-height:65px}
.community-compose>.community-button{justify-self:end}
.community-button{display:inline-flex;align-items:center;justify-content:center;color:var(--ink);background:var(--paper-alt);
  border:1px solid color-mix(in srgb,var(--ink) 45%,transparent);border-radius:7px;padding:6px 11px;
  cursor:pointer;font:inherit;font-weight:700;text-decoration:none}
.community-button:hover{border-color:var(--blue)}
.community-button-quiet{background:transparent;font-size:.84rem}
.community-pages{justify-content:center;margin:7px 0}
.community-pages span,.community-trail{color:var(--gray);font-size:.88rem}
.community-topic-list{padding-block:6px}
.community-topic,.community-conversation{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:12px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 17%,transparent)}
.community-topic:last-child,.community-conversation:last-child{border:0}
.community-topic-title{font-weight:750;text-decoration:none;overflow-wrap:anywhere}
.community-topic .community-byline{margin-top:5px}
.community-pin{display:inline-block;color:var(--ink);background:color-mix(in srgb,var(--yellow) 38%,var(--paper));
  border-radius:4px;padding:1px 6px;font-size:.76rem;font-weight:700;margin-inline-end:5px}
.community-reply-count{font-size:.8rem;white-space:nowrap}
.community-reply{border-bottom:1px solid color-mix(in srgb,var(--ink) 17%,transparent);padding:9px 0}
.community-reply:last-of-type{margin-bottom:12px}
.community-search{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
.community-member-list{display:flex;flex-wrap:wrap;gap:8px 16px;padding:0;list-style:none}
.community-conversation{display:grid;grid-template-columns:minmax(0,1fr) auto;text-decoration:none;overflow-wrap:anywhere}
.community-conversation span{grid-column:1/-1}
.community-chat{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-bottom:13px}
.community-bubble{padding:9px 11px;border-radius:9px;max-width:92%;background:var(--paper-alt)}
.community-bubble.is-mine{align-self:flex-end;background:color-mix(in srgb,var(--blue) 12%,var(--paper))}
.community-bubble .community-text{margin-bottom:0}
.community-table-wrap{overflow:auto}
.community-table{width:100%;border-collapse:collapse;font-size:.9rem;text-align:left}
.community-table th,.community-table td{padding:9px 11px;white-space:nowrap;border-bottom:1px solid color-mix(in srgb,var(--ink) 15%,transparent)}
.community-table tr:last-child td{border-bottom:0}
.community-record-verdict{font-weight:700}
.community-record-verdict.is-accepted{color:var(--ink);text-decoration-color:var(--green)}
.community-record-verdict.is-judged{color:var(--ink);text-decoration-color:var(--pink)}
.community-record-stats{display:flex;gap:12px 22px;flex-wrap:wrap;margin-bottom:0}
.community-record-stats dt{color:var(--gray);font-size:.82rem}
.community-record-stats dd{margin:2px 0 0;font-weight:700}
.community-code{max-width:100%;overflow:auto;margin:0;padding:13px;border-radius:7px;background:#141d27;color:#edf5ff}
.community-profile{margin-top:12px}
@media(max-width:760px){
  .community-layout,.community-layout.has-aside{grid-template-columns:minmax(0,1fr);margin-top:24px}
  .community-card{padding:13px 12px}
}
`;
