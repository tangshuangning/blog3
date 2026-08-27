# 废墟电台 · 狂野风个人博客（可在网页上编辑/删除文章）

和之前那版不同，这个博客**不是纯静态站**，而是一个真正带后台的小型博客系统：

- 首页：卡片式文章列表，霓虹涂鸦风格
- 文章页：markdown 渲染正文，页面上有「编辑」按钮和「删除」按钮
- 编辑页：网页表单直接改标题/简介/标签/正文，保存即生效
- 删除：点按钮会弹出确认框，要求输入管理密码才能真正删除

数据存在 Cloudflare 的 KV 数据库里，不是 Git 仓库里的文件——所以你在网页上点保存/删除，不需要再手动 `git push`，改动是**立即生效**的。

---

## 部署前需要做 3 件事（一次性）

### 1. 创建 KV 数据库

1. 登录 Cloudflare Dashboard → 左侧菜单找 **Storage & Databases** → **KV**
2. 点击 **Create a namespace（创建命名空间）**
3. 名字随便填，比如 `blog-posts`，创建完成后会看到一串 **Namespace ID**，复制它

### 2. 把 KV ID 填进项目配置

打开项目里的 `wrangler.jsonc` 文件，找到这一行：

```jsonc
"id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
```

把 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 换成你刚才复制的那串 ID，保存文件。

### 3. 设置管理密码（用来保护编辑/删除功能）

这一步**不要**把密码直接写进代码里，而是在 Cloudflare Dashboard 里单独设置：

1. Cloudflare Dashboard → **Workers & Pages** → 找到你的 Worker（比如 `blog`）
2. 进入 **Settings** 标签页，找到 **Variables and secrets（变量与机密）**
3. 点击 **Add（添加）**，类型选择 **Secret（机密，会加密存储，不会明文显示）**
4. 名字填 `ADMIN_PASSWORD`，值填你自己想设的密码（记住它，以后编辑/删除文章时要输入）
5. 保存

> 只有知道这个密码的人才能新建、编辑、删除文章；不知道密码的访问者只能浏览。

---

## 部署到 Cloudflare（跟之前流程一样）

1. 把这个项目的所有文件推送到你的 GitHub 仓库（可以是同一个仓库，也可以新建一个）
2. 如果是同一个 Worker（比如你现在的 `blog`），它已经连了 Git 自动部署，直接推送后等它自动构建就行
3. 如果是新项目：Cloudflare Dashboard → Workers & Pages → 创建应用 → 连接 Git 仓库 → 部署命令保持默认的 `npx wrangler deploy`

部署完成后，访问你的域名，应该就能看到首页了。

---

## 怎么写文章（在网页上直接操作，不用碰代码）

1. 打开网站，点右上角 **+ 发新帖**
2. 填标题、简介、日期、标签，正文用 Markdown 语法写：
   - `## 标题` 变成小标题
   - `**加粗**`、`*斜体*`
   - `` `代码` `` 变成行内代码，三个反引号包裹的是代码块
   - `> 引用` 变成引用样式
   - `- 内容` 变成列表
3. 最下面输入你设置的管理密码
4. 点「⚡ 发布」，文章立刻上线

编辑已有文章：进入文章页，点「✎ 编辑」，改完输入密码保存即可。
删除文章：进入文章页，点「🗑 删除」，输入密码确认。

---

## 本地预览（可选，需要电脑装 Node.js）

```bash
npm install
npm run dev
```

本地测试时，管理密码默认是没有设置的，需要在命令后加上：

```bash
npx wrangler dev --var ADMIN_PASSWORD:你的测试密码
```

## 目录结构

```
src/index.js      ← 全部后端逻辑：路由、markdown 转换、页面模板、KV 读写
public/style.css  ← 全部视觉样式，想改配色/字体改这里
wrangler.jsonc    ← Cloudflare 部署配置（KV 绑定在这里）
```
