export class ContestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const contestSchema = [
  `CREATE TABLE IF NOT EXISTS contests (
    slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, tasks TEXT NOT NULL,
    organizer TEXT NOT NULL, organizer_name TEXT NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL,
    published INTEGER NOT NULL, updated INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS contests_published ON contests(published, starts DESC, slug)',
  `CREATE TABLE IF NOT EXISTS contest_members (
    contest TEXT NOT NULL, actor TEXT NOT NULL, name TEXT NOT NULL, joined INTEGER NOT NULL,
    PRIMARY KEY(contest, actor)
  )`,
  `CREATE TABLE IF NOT EXISTS contest_attempts (
    rid TEXT PRIMARY KEY, contest TEXT NOT NULL, actor TEXT NOT NULL, problem TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS contest_attempts_member ON contest_attempts(contest, actor, problem, rid DESC)',
  'CREATE INDEX IF NOT EXISTS records_recent ON records(at DESC, rid DESC)',
  'CREATE INDEX IF NOT EXISTS records_owner ON records(owner, account_date, at DESC, rid DESC)',
  `CREATE TABLE IF NOT EXISTS judge_refresh (
    rid TEXT PRIMARY KEY, pid TEXT NOT NULL, due INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS judge_refresh_due ON judge_refresh(due, rid)',
];

export const statsSchema = [
  'CREATE TABLE IF NOT EXISTS site_views (day TEXT PRIMARY KEY, views INTEGER NOT NULL)',
];

const slugFormat = /^[a-z0-9][a-z0-9-]{0,39}$/;
const idFormat = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;
const hydroFormat = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ridFormat = /^[0-9a-f]{24}$/;
const contestTaskLimit = 26;
const pageSize = 24;
const pending = [0, 20, 21, 22];
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
});
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);

export function contestPurpose(slug, id) {
  return 'contest:' + slug + ':' + id;
}

function path(slug) { return '/contests/' + slug; }
function account(row) { return JSON.stringify([row.owner, row.account_date]); }
function manager(contest, actor) { return Boolean(actor && (actor.admin || contest.organizer === actor.id)); }
function rootOnly(actor) {
  if (!actor?.root) throw new ContestError('只有站主可以管理比赛。', actor ? 403 : 401);
}
function mustManager(contest, actor) {
  if (!manager(contest, actor)) throw new ContestError('只有这场比赛的组织者和管理员可以查看。', actor ? 403 : 401);
}
function getContest(store, slug, actor) {
  if (!slugFormat.test(slug)) throw new ContestError('比赛不存在。', 404);
  const contest = store.row('SELECT * FROM contests WHERE slug = ?', slug);
  if (!contest || (!contest.published && !manager(contest, actor))) throw new ContestError('比赛不存在。', 404);
  return { ...contest, tasks: JSON.parse(contest.tasks) };
}
function getTask(contest, id) {
  const task = contest.tasks.find(item => item.id === id);
  if (!task) throw new ContestError('这道题不在本场比赛中。', 404);
  return task;
}
function canReadTasks(contest, actor, now = Date.now()) {
  return manager(contest, actor) || (contest.published && now >= contest.starts);
}
function timePage(value) { return Math.min(500, Math.max(1, Number.parseInt(value, 10) || 1)); }
function pageRows(store, query, params, page) {
  const rows = store.rows(query + ' LIMIT ? OFFSET ?', ...params, pageSize + 1, (timePage(page) - 1) * pageSize);
  return { rows: rows.slice(0, pageSize), more: rows.length > pageSize };
}

function editContest(store, args) {
  rootOnly(args.actor);
  const data = args.data;
  if (!slugFormat.test(data.slug) || !data.title || data.title.length > 100 || !data.organizer || !Array.isArray(data.tasks)) {
    throw new ContestError('比赛名称、编号或组织者无效。');
  }
  if (!Number.isSafeInteger(data.starts) || !Number.isSafeInteger(data.ends) || data.starts >= data.ends) {
    throw new ContestError('结束时间须晚于开始时间。');
  }
  if (!data.tasks.length || data.tasks.length > contestTaskLimit ||
      data.tasks.some(task => !idFormat.test(task.id) || !hydroFormat.test(task.hydroPid) || !task.title) ||
      new Set(data.tasks.map(task => task.id)).size !== data.tasks.length ||
      new Set(data.tasks.map(task => task.hydroPid)).size !== data.tasks.length) {
    throw new ContestError(`请填写 1 至 ${contestTaskLimit} 道题，每道题的编号与 Hydro 题号须唯一。`);
  }
  const previous = store.row('SELECT * FROM contests WHERE slug = ?', data.slug);
  if (Boolean(previous) !== Boolean(args.edit)) throw new ContestError(previous ? '这个比赛编号已存在。' : '比赛不存在。', previous ? 409 : 404);
  const taskList = JSON.stringify(data.tasks);
  if (new TextEncoder().encode(taskList).byteLength > 1_500_000) {
    throw new ContestError('题目列表内容过长，请精简部分题面。',413);
  }
  if (previous?.published && Date.now() >= previous.starts) {
    const before = JSON.parse(previous.tasks).map(task => [task.id, task.hydroPid]);
    const after = data.tasks.map(task => [task.id, task.hydroPid]);
    if (previous.starts !== data.starts || previous.ends !== data.ends || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new ContestError('已开始的比赛可以更新介绍及题面，赛程与题目编号已锁定。', 409);
    }
    if (!data.published) throw new ContestError('已开始的比赛不能撤回为草稿。', 409);
  }
  store.sql.exec(`INSERT INTO contests(slug,title,description,tasks,organizer,organizer_name,starts,ends,published,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET
    title=excluded.title,description=excluded.description,tasks=excluded.tasks,organizer=excluded.organizer,
    organizer_name=excluded.organizer_name,starts=excluded.starts,ends=excluded.ends,published=excluded.published,updated=excluded.updated`,
    data.slug, data.title, data.description, taskList, data.organizer.id, data.organizer.name,
    data.starts, data.ends, Number(data.published), Date.now());
  return {};
}

function scoreRows(store, contest, page) {
  return pageRows(store, `WITH best AS (
    SELECT a.actor, a.problem, max(r.score) AS score
      FROM contest_attempts a JOIN records r ON r.rid=a.rid
      WHERE a.contest=? AND r.status NOT IN (0,20,21,22) AND r.score IS NOT NULL GROUP BY a.actor,a.problem
    ), totals AS (
      SELECT actor, sum(score) AS total, json_group_object(problem,score) AS scores FROM best GROUP BY actor
    ), ranking AS (
      SELECT m.actor,m.name,COALESCE(t.total,0) AS total,t.scores,
      RANK() OVER (ORDER BY COALESCE(t.total,0) DESC) AS rank
      FROM contest_members m LEFT JOIN totals t ON t.actor=m.actor WHERE m.contest=?
    ) SELECT * FROM ranking ORDER BY rank,actor`, [contest.slug, contest.slug], page);
}

export function storedContest(store, action, args) {
  const { actor } = args;
  if (action === 'list') {
    return pageRows(store,`SELECT slug,title,organizer_name,starts,ends,published FROM contests
      WHERE published=1 OR organizer=? OR ?=1 ORDER BY starts DESC,slug`, [actor?.id ?? '', Number(Boolean(actor?.admin))], args.page);
  }
  if (action === 'edit') return editContest(store, args);
  const contest = getContest(store, args.slug, actor);
  const member = actor && Boolean(store.row('SELECT 1 FROM contest_members WHERE contest=? AND actor=?', contest.slug, actor.id));
  if (action === 'get') {
    const tasksVisible = canReadTasks(contest, actor);
    return {
      ...contest, tasks: !tasksVisible ? [] : args.full ? contest.tasks :
        contest.tasks.map(({id,title,hydroPid}) => ({id,title,hydroPid})),
      member, management: manager(contest, actor), canReadTasks: tasksVisible,
    };
  }
  if (action === 'join') {
    if (!actor) throw new ContestError('请先登录。',401);
    if (!contest.published || Date.now() >= contest.ends) throw new ContestError('本场比赛已停止报名。', 409);
    store.sql.exec('INSERT OR IGNORE INTO contest_members(contest,actor,name,joined) VALUES (?,?,?,?)', contest.slug,actor.id,actor.name,Date.now());
    return {};
  }
  if (!canReadTasks(contest, actor)) throw new ContestError('比赛开始后可查看此页面。',403);
  if (action === 'rank') {
    return scoreRows(store, contest, args.page);
  }
  if (action === 'audit') {
    mustManager(contest, actor);
    getTask(contest, args.problem);
    return pageRows(store, `SELECT r.rid,r.name,r.status,r.verdict,r.score,r.language,r.at FROM contest_attempts a JOIN records r ON r.rid=a.rid
      WHERE a.contest=? AND a.actor=? AND a.problem=? ORDER BY r.at DESC,r.rid DESC`,
      [contest.slug,args.target,args.problem],args.page);
  }
  const task = getTask(contest, args.problem);
  if (action === 'task') return { task: { hydroPid:task.hydroPid } };
  if (action === 'gate') {
    if (!actor) throw new ContestError('请先登录。', 401);
    const now = Date.now();
    if (!contest.published || now < contest.starts || now >= contest.ends) throw new ContestError('当前不在比赛提交时段。', 403);
    if (!member) throw new ContestError('请先报名参加比赛。', 403);
    return { task: { hydroPid:task.hydroPid }, at: now };
  }
  if (action === 'history') {
    if (!actor) throw new ContestError('请先登录。', 401);
    const { rows, more } = pageRows(store, `SELECT r.receipt,r.at AS submittedAt,r.verdict,r.status,r.score,r.language FROM contest_attempts a JOIN records r ON r.rid=a.rid
      WHERE a.contest=? AND a.actor=? AND a.problem=? ORDER BY r.at DESC,r.rid DESC`,
      [contest.slug,actor.id,task.id],args.page);
    const best = store.row(`SELECT max(r.score) AS highest FROM contest_attempts a JOIN records r ON r.rid=a.rid
      WHERE a.contest=? AND a.actor=? AND a.problem=? AND r.status NOT IN (0,20,21,22)`, contest.slug,actor.id,task.id);
    return { records: rows.map(row=>({...row,verdict:row.verdict || '等待评测结果',pending:row.status === null || pending.includes(row.status)})),
      highest:best.highest, cursor:more ? String(timePage(args.page)+1) : null };
  }
  if (action === 'attach') {
    if (!member || !contest.published || args.row.at < contest.starts || args.row.at >= contest.ends ||
        account({owner:args.row.owner,account_date:args.row.accountDate}) !== actor.id) {
      throw new ContestError('这次提交无法计入本场比赛。', 409);
    }
    store.ctx.storage.transactionSync(() => {
      store.insertRecord(args.row);
      store.sql.exec('INSERT OR IGNORE INTO contest_attempts(rid,contest,actor,problem) VALUES (?,?,?,?)',
        args.row.rid,contest.slug,actor.id,task.id);
      store.sql.exec('INSERT OR IGNORE INTO judge_refresh(rid,pid,due) VALUES (?,?,?)',args.row.rid,task.hydroPid,Date.now()+1200);
    });
    return {};
  }
  if (action === 'complete') {
    const existing = store.row('SELECT contest,actor,problem FROM contest_attempts WHERE rid=?',args.row.rid);
    if (!existing) return storedContest(store,'attach',args);
    if (existing.contest !== contest.slug || existing.actor !== actor?.id || existing.problem !== task.id) {
      throw new ContestError('找不到这次比赛提交。',404);
    }
    store.ctx.storage.transactionSync(() => {
      store.insertRecord(args.row);
      if (Number.isInteger(args.row.status) && !pending.includes(args.row.status)) {
        store.sql.exec('DELETE FROM judge_refresh WHERE rid=?',args.row.rid);
      }
    });
    return {};
  }
  if (action !== 'record') throw new ContestError('页面不存在。', 404);
  const row = store.row(`SELECT r.* FROM contest_attempts a JOIN records r ON r.rid=a.rid
    WHERE a.contest=? AND a.problem=? AND a.rid=?`,contest.slug,task.id,args.rid);
  if (!row) throw new ContestError('找不到这次比赛提交。', 404);
  const {receipt, account_date, ...visible} = row;
  const mayRead = Boolean(actor && (account(row) === actor.id || manager(contest, actor)));
  return { ...visible, ...(mayRead ? {receipt,accountDate:account_date} : {}), task: {hydroPid:task.hydroPid} };
}

export async function scheduleJudgeRefresh(store) {
  const next = store.row('SELECT min(due) AS due FROM judge_refresh')?.due;
  if (next === null || next === undefined || !store.ctx.storage.getAlarm) return;
  const current = await store.ctx.storage.getAlarm();
  if (current === null || current > next) await store.ctx.storage.setAlarm(Math.max(next, Date.now() + 500));
}

export async function refreshPendingJudges(store, env, hydroSettings, resultFromHydro) {
  const jobs = store.rows(`SELECT q.rid,q.pid,q.tries,r.owner,r.account_date,r.receipt,r.status,a.contest,a.problem
    FROM judge_refresh q JOIN records r ON r.rid=q.rid LEFT JOIN contest_attempts a ON a.rid=q.rid
    WHERE q.due<=? ORDER BY q.due LIMIT 12`,Date.now());
  const settings = hydroSettings(env);
  await Promise.all(jobs.map(async job => {
    const { rid } = job;
    if (job.status !== null && !pending.includes(job.status)) {
      store.sql.exec('DELETE FROM judge_refresh WHERE rid=?',rid);
      return;
    }
    try {
      const result = settings && await resultFromHydro(settings,{key:job.owner,createdAt:job.account_date},job.pid,job.receipt,false,
        job.contest ? contestPurpose(job.contest,job.problem) : job.pid);
      if (result && !result.pending) {
        store.sql.exec(`UPDATE records SET status=?,verdict=?,score=?,language=COALESCE(?,language),time_ms=?,memory_kib=? WHERE rid=?`,
          result.status,result.verdict,result.score,result.language ?? null,result.timeMs,result.memoryKiB,rid);
        store.sql.exec('DELETE FROM judge_refresh WHERE rid=?',rid);
        return;
      }
    } catch (error) {
      console.warn('Judge refresh delayed:',error?.message);
    }
    const delay = Math.min(300000, 6000 * 2 ** Math.min(job.tries,6));
    if (job.tries >= 24) {
      store.sql.exec('DELETE FROM judge_refresh WHERE rid=?',rid);
    } else {
      store.sql.exec('UPDATE judge_refresh SET due=?,tries=tries+1 WHERE rid=?',Date.now()+delay,rid);
    }
  }));
  await scheduleJudgeRefresh(store);
}

function localInput(timestamp) { return new Date(timestamp + 8*3600000).toISOString().slice(0,16); }
function fromInput(value) {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value || '') ? Date.parse(value + ':00+08:00') : NaN;
}
function displayDate(timestamp) { return dateFormatter.format(timestamp); }
function phase(contest) {
  const now = Date.now();
  if (!contest.published) return '草稿';
  if (now < contest.starts) return '报名中';
  return now < contest.ends ? '进行中' : '已结束';
}
function titleBlock(title, actions = '') {
  return `<header class="community-heading"><h1>${esc(title)}</h1>${actions}</header>`;
}
function tabs(contest, active, actor) {
  const base = path(contest.slug);
  const items = [['home',base,'比赛主页'],['problems',base+'/problems','题目列表'],['rank',base+'/rank','排行榜']];
  if (actor?.root) items.push(['edit',base+'/edit','编辑比赛']);
  return `<nav class="community-tabs" aria-label="比赛导航">${items.map(([section,href,text]) =>
    `<a href="${href}"${section===active ? ' aria-current="page"' : ''}>${text}</a>`).join('')}</nav>`;
}
function paged(url, page, more) {
  const target = (n) => esc(url + (url.includes('?') ? '&' : '?') + 'page=' + n);
  if (page===1 && !more) return '';
  return `<nav class="community-pages" aria-label="分页">${page>1?`<a href="${target(page-1)}">上一页</a>`:''}
    <span>第 ${page} 页</span>${more && page<500?`<a href="${target(page+1)}">下一页</a>`:''}</nav>`;
}
const memberLink = (name) => '<a href="/users/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
const statusText = (row) => esc(row.verdict || '等待评测结果');

function taskEditor(task = {}) {
  return `<fieldset class="community-card contest-task-editor">
    <label>比赛题号<input name="task_id" maxlength="24" placeholder="如 P1001 或 A" value="${esc(task.id)}"></label>
    <label>Hydro 题号<input name="task_pid" maxlength="64" placeholder="题库中的题目可留空" value="${esc(task.hydroPid)}"></label>
    <label>标题<input name="task_title" maxlength="120" value="${esc(task.title)}"></label>
    <label>自定义题面（Markdown）<textarea name="task_statement" rows="4" maxlength="50000">${esc(task.statementOverride)}</textarea></label>
    <div class="community-actions">
      <button type="button" class="community-button community-button-quiet" data-move-task="up">上移</button>
      <button type="button" class="community-button community-button-quiet" data-move-task="down">下移</button>
      <button type="button" class="community-button community-button-quiet" data-remove-task>移除这道题</button>
    </div>
  </fieldset>`;
}

function editPage(contest, user, tools) {
  const base = contest ? path(contest.slug) : '/contests/new';
  const starts = contest?.starts ?? Date.now() + 3600000;
  const ends = contest?.ends ?? starts + 7200000;
  const tasks = contest?.tasks ?? [ {} ];
  const options = tools.catalog().filter(problem=>problem.hydroPid).map(problem=>`<li>${esc(problem.id)} · ${esc(problem.title)}</li>`).join('');
  return titleBlock(contest ? '编辑比赛' : '新建比赛', '<a href="/contests">返回比赛列表</a>') + `
    <form method="post" action="${base}${contest ? '/edit' : ''}" id="contest-editor" class="community-compose">
      <section class="community-card community-compose">
        <label>比赛编号<input name="slug" required maxlength="40" pattern="[a-z0-9][a-z0-9-]{0,39}" ${contest ? 'readonly' : ''} value="${esc(contest?.slug)}"></label>
        <label>比赛名称<input name="title" required maxlength="100" value="${esc(contest?.title)}"></label>
        <label>组织者用户名<input name="organizer" required maxlength="20" value="${esc(contest?.organizer_name || user.username)}"></label>
        <div class="contest-form-times">
          <label>开始时间（北京时间）<input type="datetime-local" name="starts" required value="${localInput(starts)}"></label>
          <label>结束时间（北京时间）<input type="datetime-local" name="ends" required value="${localInput(ends)}"></label>
        </div>
        <label>比赛介绍（Markdown）<textarea name="description" maxlength="20000" rows="5">${esc(contest?.description)}</textarea></label>
        <label class="contest-published"><input type="checkbox" name="published" value="1" ${contest?.published ? 'checked' : ''}>公开比赛</label>
      </section>
      <section class="community-card community-compose">
        <h2>比赛题目</h2>
        <p>引用题库题目时，填写比赛题号即可。自建题目需填写对应的 Hydro 题号、标题和题面。题目顺序与下方一致。</p>
        ${contest ? '' : `<label>导入比赛草稿（JSON）<input type="file" id="contest-import" accept=".json,application/json"></label>
          <p id="contest-import-status" role="status" hidden></p>`}
        <details><summary>可引用的站内题目</summary><ul>${options}</ul></details>
        <div class="contest-task-list" id="contest-tasks">${tasks.map(taskEditor).join('')}</div>
        <template id="contest-task-template">${taskEditor()}</template>
        <button type="button" class="community-button community-button-quiet" id="add-contest-task">添加题目</button>
      </section>
      <button type="submit" class="community-button">保存比赛</button>
    </form>
    <script>(() => {
      const form = document.getElementById('contest-editor');
      const list = document.getElementById('contest-tasks');
      const template = document.getElementById('contest-task-template');
      const limit = ${contestTaskLimit};
      document.getElementById('add-contest-task').addEventListener('click', () => {
        if (list.children.length < limit) list.append(template.content.cloneNode(true));
      });
      list.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        const row = button.closest('fieldset');
        if (button.hasAttribute('data-remove-task')) row.remove();
        if (button.dataset.moveTask === 'up' && row.previousElementSibling) list.insertBefore(row,row.previousElementSibling);
        if (button.dataset.moveTask === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling,row);
      });
      const importInput = document.getElementById('contest-import');
      if (importInput) importInput.addEventListener('change', async () => {
        const file = importInput.files[0];
        if (!file) return;
        const status = document.getElementById('contest-import-status');
        status.hidden = false;
        const string = (value, max) => typeof value === 'string' && value.length <= max;
        try {
          if (file.size > 1_500_000) throw new Error('文件过大。');
          const draft = JSON.parse(await file.text());
          if (!draft || !string(draft.slug,40) || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(draft.slug) ||
              !string(draft.title,100) || !draft.title.trim() || !string(draft.description,20000) ||
              !Array.isArray(draft.tasks) || !draft.tasks.length || draft.tasks.length > limit ||
              !draft.tasks.every(task => task && string(task.id,24) && /^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(task.id) &&
                string(task.hydroPid,64) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.hydroPid) &&
                string(task.title,120) && task.title.trim() && string(task.statementOverride,50000) && task.statementOverride.trim()) ||
              new Set(draft.tasks.map(task => task.id)).size !== draft.tasks.length ||
              new Set(draft.tasks.map(task => task.hydroPid)).size !== draft.tasks.length) {
            throw new Error('文件中的比赛、题目编号或题面无效。');
          }
          const rows = document.createDocumentFragment();
          for (const task of draft.tasks) {
            const row = template.content.cloneNode(true);
            row.querySelector('[name=task_id]').value = task.id;
            row.querySelector('[name=task_pid]').value = task.hydroPid;
            row.querySelector('[name=task_title]').value = task.title;
            row.querySelector('[name=task_statement]').value = task.statementOverride;
            rows.append(row);
          }
          form.elements.slug.value = draft.slug;
          form.elements.title.value = draft.title;
          form.elements.description.value = draft.description;
          form.elements.published.checked = false;
          list.replaceChildren(rows);
          status.textContent = '已载入 ' + draft.tasks.length + ' 道题。保存后为未公开草稿。';
        } catch (error) {
          status.textContent = error instanceof SyntaxError ? '无法读取有效的 JSON。' : error.message;
        } finally {
          importInput.value = '';
        }
      });
    })();</script>`;
}

async function readContestEdit(request, user, actor, slug, tools) {
  rootOnly(actor);
  const form = await tools.readForm(request,3_000_000);
  const organizer = await tools.targetAccount(form.get('organizer')?.trim() || user.username);
  const ids = form.getAll('task_id');
  const pids = form.getAll('task_pid');
  const titles = form.getAll('task_title');
  const statements = form.getAll('task_statement');
  if (ids.length > contestTaskLimit || [pids,titles,statements].some(values=>values.length!==ids.length)) {
    throw new ContestError(`题目列表格式无效，最多 ${contestTaskLimit} 道题。`);
  }
  const tasks = ids.map((value,index) => {
    const id = value.trim().toUpperCase();
    const catalog = tools.problem(id);
    const hydroPid = pids[index].trim() || catalog?.hydroPid;
    const title = titles[index].trim() || catalog?.title;
    const statementOverride = statements[index].trim();
    if (!idFormat.test(id) || !hydroFormat.test(hydroPid || '') || !title || title.length>120 ||
        (!statementOverride && !catalog?.statement) || statementOverride.length>50000) {
      throw new ContestError('请检查题目 ' + (id || index+1) + ' 的 Hydro 题号、标题和题面。');
    }
    return { id,hydroPid,title,statementOverride };
  });
  const description = form.get('description') || '';
  if (description.length>20000) throw new ContestError('比赛介绍过长。');
  const data = { slug:slug || (form.get('slug')||'').trim(),title:(form.get('title')||'').trim(),organizer,tasks,description,
    starts:fromInput(form.get('starts')),ends:fromInput(form.get('ends')),published:form.get('published')==='1' };
  await tools.store('edit',{actor,data,edit:Boolean(slug)});
  return tools.redirect(path(data.slug));
}

function judgeTable(rows, contest, task, target) {
  return `<div class="community-card community-table-wrap">
    ${rows.length ? `<table class="community-table"><thead><tr>
      <th>提交者</th><th>状态</th><th>分数</th><th>语言</th><th>时间</th><th>详情</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${memberLink(r.name)}</td><td>${statusText(r)}</td><td>${esc(r.score ?? '—')}</td><td>${esc(r.language ?? '—')}</td>
      <td>${displayDate(r.at)}</td><td><a href="${path(contest.slug)}/problems/${task.id}/records/${r.rid}">${target ? '查看源码' : '查看'}</a></td></tr>`).join('')}
    </tbody></table>` : '<p>暂无提交。</p>'}</div>`;
}

function rankTable(result, contest) {
  const base = path(contest.slug);
  return `<div class="community-card community-table-wrap"><table class="community-table">
    <thead><tr><th>排名</th><th>选手</th><th>总分</th>${contest.tasks.map((task,index)=>
      `<th><a href="${base}/problems/${task.id}" title="${esc(task.title)}">${String.fromCharCode(65+index)}</a></th>`).join('')}</tr></thead>
    <tbody>${result.rows.map(row => {
      const scores = JSON.parse(row.scores || '{}');
      return `<tr><td>${row.rank}</td><td>${memberLink(row.name)}</td><td><strong>${row.total}</strong></td>${contest.tasks.map(task=>{
        const value = esc(scores[task.id] ?? '—');
        return `<td>${contest.management ? `<a href="${base}/audit?problem=${task.id}&amp;user=${encodeURIComponent(row.actor)}">${value}</a>` : value}</td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody></table>${result.rows.length?'':'<p>暂无参赛选手。</p>'}</div>`;
}

async function showAttempt(contest, problem, rid, actor, tools) {
  if (!ridFormat.test(rid)) throw new ContestError('找不到这次提交。',404);
  const row = await tools.store('record',{actor,slug:contest.slug,problem,rid});
  let source;
  if (row.receipt) {
    const settings = tools.hydroSettings();
    if (settings) {
      try {
        const result = await tools.resultFromHydro(settings,{key:row.owner,createdAt:row.accountDate},row.task.hydroPid,row.receipt,true,contestPurpose(contest.slug,problem));
        source = result?.source;
      } catch { /* The cached result remains available. */ }
    }
  }
  return titleBlock('比赛提交详情', `<a href="${path(contest.slug)}/rank">返回排行榜</a>`) + `
    <div class="community-card"><p>${memberLink(row.name)} · ${esc(problem)} · ${statusText(row)} · ${esc(row.score ?? '—')} 分</p>
      <p>${displayDate(row.at)} · ${esc(row.language ?? '—')} · ${esc(row.time_ms ?? '—')} ms · ${esc(row.memory_kib ?? '—')} KiB</p>
    </div>${row.receipt ? `<section class="community-card"><h2>源代码</h2>${typeof source==='string' ?
      `<pre class="community-code"><code>${esc(source)}</code></pre>` : '<p>源码暂未返回，请稍后刷新。</p>'}</section>`:''}`;
}

export async function contestPage(request,user,actor,tools) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/$/,'');
  if (route !== '/contests' && !route.startsWith('/contests/')) return null;
  const page = timePage(url.searchParams.get('page'));
  if (route === '/contests') {
    if (request.method!=='GET') throw new ContestError('不支持此操作。',405);
    const { rows, more } = await tools.store('list',{actor,page});
    return tools.page(user,'比赛',titleBlock('比赛', actor?.root ? '<a class="community-button" href="/contests/new">新建比赛</a>' : '')+
      `<section class="community-card community-topic-list">${rows.map(contest=>`<article class="community-topic"><div>
      <a class="community-topic-title" href="${path(contest.slug)}">${esc(contest.title)}</a>
      <div class="community-byline">${esc(contest.organizer_name)} · ${displayDate(contest.starts)}</div></div>
      <span class="community-pin">${phase(contest)}</span></article>`).join('') || '<p>暂无比赛。</p>'}</section>` + paged('/contests',page,more));
  }
  if (route === '/contests/new') {
    if (!actor) return tools.redirect('/login');
    rootOnly(actor);
    if (request.method==='POST') return readContestEdit(request,user,actor,null,tools);
    return tools.page(user,'新建比赛',editPage(null,user,tools));
  }
  const match = /^\/contests\/([a-z0-9-]+)(?:\/(.*))?$/.exec(route);
  if (!match) throw new ContestError('页面不存在。',404);
  const [,slug,section='home'] = match;
  if (request.method==='POST') {
    if (!actor) return tools.redirect('/login');
    if (section==='edit') return readContestEdit(request,user,actor,slug,tools);
    if (section==='join') {
      await tools.store('join',{slug,actor});
      return tools.redirect(path(slug));
    }
    throw new ContestError('不支持此操作。',405);
  }
  if (request.method!=='GET') throw new ContestError('不支持此操作。',405);
  const contest = await tools.store('get',{slug,actor,full:section==='edit' || /^problems\/[^/]+$/.test(section)});
  const base = path(slug);
  if (section==='edit') {
    rootOnly(actor);
    return tools.page(user,'编辑比赛',tabs(contest,'edit',actor)+editPage(contest,user,tools));
  }
  if (section==='home') {
    const description = contest.description ? tools.renderArticle(tools.parseArticle(contest.description)) : '<p>暂无比赛介绍。</p>';
    const join = contest.published && Date.now()<contest.ends ?
      contest.member ? '<span class="community-pin">已报名</span>' : actor ?
      `<form method="post" action="${base}/join"><button class="community-button" type="submit">报名参赛</button></form>` :
      '<a class="community-button" href="/login">登录后报名</a>' : '';
    return tools.page(user,contest.title,titleBlock(contest.title,'<a href="/contests">全部比赛</a>') + tabs(contest,'home',actor) + `
      <div class="community-card"><div class="community-actions"><span class="community-pin">${phase(contest)}</span>${join}</div>
        <p>组织者 ${memberLink(contest.organizer_name)}</p>
        <p>北京时间 ${displayDate(contest.starts)} 至 ${displayDate(contest.ends)}</p>
        <p>排行榜按各题最高分求和，同分并列。</p>
        <section class="prose">${description}</section></div>`,true);
  }
  const head = titleBlock(contest.title,'<a href="/contests">全部比赛</a>');
  if (section==='problems') {
    return tools.page(user,'比赛题目',head+tabs(contest,'problems',actor)+`
      <section class="community-card community-topic-list">${contest.canReadTasks ? contest.tasks.map((task,index)=>
        `<article class="community-topic"><a class="community-topic-title" href="${base}/problems/${task.id}">${String.fromCharCode(65+index)}. ${esc(task.title)}</a></article>`).join('') :
        '<p>比赛开始后可查看题目。</p>'}</section>`);
  }
  if (section==='rank') {
    const result = contest.canReadTasks ? await tools.store('rank',{slug,actor,page}) : null;
    return tools.page(user,'排行榜',head+tabs(contest,'rank',actor)+(result ? rankTable(result,contest)+paged(base+'/rank',page,result.more) :
      '<div class="community-card">比赛开始后开放排行榜。</div>'));
  }
  if (section==='audit') {
    mustManager(contest,actor);
    const problem = url.searchParams.get('problem') || '';
    const target = url.searchParams.get('user') || '';
    const task = getTask(contest,problem);
    const result = await tools.store('audit',{slug,actor,problem,target,page});
    const auditPath = base + '/audit?problem=' + problem + '&user=' + encodeURIComponent(target);
    return tools.page(user,'比赛提交记录',head+tabs(contest,'rank',actor)+judgeTable(result.rows,contest,task,target)+paged(auditPath,page,result.more));
  }
  const detail = /^problems\/([A-Z0-9_-]+)(?:\/records\/([0-9a-f]+))?$/.exec(section);
  if (!detail) throw new ContestError('页面不存在。',404);
  if (!contest.canReadTasks) throw new ContestError('比赛尚未开始。',403);
  if (detail[2]) return tools.page(user,'比赛提交详情',await showAttempt(contest,detail[1],detail[2],actor,tools));
  const task = getTask(contest,detail[1]);
  const catalog = tools.problem(task.id);
  const problem = { id:task.id,title:task.title,hydroPid:task.hydroPid,level:'比赛题目',
    statement:task.statementOverride || catalog?.statement || '',samples:task.statementOverride ? [] : catalog?.samples || [] };
  const canSubmit = contest.member && contest.published && Date.now()>=contest.starts && Date.now()<contest.ends;
  return tools.html(tools.problemPage(problem,user,Boolean(canSubmit && tools.hydroSettings()),{
    base, endpoint:'/api'+base+'/problems/'+task.id+'/submissions', title:contest.title, registered:contest.member,
    canSubmit,
  }));
}

export const contestCss = `
.contest-form-times{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.contest-task-list{display:grid;gap:10px}
.contest-task-editor{display:grid;gap:8px;margin:0}
.contest-task-editor button{justify-self:start}
.contest-published{display:flex!important;align-items:center}
.contest-published input{width:auto!important}
.site-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.site-stat-grid strong{display:block;font-size:1.9rem;line-height:1.3}
@media(max-width:600px){.contest-form-times{grid-template-columns:1fr}}
`;
