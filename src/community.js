import { markdownToolbar, markdownDialogs, markdownToolbarScript } from "./markdown-editor.js";
import { ContestError, contestSchema, statsSchema, storedContest, scheduleJudgeRefresh, refreshPendingJudges, contestPage, contestCss } from "./contests.js";

const PAGE_SIZE = 20;
const ACTIVITY_REPLY_PAGE_SIZE = 6;
const MAX_ACTIVITY_BODY = 1_500_000;
const MAX_ACTIVITY_FORM = 5_000_000;
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
  `CREATE TABLE IF NOT EXISTS message_reads (
    recipient TEXT NOT NULL, sender TEXT NOT NULL, through INTEGER NOT NULL, PRIMARY KEY(recipient,sender)
  )`,
];

const NOTICE_LIMIT = 50;
const NOTICE_LIFETIME = 30 * 86400 * 1000;
const NOTICE_CLOCK = 9999999999999;
const noticesSchema = [
  `CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS notices_at ON notices(at DESC, id DESC)',
];

export function validInboxNotice(notice) {
  if (!notice || typeof notice.actor !== 'string' || typeof notice.title !== 'string' ||
      !Number.isSafeInteger(notice.at) || notice.at <= 0 || notice.at > NOTICE_CLOCK) return false;
  return Number.isSafeInteger(notice.activityId) && notice.activityId > 0 ||
    typeof notice.slug === 'string' && notice.slug.length > 0;
}

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

export function identity(user) {
  return user ? { id: scope(user), name: user.username, root: user.isRootAdmin === true, admin: user.role === 'admin' || user.isRootAdmin === true } : null;
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

function paginate(rows, limit = PAGE_SIZE) {
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

function activityMarkdown(value) {
  if (typeof value !== 'string' || !value.trim()) throw new CommunityError('请填写正文。');
  if (value.length > MAX_ACTIVITY_BODY || new TextEncoder().encode(value).byteLength > MAX_ACTIVITY_BODY) {
    throw new CommunityError('正文或图片过大，请缩小图片或改用图片链接。', 413);
  }
  return value;
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
        this.initialize([...recordsSchema, ...contestSchema]);
        if (action.startsWith('contest-')) {
          const output = storedContest(this, action.slice(8), args);
          if (action === 'contest-attach' || action === 'contest-complete') await scheduleJudgeRefresh(this);
          return Response.json(output);
        }
        return Response.json(await this.records(action, args));
      }
      if (area === 'messages') {
        this.initialize(inboxSchema);
        return Response.json(this.messages(action, args));
      }
      if (area === 'notices') {
        this.initialize(noticesSchema);
        return Response.json(await this.notices(action, args));
      }
      if (area === 'stats') {
        this.initialize(statsSchema);
        if (action === 'view') {
          this.sql.exec(`INSERT INTO site_views(day,views) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET views=views+1`,args.day);
          return Response.json({});
        }
        if (!args.actor?.root) throw new CommunityError('只有站主可以查看统计。',403);
        return Response.json(this.row(`SELECT coalesce(sum(views),0) AS visits, coalesce(sum(CASE WHEN day=? THEN views ELSE 0 END),0) AS today FROM site_views`,args.day));
      }
      this.initialize(schema);
      return Response.json(this.community(action, args));
    } catch (error) {
      if (!(error instanceof CommunityError || error instanceof ContestError)) throw error;
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

  async refreshJudges(hydroSettings, resultFromHydro) {
    this.initialize([...recordsSchema, ...contestSchema]);
    await refreshPendingJudges(this,this.env,hydroSettings,resultFromHydro);
  }

  rows(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  row(query, ...params) {
    return this.rows(query, ...params)[0];
  }

  saveNotice(id, notice) {
    if (!validInboxNotice(notice)) return;
    this.sql.exec('INSERT OR IGNORE INTO notices (id, at, data) VALUES (?, ?, ?)',
      id, notice.at, JSON.stringify(notice));
  }

  advanceNoticeRead(through) {
    const kv = this.ctx.storage.kv;
    if (Number.isSafeInteger(through) && through > (kv.get('notice-read-through') || 0)) {
      kv.put('notice-read-through', through);
    }
  }

  async restoreNotices(account) {
    const kv = this.ctx.storage.kv;
    const state = kv.get('notice-import');
    if (state?.done || (state?.next && Date.now() < state.next)) return Boolean(state?.unavailable);
    if (this.noticeImport) return this.noticeImport;
    this.noticeImport = this.restoreNoticePage(account, state);
    try { return await this.noticeImport; }
    finally { this.noticeImport = null; }
  }

  async restoreNoticePage(account, state) {
    const kv = this.ctx.storage.kv;
    const prefix = 'mention:' + account;
    const readPrefix = 'mention-read:' + account;
    try {
      const [notices, read] = await Promise.all([
        this.env.POSTS.list({ prefix, limit: NOTICE_LIMIT + 1 }),
        this.env.POSTS.list({ prefix: readPrefix, limit: 1 }),
      ]);
      const watermark = read.keys[0]?.name.slice(readPrefix.length, readPrefix.length + 13);
      this.ctx.storage.transactionSync(() => {
        for (const { name, metadata } of notices.keys) {
          this.saveNotice(name.slice(prefix.length), metadata);
        }
        if (/^\d{13}$/.test(watermark ?? '')) this.advanceNoticeRead(NOTICE_CLOCK - Number(watermark));
        // Verify once more after KV has had time to expose writes from the previous deployment.
        kv.put('notice-import', state?.copied ? { done: true } : { copied: true, next: Date.now() + 120000 });
      });
      return false;
    } catch (error) {
      console.warn('Legacy notification sync failed:', error?.message);
      kv.put('notice-import', { copied: Boolean(state?.copied), unavailable: true, next: Date.now() + 300000 });
      return true;
    }
  }

  async notices(action, args) {
    const cutoff = Date.now() - NOTICE_LIFETIME;
    if (action === 'save') {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM notices WHERE at < ?', cutoff);
        this.saveNotice(args.id, args.notice);
      });
      return {};
    }
    if (action === 'mark') {
      this.advanceNoticeRead(args.through);
      return {};
    }
    if (action !== 'read') throw new CommunityError('操作不存在。', 404);
    const legacyUnavailable = await this.restoreNotices(args.account);
    const readThrough = Math.max(this.ctx.storage.kv.get('notice-read-through') || 0, args.through || 0);
    const notices = this.rows('SELECT data FROM notices WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?',
      cutoff, NOTICE_LIMIT + 1).map(row => JSON.parse(row.data));
    const unread = notices.filter(notice => notice.at > readThrough).length;
    return {
      entries: notices.slice(0, NOTICE_LIMIT), readThrough,
      unread: Math.min(unread, NOTICE_LIMIT), more: unread > NOTICE_LIMIT, legacyUnavailable,
    };
  }

  community(action, args) {
    const { actor, target } = args;
    const offset = (pageNumber(args.page) - 1) * PAGE_SIZE;
    switch (action) {
      case 'feed': {
        const viewer = actor?.id ?? '';
        const following = Boolean(args.following && actor);
        const entries = this.rows(`SELECT a.id, a.author, a.name, a.at,
          CASE WHEN length(CAST(a.body AS BLOB)) <= 48000 THEN a.body ELSE null END AS body,
          (SELECT count(*) FROM activity_likes WHERE activity = a.id) AS likes,
          EXISTS(SELECT 1 FROM activity_likes WHERE activity = a.id AND actor = ?) AS liked,
          (SELECT count(*) FROM activity_replies WHERE activity = a.id) AS replies
          FROM activity a
          WHERE ? = 0 OR a.author = ? OR a.author IN (SELECT target FROM follows WHERE actor = ?)
          ORDER BY a.id DESC LIMIT ? OFFSET ?`, viewer, Number(following), viewer, viewer, PAGE_SIZE + 1, offset);
        const pins = this.rows('SELECT id,title FROM topics WHERE pinned=1 ORDER BY pinned DESC,latest DESC,id DESC LIMIT 6');
        return { ...paginate(entries), pins };
      }
      case 'activity': {
        const id = itemId(args.id);
        const activity = this.row(`SELECT a.*, (SELECT count(*) FROM activity_likes WHERE activity = a.id) AS likes,
          EXISTS(SELECT 1 FROM activity_likes WHERE activity = a.id AND actor = ?) AS liked FROM activity a WHERE id = ?`,
          actor?.id ?? '', id);
        if (!activity) throw new CommunityError('这条犇犇已不存在。', 404);
        let page = pageNumber(args.page);
        if (args.reply && this.row('SELECT 1 FROM activity_replies WHERE activity = ? AND id = ?', id, args.reply)) {
          const { count } = this.row('SELECT count(*) AS count FROM activity_replies WHERE activity = ? AND id <= ?', id, args.reply);
          page = pageNumber(Math.ceil(count / ACTIVITY_REPLY_PAGE_SIZE));
        }
        const replyOffset = (page - 1) * ACTIVITY_REPLY_PAGE_SIZE;
        return { activity, page, ...paginate(this.rows(
          'SELECT * FROM activity_replies WHERE activity = ? ORDER BY id LIMIT ? OFFSET ?',
          id, ACTIVITY_REPLY_PAGE_SIZE + 1, replyOffset,
        ), ACTIVITY_REPLY_PAGE_SIZE) };
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
          id, name, activityMarkdown(args.body), now);
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
        return this.row('INSERT INTO activity_replies (activity, author, name, body, at) VALUES (?, ?, ?, ?, ?) RETURNING id',
          activity, id, name, activityMarkdown(args.body), now);
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
    const kv = this.ctx.storage.kv;
    if (kv.get('dm-release-id') === undefined) {
      kv.put('dm-release-id', this.row('SELECT coalesce(max(id),0) AS id FROM messages').id);
    }
    const baseline = kv.get('dm-release-id');
    if (action === 'unread') {
      return this.row(`SELECT count(*) AS unread FROM (
        SELECT 1 FROM messages m LEFT JOIN message_reads r ON r.recipient=m.recipient AND r.sender=m.sender
        WHERE m.recipient=? AND m.id>max(?,coalesce(r.through,0)) LIMIT 100)`,id,baseline);
    }
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
      const messages = paginate(this.rows(`SELECT id, sender_name AS name, body, at, sender = ? AS mine
        FROM messages WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
        ORDER BY id DESC LIMIT ? OFFSET ?`, id, id, target.id, target.id, id, PAGE_SIZE + 1, offset));
      if (!offset && messages.rows.length) {
        this.sql.exec(`INSERT INTO message_reads(recipient,sender,through) VALUES (?,?,?)
          ON CONFLICT(recipient,sender) DO UPDATE SET through=max(message_reads.through,excluded.through)`,id,target.id,messages.rows[0].id);
      }
      return messages;
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
      if (args.pid && (args.status === undefined || [0,20,21,22].includes(args.status))) {
        this.sql.exec('INSERT OR IGNORE INTO judge_refresh(rid,pid,due) VALUES (?,?,?)',args.rid,args.pid,Date.now()+1500);
        await scheduleJudgeRefresh(this);
      } else if (Number.isInteger(args.status) && ![0,20,21,22].includes(args.status)) {
        this.sql.exec('DELETE FROM judge_refresh WHERE rid=?',args.rid);
      }
      return {};
    }
    if (!this.importRetryAt || Date.now() >= this.importRetryAt) {
      try { await this.importRecords(); }
      catch (error) {
        this.importRetryAt = Date.now() + 60000;
        console.warn('Unable to import legacy submission history', error?.message);
      }
    }
    if (action === 'count') {
      if (!args.actor?.root) throw new CommunityError('只有站主可以查看统计。',403);
      return this.row('SELECT count(*) AS submissions, count(CASE WHEN at >= ? THEN 1 END) AS today FROM records',args.since);
    }
    if (action === 'history') {
      const [owner, createdAt] = JSON.parse(requireMember(args.actor).id);
      const page = pageNumber(args.page);
      const filter = `FROM records r WHERE r.owner=? AND r.account_date=? AND r.problem=? AND
        NOT EXISTS(SELECT 1 FROM contest_attempts c WHERE c.rid=r.rid)`;
      const params = [owner,createdAt,args.problem];
      const history = paginate(this.rows(`SELECT r.receipt,r.at AS submittedAt,r.verdict,r.score,r.status,r.language ${filter}
        ORDER BY r.at DESC,r.rid DESC LIMIT ? OFFSET ?`,...params,PAGE_SIZE+1,(page-1)*PAGE_SIZE));
      const best = this.row(`SELECT max(r.score) AS highest ${filter} AND r.status NOT IN (0,20,21,22)`,...params);
      return { records:history.rows.map(row=>({...row,verdict:row.verdict || '等待评测结果',pending:row.status===null || [0,20,21,22].includes(row.status)})),
        highest:best.highest,cursor:history.more?String(page+1):null };
    }
    const visible = 'r.rid, r.problem, r.owner, r.name, r.at, r.status, r.verdict, r.score, r.language, r.time_ms, r.memory_kib, a.contest';
    if (action === 'list') {
      const filters = [];
      const parameters = [];
      if (args.problem) {
        filters.push('r.problem=?');
        parameters.push(args.problem);
      }
      if (args.mine) {
        const [key,createdAt] = JSON.parse(requireMember(args.actor).id);
        filters.push('r.owner=? AND r.account_date=?');
        parameters.push(key,createdAt);
      }
      const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
      return paginate(this.rows(`SELECT ${visible} FROM records r LEFT JOIN contest_attempts a ON a.rid=r.rid ${where} ORDER BY r.at DESC,r.rid DESC LIMIT ? OFFSET ?`,
        ...parameters, PAGE_SIZE + 1, (pageNumber(args.page) - 1) * PAGE_SIZE));
    }
    if (action !== 'record') throw new CommunityError('操作不存在。', 404);
    const row = this.row(`SELECT ${visible},r.account_date,r.receipt FROM records r LEFT JOIN contest_attempts a ON a.rid=r.rid
      WHERE r.rid=? AND (? IS NULL OR r.problem=?)`,args.rid,args.problem || null,args.problem || null);
    if (!row) throw new CommunityError('提交记录不存在。', 404);
    const { receipt, account_date, ...result } = row;
    const owner = scope({ key: row.owner, createdAt: account_date });
    return !row.contest && args.actor?.id === owner
      ? { ...result, receipt, accountDate: account_date }
      : result;
  }
}

async function callStore(env, area, action, args, objectName = area) {
  const binding = env.COMMUNITY_STORE;
  if (!binding) throw new CommunityError('社区功能正在发布，请稍后再试。', 503);
  const stub = binding.get(binding.idFromName(objectName));
  const response = await stub.fetch('https://community.internal/' + area + '/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const result = await response.json();
  if (!response.ok) throw new CommunityError(result.error || '暂时无法完成此操作。', response.status);
  return result;
}

export function callNotificationStore(env, account, action, args) {
  return callStore(env, 'notices', action, { ...args, account }, 'notices:' + account);
}

export function readDirectBadge(env,user) {
  return !env.COMMUNITY_STORE || !user ? Promise.resolve({ unread:0 }) : callStore(env,'messages','unread',{ actor:identity(user) });
}

export function readPracticeHistory(env,user,problem,page) {
  return callStore(env,'records','history',{actor:identity(user),problem,page});
}

const localDay = new Intl.DateTimeFormat('en-CA',{ timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' });

export function countPageVisit(env) {
  const shard = crypto.getRandomValues(new Uint8Array(1))[0] % 8;
  return callStore(env,'stats','view',{ day:localDay.format(Date.now()) },'site-stats:'+shard);
}

export async function callContestStore(env, action, args) {
  try { return await callStore(env,'records','contest-'+action,args); }
  catch (error) {
    if (error instanceof CommunityError) throw new ContestError(error.message,error.status);
    throw error;
  }
}

export function communityRecord(user, problem, receipt, result = {}) {
  const rid = receipt.slice(0, 24);
  const { status, verdict, score, language, timeMs, memoryKiB } = result;
  return {
    rid, problem, owner:user.key, name:user.username, accountDate:user.createdAt || '', receipt,
    at:parseInt(rid.slice(0,8),16)*1000,status,verdict,score,language,timeMs,memoryKiB,
  };
}

export async function saveCommunityRecord(env, user, problem, receipt, result = {}, pid) {
  if (!env.COMMUNITY_STORE) return;
  try {
    await callStore(env,'records','save',{ ...communityRecord(user,problem,receipt,result),pid });
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

function writeForm(url, text, label, length, markdown = false) {
  if (markdown) {
    return `<form id="benben-composer" method="post" action="${htmlEscape(url)}" class="community-compose community-markdown-compose benben-composer">
      <label for="content-input">${label}（Markdown）</label>
      ${markdownToolbar}
      <textarea id="content-input" name="body" data-mention-picker required maxlength="${length}" rows="5"
        wrap="soft" placeholder="支持公式、表格、代码块和 @用户名"></textarea>
      ${markdownDialogs}
      <button type="submit" class="community-button">${text}</button>
      <p class="benben-quote-status" role="status" hidden></p>
    </form><script>${markdownToolbarScript}</script><script>${benbenQuoteScript}</script>`;
  }
  return `<form method="post" action="${htmlEscape(url)}" class="community-compose">
    <label>${label}<textarea name="body" required maxlength="${length}" rows="3"></textarea></label>
    <button type="submit" class="community-button">${text}</button>
  </form>`;
}

async function namesFor(env, rows, tools) {
  return tools.getPublicAuthors(env, rows.map(row => row.name));
}

async function markdownFor(env, rows, tools) {
  const articles = new Map();
  const names = new Set();
  for (const row of rows) {
    if (row.body === null) continue;
    const article = tools.parseArticle(row.body);
    articles.set(row, article);
    for (const name of article.names) names.add(name);
  }
  const mentions = new Map();
  const usernames = [...names];
  for (let index = 0; index < usernames.length; index += 50) {
    const batch = await tools.getPublicAuthors(env, usernames.slice(index, index + 50), false);
    for (const [name, account] of batch) mentions.set(name, account);
  }
  return (row) => tools.renderArticle(articles.get(row), undefined, name => tools.mentionLink(name, mentions));
}

function postByline(row, accounts, tools) {
  return `<div class="community-byline">${tools.authorName(row.name, accounts)}${date(row.at)}</div>`;
}

function quoteButton(name, sourceUrl = '') {
  return `<button type="button" class="community-button community-button-quiet benben-reply-button"
    data-quote-author="${htmlEscape(name)}"${sourceUrl ? ` data-quote-url="${htmlEscape(sourceUrl)}"` : ''}
    aria-controls="content-input">回复</button>`;
}

function feedCard(row, accounts, tools, actor, markdown, individual = false) {
  const path = activityPath(row.id);
  const returnTo = individual ? '?thread=1' : '';
  return `<article class="community-card benben-card" data-benben-quote>
    ${postByline(row, accounts, tools)}
    ${row.body === null ? `<p><a href="${path}">查看动态全文</a></p>` : `<div class="community-markdown prose">${markdown(row)}</div>`}
    <div class="community-actions">
      ${actor ? quoteButton(row.name, row.body === null ? path : '') : ''}
      ${individual ? '' : `<a href="${path}">${row.replies ? row.replies + ' 条回复' : '详情'}</a>`}
      ${actor ? actionForm(path + '/like' + returnTo, (row.liked ? '已赞 ' : '赞 ') + row.likes, !row.liked) : `<span>${row.likes} 赞</span>`}
      ${canEdit(actor, row) ? actionForm(path + '/delete', '删除') : ''}
    </div>
  </article>`;
}

function communityPage(tools, user, title, active, body, aside = '', markdown = false, intro = '') {
  return tools.html(tools.layout({ user, title, active, community: true, math: markdown, mentionPicker: markdown && Boolean(user), body: `
    ${intro}
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

function homeIntro() {
  return `<section class="community-home-intro" aria-labelledby="community-home-title">
    <div class="community-home-copy">
      <h1 id="community-home-title">野蛮生长</h1>
      <p>算法题解、竞赛笔记与日常动态。</p>
      <nav class="community-home-links" aria-label="首页常用入口">
        <a href="/problems">浏览题库</a>
        <a href="/discuss">进入讨论区</a>
      </nav>
    </div>
    <div class="community-home-shortcuts">
      <a href="/problems/P1001"><span>P1001</span><strong>A+B Problem</strong><span aria-hidden="true">↗</span></a>
      <a href="/discuss?board=announcements"><strong>站务公告</strong><span aria-hidden="true">↗</span></a>
    </div>
  </section>`;
}

async function renderFeed(env, user, actor, url, page, tools) {
  const following = Boolean(actor && url.searchParams.get('view') === 'following');
  const data = await callStore(env, 'social', 'feed', { actor, following, page });
  const { pins } = data;
  const [accounts, markdown] = await Promise.all([namesFor(env, data.rows, tools), markdownFor(env, data.rows, tools)]);
  const path = following ? '/?view=following' : '/';
  const tabs = `<nav class="community-tabs" aria-label="动态筛选">
    ${selected(!following, '/', '全站动态')}${actor ? selected(following, '/?view=following', '我关注的') : ''}
  </nav>`;
  const aside = `${pins.length ? `<section class="community-card community-sidebar-card homepage-pins">
    <h2>置顶讨论</h2>${pins.map(topic=>`<a href="${topicPath(topic.id)}">${htmlEscape(topic.title)}</a>`).join('')}
    </section>` : ''}<div class="community-card community-sidebar-card">
    <h2>常用入口</h2>
    ${[ ['/members', '找用户'], ['/articles', '全部文章'],
      ...(user ? [['/my/articles', '我的文章'], ['/messages', '私信']] : [])].map(([href, text]) => selected(false, href, text)).join('')}
  </div>`;
  const empty = following ? '还没有关注用户的动态。' : '还没有犇犇，来发第一条动态吧。';
  return communityPage(tools, user, '首页', 'home', [
    `<header class="benben-heading"><h2>犇犇</h2>${tabs}</header>`, mentionStatus(url),
    actor ? `<section class="community-card benben-card">${writeForm('/benben', '发布犇犇', '说点什么', MAX_ACTIVITY_BODY, true)}</section>` : loginLine('发布犇犇'),
    data.rows.length ? data.rows.map(row => feedCard(row, accounts, tools, actor, markdown)).join('') : `<div class="community-card community-empty">${empty}</div>`,
    pageLinks(path, page, data.more),
  ].join(''), aside, true, homeIntro());
}

function renderReplies(rows, accounts, tools, markdown, actor) {
  if (!rows.length) return '<p class="community-empty">还没有回复。</p>';
  return rows.map(row => `<article class="community-reply"${markdown ? ` id="reply-${row.id}" data-benben-quote` : ''}>${postByline(row, accounts, tools)}
    ${markdown ? `<div class="community-markdown prose">${markdown(row)}</div>${actor ? quoteButton(row.name) : ''}` : `<p class="community-text">${htmlEscape(row.body)}</p>`}</article>`).join('');
}

function mentionStatus(url) {
  return url.searchParams.get('mention') === 'retry'
    ? '<p role="status" class="community-card">内容已发布，部分 @ 提醒发送失败。</p>' : '';
}

async function renderActivity(env, user, actor, id, url, page, tools) {
  const reply = Number(url.searchParams.get('reply'));
  const data = await callStore(env, 'social', 'activity', { actor, id, page, reply: Number.isSafeInteger(reply) && reply > 0 ? reply : null });
  const rows = [data.activity, ...data.rows];
  const [accounts, markdown] = await Promise.all([namesFor(env, rows, tools), markdownFor(env, rows, tools)]);
  return communityPage(tools, user, '犇犇详情', 'home', [
    heading('犇犇详情', '<a href="/">返回全站动态</a>'), mentionStatus(url),
    feedCard(data.activity, accounts, tools, actor, markdown, true),
    `<section class="community-card benben-card"><h2>回复</h2>${renderReplies(data.rows, accounts, tools, markdown, actor)}
      ${pageLinks(activityPath(id), data.page, data.more)}
      ${actor ? writeForm(activityPath(id) + '/reply', '回复', '写回复', MAX_ACTIVITY_BODY, true) : loginLine('回复')}</section>`,
  ].join(''), '', true);
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

async function renderMessages(env, user, actor, name, page, url, tools) {
  if (!actor) return tools.redirect('/login');
  if (!name) {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 20);
    const valid = /^[a-zA-Z0-9_\u4e00-\u9fa5]{1,20}$/.test(query);
    const [{ rows, more }, matches] = await Promise.all([
      callStore(env, 'messages', 'inbox', { actor, page }),
      valid ? tools.findMentionUsernames(env, query) : [],
    ]);
    const names = matches.filter(name => name !== actor.name);
    const accounts = await tools.getPublicAuthors(env, names);
    const results = names.map(name => `<li>
      ${tools.authorName(name, accounts)}
      <a class="community-button community-button-quiet" href="${chatPath(name)}" aria-label="给 ${htmlEscape(name)} 发私信">发私信</a>
    </li>`).join('');
    const search = `<section class="community-card">
      <h2>找联系人</h2>
      <form class="community-search" action="/messages" method="get">
        <input name="q" type="search" aria-label="搜索用户名" maxlength="20" placeholder="输入用户名" value="${htmlEscape(query)}">
        <button type="submit" class="community-button">搜索</button>
      </form>
      ${query ? (results ? `<ul class="community-contact-results" aria-label="搜索结果">${results}</ul>`
        : '<p class="community-empty">没有找到匹配的其他用户。</p>') : ''}
    </section>`;
    const inboxUrl = '/messages' + (query ? '?q=' + encodeURIComponent(query) : '');
    return communityPage(tools, user, '私信', 'messages', heading('私信') + search + `
      <section class="community-card community-topic-list">
        <h2 class="community-inbox-title">最近会话</h2>
        ${rows.map(row => `<a class="community-conversation" href="${chatPath(row.name)}">
          <strong>${htmlEscape(row.name)}</strong>${date(row.at)}
          <span>${htmlEscape(row.body.slice(0, 100))}</span>
        </a>`).join('') || '<p class="community-empty">还没有私信。</p>'}
      </section>${pageLinks(inboxUrl, page, more)}`);
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

async function renderRecords(env, user, actor, id, rid, page, tools, mine = false) {
  const problem = id ? tools.problem(id) : null;
  if (id && !problem?.hydroPid) throw new CommunityError('这道题尚未开放评测。', 404);
  const path = id ? '/problems/' + id + '/records' : '/records';
  const back = id ? `<a href="/problems/${id}">返回题面</a>` : '<a href="/problems">浏览题库</a>';
  if (rid) {
    const row = await callStore(env, 'records', 'record', { actor, problem: id, rid });
    if (row.contest) return tools.redirect('/contests/' + row.contest + '/problems/' + row.problem + '/records/' + rid);
    const accountNames = await tools.recordNames(env, [row]);
    const name = accountNames.get(row.owner) || row.name;
    let result;
    let codeNote = '';
    if (row.receipt) {
      const settings = tools.hydroSettings(env);
      const task = tools.problem(row.problem);
      if (settings && task?.hydroPid) {
        try {
          result = await tools.resultFromHydro(settings, { key: row.owner, createdAt: row.accountDate }, task.hydroPid, row.receipt, true);
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
  const data = await callStore(env, 'records', 'list', { actor, problem: id, page, mine });
  const names = await tools.recordNames(env, data.rows);
  const records = data.rows.map(row => {
    const statusClass = row.status === 1 ? ' is-accepted' : Number.isInteger(row.status) && ![0,20,21,22].includes(row.status) ? ' is-judged' : '';
    const href = row.contest ? '/contests/' + row.contest + '/problems/' + row.problem + '/records/' + row.rid : path + '/' + row.rid;
    return `<tr><td>${threadLink(names.get(row.owner) || row.name)}</td><td>${htmlEscape(row.problem)}</td>
      <td><a href="${href}" class="community-record-verdict${statusClass}">${recordStatus(row)}</a></td>
      <td>${recordScore(row.score)}</td><td>${htmlEscape(row.language || '—')}</td><td>${date(row.at)}</td></tr>`;
  }).join('');
  const title = id ? id + ' 提交记录' : '提交记录';
  const tabs = `<nav class="community-tabs" aria-label="提交记录筛选">${selected(!mine,path,'所有人的提交')}
    ${actor ? selected(mine,path+'?view=mine','我的提交') : ''}</nav>`;
  return communityPage(tools, user, title, 'records', heading(title, back) + tabs + `
    <section class="community-card community-table-wrap">
      ${records ? `<table class="community-table"><thead><tr><th>提交者</th><th>题号</th><th>评测结果</th><th>得分</th><th>语言</th><th>提交时间</th></tr></thead>
        <tbody>${records}</tbody></table>` : '<p class="community-empty">还没有提交记录。</p>'}
    </section>${pageLinks(path + (mine ? '?view=mine' : ''), page, data.more)}`);
}

async function readForm(request, limit = 65536) {
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) {
    throw new CommunityError('表单格式不正确。', 415);
  }
  if (Number(request.headers.get('Content-Length')) > limit) throw new CommunityError('内容太长。', 413);
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let message = '';
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
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
  const isMarkdown = path === '/benben' || activity?.[2] === 'reply';
  const form = await readForm(request, isMarkdown ? MAX_ACTIVITY_FORM : undefined);
  const body = form.get('body');
  const enabled = form.get('enabled') === '1';
  await tools.enforceRate(request, env, chat ? 'private-message' : 'community-post', chat ? 20 : 40, user);
  if (path === '/benben') {
    const markdown = activityMarkdown(body);
    const recipients = await tools.mentionRecipients(env, markdown.includes('@') ? tools.parseArticle(markdown).names : []);
    const { id } = await callStore(env, 'social', 'post-activity', { actor, body: markdown });
    const { mentionDeliveryFailed } = await tools.sendMentionNotices(env, user, recipients, { activityId: id, title: '犇犇动态' });
    return tools.redirect(mentionDeliveryFailed ? '/?mention=retry' : '/');
  }
  if (activity) {
    const [, id, verb] = activity;
    if (verb === 'reply') {
      const markdown = activityMarkdown(body);
      const recipients = await tools.mentionRecipients(env, markdown.includes('@') ? tools.parseArticle(markdown).names : []);
      const { id: replyId } = await callStore(env, 'social', 'reply-activity', { actor, id, body: markdown });
      const target = { activityId: itemId(id), replyId, title: '犇犇回复' };
      const { mentionDeliveryFailed } = await tools.sendMentionNotices(env, user, recipients, target);
      return tools.redirect(activityPath(id) + '?reply=' + replyId + (mentionDeliveryFailed ? '&mention=retry' : '') + '#reply-' + replyId);
    }
    const action = verb === 'like' ? verb : verb + '-activity';
    await callStore(env, 'social', action, { actor, id, body, enabled });
    return tools.redirect(verb === 'like' && url.searchParams.get('thread') === '1' ? activityPath(id) : '/');
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

async function renderSiteStats(env, user, actor, tools) {
  if (!actor) return tools.redirect('/login');
  if (!actor.root) throw new CommunityError('只有站主可以查看统计。',403);
  const day = localDay.format(Date.now());
  const since = Date.parse(day + 'T00:00:00+08:00');
  const [users, records, ...shards] = await Promise.all([
    tools.accountCount(env),
    callStore(env,'records','count',{actor,since}),
    ...Array.from({length:8},(_,i)=>callStore(env,'stats','read',{actor,day},'site-stats:'+i)),
  ]);
  const visits = shards.reduce((sum,item)=>sum+item.visits,0);
  const today = shards.reduce((sum,item)=>sum+item.today,0);
  const cells = [['注册账号',users],['总访问量',visits],['今日访问量',today],['总评测提交',records.submissions],['今日评测提交',records.today]];
  return communityPage(tools,user,'站点统计','stats',heading('站点统计')+`
    <div class="site-stat-grid">${cells.map(([label,value])=>`<section class="community-card"><h2>${label}</h2><strong>${value}</strong></section>`).join('')}</div>
    <section class="community-card"><p>访问量从统计功能上线开始计数。刷新页面也计一次。今日按北京时间计算。</p>
      <p>评测提交包括题库练习与比赛，以本站收录的提交记录为准。</p></section>`);
}

export async function communityRoute(request, env, user, tools) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const actor = identity(user);
  const page = pageNumber(url.searchParams.get('page'));
  try {
    if (path === '/contests' || path.startsWith('/contests/')) {
      return await contestPage(request,user,actor,{
        ...tools, readForm, targetAccount:name=>targetAccount(env,name,tools),
        store:(action,args)=>callContestStore(env,action,args),
        hydroSettings:()=>tools.hydroSettings(env),
        page:(viewer,title,body,math=false)=>communityPage(tools,viewer,title,'contests',body,'',math),
      });
    }
    if (request.method === 'POST') return await postCommunity(request, env, user, actor, path, url, tools);
    if (request.method !== 'GET') return null;
    if (path === '/' && env.COMMUNITY_STORE) return await renderFeed(env, user, actor, url, page, tools);
    if (path === '/discuss') return await renderForums(env, user, actor, url, page, tools);
    if (path === '/discuss/new') return actor ? renderNewTopic(tools, user, actor, url.searchParams.get('board')) : tools.redirect('/login');
    if (path === '/members') return await renderMembers(env, user, url, tools);
    if (path === '/admin/stats') return await renderSiteStats(env,user,actor,tools);
    const activity = /^\/benben\/(\d+)$/.exec(path);
    if (activity) return await renderActivity(env, user, actor, activity[1], url, page, tools);
    const topic = /^\/discuss\/(\d+)$/.exec(path);
    if (topic) return await renderTopic(env, user, actor, topic[1], page, tools);
    const chat = /^\/messages(?:\/([^/]+))?$/.exec(path);
    if (chat) return await renderMessages(env, user, actor, chat[1] && decodeURIComponent(chat[1]), page, url, tools);
    const records = /^\/problems\/([A-Z0-9]+)\/records(?:\/([a-z0-9]+))?$/i.exec(path);
    const allRecords = /^\/records(?:\/([a-z0-9]+))?$/.exec(path);
    if (records || allRecords) {
      const rid = records?.[2] ?? allRecords?.[1];
      if (rid && !RECORD_ID.test(rid)) throw new CommunityError('提交记录不存在。', 404);
      const mine = url.searchParams.get('view') === 'mine';
      if (mine && !actor) return tools.redirect('/login');
      return await renderRecords(env,user,actor,records?.[1].toUpperCase(),rid,page,tools,mine);
    }
    return null;
  } catch (error) {
    if (error instanceof URIError) return tools.text('链接无效。', 400);
    if (!(error instanceof CommunityError || error instanceof ContestError)) throw error;
    return tools.html(tools.layout({ user, title: '社区', community: true, body:
      `<section class="community-layout"><div class="community-card"><p>${htmlEscape(error.message)}</p><a href="/">返回首页</a></div></section>`,
    }), error.status);
  }
}

const benbenQuoteScript = String.raw`(() => {
  const composer = document.getElementById('benben-composer');
  const field = composer.elements.body;
  const status = composer.querySelector('.benben-quote-status');
  let request;

  function report(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  async function quoteSource(button, signal) {
    if (!button.dataset.quoteUrl) {
      return button.closest('[data-benben-quote]')?.querySelector('.community-markdown');
    }
    const response = await fetch(button.dataset.quoteUrl, { signal });
    if (!response.ok) throw new Error('Quote source is unavailable');
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    return page.querySelector('[data-benben-quote] .community-markdown');
  }

  function quoteText(source) {
    if (!source) throw new Error('Quote text is unavailable');
    const copy = source.cloneNode(true);
    copy.querySelectorAll('.code-bar, .code-gutter, .katex-html, annotation').forEach(node => node.remove());
    for (const image of copy.querySelectorAll('img')) image.replaceWith(image.alt || '图片');
    for (const lineBreak of copy.querySelectorAll('br')) lineBreak.replaceWith(' ');
    for (const block of copy.querySelectorAll('p, li, blockquote, pre, h1, h2, h3, h4, th, td')) block.append(' ');
    return copy.textContent.replace(/\s+/g, ' ').trim() || '查看原动态';
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-quote-author]');
    if (!button) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    report('');
    try {
      const excerpt = quoteText(await quoteSource(button, controller.signal));
      if (controller.signal.aborted) return;
      const draft = field.value;
      const quote = '|| @' + button.dataset.quoteAuthor + ' : ' + excerpt;
      if (!draft.endsWith(quote)) {
        const addition = (draft.trim() ? '\n\n' : ' ') + quote;
        if (draft.length + addition.length > field.maxLength) {
          report('输入框剩余空间不足，无法加入这段引用。');
        } else {
          field.setRangeText(addition, draft.length, draft.length, 'start');
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      composer.scrollIntoView({ block: 'center' });
      field.focus({ preventScroll: true });
    } catch {
      if (controller.signal.aborted) return;
      report('暂时无法加载引用，请重试。');
      composer.scrollIntoView({ block: 'center' });
    }
  });
})();`;

export const communityCss = contestCss + `
.community-layout{max-width:960px;margin:38px auto 76px;display:grid;gap:22px;color:var(--night-text)}
.community-layout.has-aside{grid-template-columns:minmax(0,1fr) 220px}
.community-main{min-width:0;display:grid;gap:14px;align-content:start}
.community-heading,.community-tabs,.community-pages,.community-trail{
  color:var(--night-text);background:var(--night-panel);border:1px solid #4e6a82;border-radius:10px;
}
.community-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 14px;padding:13px 17px}
.community-heading h1{font-size:clamp(1.65rem,4.6vw,2.6rem);line-height:1.18;margin:0;overflow-wrap:anywhere}
.community-heading>a,.community-tabs a,.community-pages a,.community-trail a{
  color:#aff4f8;text-underline-offset:.24em;
}
.community-heading>a{white-space:nowrap}
.community-layout :focus-visible,.community-profile :focus-visible{outline-color:var(--blue)}
.community-card{min-width:0;border:1px solid color-mix(in srgb,var(--ink) 24%,transparent);background:var(--paper);
  color:var(--ink);border-radius:12px;padding:17px 19px;box-shadow:0 3px 0 color-mix(in srgb,var(--ink) 9%,transparent)}
.community-card h2{font-size:1.02rem;margin:0 0 12px}
.community-sidebar-card{display:grid;gap:5px}
.community-sidebar-card h2{margin:0 0 6px}
.community-sidebar-card a{border-radius:6px;padding:7px 8px;text-decoration:none}
.community-sidebar-card a:hover{background:var(--paper-alt)}
.community-tabs,.community-actions,.community-byline,.community-pages{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.community-tabs{padding:0 10px}
.community-tabs a{font-weight:700;text-decoration:none;border-bottom:2px solid transparent;padding:9px 6px}
.community-tabs a[aria-current=page]{border-color:var(--neon);color:var(--night-text)}
.community-byline{gap:5px 12px;font-size:.88rem}
.community-byline time,.community-conversation time,.community-reply-count,.community-empty{color:var(--gray)}
.community-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.66;margin:10px 0}
.community-markdown{min-width:0;overflow-wrap:anywhere;margin:12px 0}
.community-markdown>:first-child{margin-top:0}
.community-markdown>:last-child{margin-bottom:0}
.community-markdown img{max-width:100%;height:auto}
.community-markdown-compose .editor-toolbar{overflow:visible;flex-wrap:wrap}
.community-markdown-compose #content-input{
  position:static;inset:auto;height:auto;min-height:110px;resize:vertical;
  background:var(--paper-alt);border:1px solid #a0afa9;border-radius:7px;
}
.community-reply:target{outline:2px solid var(--link);outline-offset:4px;scroll-margin-top:104px}
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
.community-heading .community-button,.community-profile .community-button{
  background:#17384a;color:#d3f8fa;border-color:#5c8196;
}
.community-heading .community-button:hover,.community-profile .community-button:hover{border-color:var(--neon)}
.community-pages{justify-content:center;margin:7px 0;padding:7px 10px}
.community-pages span,.community-trail{color:var(--night-muted);font-size:.88rem}
.community-trail{padding:8px 12px}
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
.community-contact-results{margin:10px 0 0;padding:0;list-style:none}
.community-contact-results li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #c6cdc9}
.community-contact-results li:last-child{border-bottom:0}
.community-topic-list .community-inbox-title{margin:10px 0 4px}
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
.community-profile{margin-top:12px;color:var(--night-text)}
.community-home-intro{
  max-width:960px;margin:32px auto 0;display:grid;grid-template-columns:minmax(0,1fr) 215px;align-items:center;gap:20px;
  padding:clamp(26px,4vw,48px);border:3px solid #201d22;border-radius:0;color:#201d22;
  background:repeating-linear-gradient(132deg,transparent 0 31px,#6b3c810c 32px 33px),
    linear-gradient(109deg,#ffe092 5%,#ffc49a 54%,#ead9ff 100%);
  box-shadow:7px 7px 0 #201d22;
}
.community-home-copy h1{font-size:clamp(2rem,5vw,3.45rem);line-height:1.13;margin:0;color:#201d22}
.community-home-copy p{color:#4d3747;margin:9px 0 16px;font-size:.96rem}
.community-home-links{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px}
.community-home-links a,.community-home-shortcuts a{color:#271d31;text-decoration:none}
.community-home-links a{padding:6px 11px;border:1px solid #443349;background:#fff7df;font-size:.84rem;font-weight:720}
.community-home-links a:first-child{color:#fff7df;background:#352548;border-color:#352548}
.community-home-links a:hover,.community-home-shortcuts a:hover{border-color:#352548;text-decoration:underline}
.community-home-shortcuts{display:grid;gap:7px;min-width:0}
.community-home-shortcuts a{
  display:grid;grid-template-columns:1fr auto;gap:3px 7px;padding:9px 11px;
  border:1px solid #5a425c;background:#fff6e5;font-size:.85rem;
}
.community-home-shortcuts a span:first-child{grid-column:1/-1;color:#68495e;font-size:.72rem}
.homepage-pins{margin-bottom:10px}
.homepage-pins a{overflow-wrap:anywhere}
.community-home-intro+.community-layout{margin-top:18px;gap:16px}
.community-home-intro+.community-layout .community-main{gap:9px}
.benben-heading{
  display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:4px 9px;
  background:var(--night-panel);border:1px solid #4e6a82;border-radius:8px;
}
.benben-heading h2{font-size:1.08rem;margin:0;color:var(--night-text)}
.benben-heading .community-tabs{gap:6px;padding:0 3px;border:0}
.benben-heading .community-tabs a{font-size:.79rem;padding:6px 4px}
.benben-card{padding:9px 13px;border-radius:8px;font-size:.88rem}
.benben-card .community-byline{font-size:.78rem}
.benben-card .community-markdown{font-size:.88rem;line-height:1.55;margin:7px 0}
.benben-card .community-markdown :is(h1,h2,h3){font-size:1rem;margin-top:12px}
.benben-card .community-actions{font-size:.77rem;gap:5px 10px}
.benben-card .community-button-quiet{font-size:.76rem;padding:3px 6px}
.benben-reply-button{color:var(--link);border-color:transparent}
.benben-reply-button:hover{background:var(--paper-alt);text-decoration:underline}
.benben-composer{gap:6px;scroll-margin-top:96px}
.benben-composer label{font-size:.83rem}
.benben-composer .editor-toolbar{border:0;padding:2px 0 3px;gap:4px;background:transparent}
.benben-composer .tb-btn{min-width:26px;height:26px;padding:0 5px;font-size:.77rem;border-width:1px;border-radius:4px}
.benben-composer #content-input{min-height:70px;font-size:.88rem;padding:7px 9px;line-height:1.5;overflow:auto}
.benben-composer>.community-button{font-size:.8rem;padding:4px 9px}
.benben-quote-status{margin:0;color:var(--ink);font-size:.8rem}
@media(max-width:760px){
  .community-layout,.community-layout.has-aside{grid-template-columns:minmax(0,1fr);margin-top:24px}
  .community-card{padding:13px 12px}
  .community-heading{padding:12px}
  .community-home-intro{margin-top:22px;grid-template-columns:minmax(0,1fr);gap:12px;padding:15px}
  .community-home-shortcuts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .benben-card{padding:9px 10px}
}
`;
