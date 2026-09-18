/**
 * 用 GitHub REST API 发布整个项目（无需 git / gh）
 * 用法：node publish.mjs <项目目录> <仓库名> [--public|--private]
 * 凭据：读取 <项目目录>/.gh-token（一行 Personal Access Token），用完请撤销
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readdirSync } from "node:fs";

const [projDir, repoName, vis = "--public"] = process.argv.slice(2);
if (!projDir || !repoName) { console.error("用法: node publish.mjs <项目目录> <仓库名> [--public|--private]"); process.exit(2); }

const tokenFile = join(projDir, ".gh-token");
if (!existsSync(tokenFile)) { console.error("找不到凭据文件: " + tokenFile); process.exit(2); }
const TOKEN = readFileSync(tokenFile, "utf8").trim();
if (!/^[A-Za-z0-9_]{20,}$/.test(TOKEN)) { console.error("凭据格式看起来不对（应为单行 token，无空格、无引号）"); process.exit(2); }

const API = "https://api.github.com";
const H = {
  "user-agent": "dsh-publish",
  "accept": "application/vnd.github+json",
  "authorization": "Bearer " + TOKEN,
  "x-github-api-version": "2022-11-28"
};

async function api(method, path, body) {
  const res = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json, text, scopes: res.headers.get("x-oauth-scopes") };
}

/* ---------- 1 · 身份 ---------- */
const me = await api("GET", "/user");
if (!me.ok) {
  console.error(`认证失败 (${me.status})：${me.json?.message || me.text.slice(0, 200)}`);
  if (me.status === 401) console.error("token 可能已过期、被撤销，或复制时带了多余字符。");
  if (me.status === 403) console.error("token 可能缺少 repo 权限。");
  process.exit(1);
}
const owner = me.json.login;
const isFineGrained = !me.scopes;
console.log(`已认证：${owner}（${isFineGrained ? "fine-grained token" : "classic token，scopes: " + me.scopes}）`);

/* ---------- 2 · 仓库 ---------- */
let repo = await api("GET", `/repos/${owner}/${repoName}`);
if (repo.ok) {
  console.log(`仓库已存在：${repo.json.full_name}`);
} else if (repo.status === 404) {
  const created = await api("POST", "/user/repos", {
    name: repoName,
    description: "迷雾中的证据 · 六篇科学推理短篇（含程序化配乐）",
    private: vis === "--private",
    has_issues: false, has_wiki: false, has_projects: false, auto_init: false
  });
  if (!created.ok) { console.error(`建仓库失败 (${created.status})：${created.json?.message || created.text.slice(0, 300)}`); process.exit(1); }
  repo = created;
  console.log(`已创建仓库：${repo.json.full_name}（${repo.json.private ? "私有" : "公开"}）`);
} else {
  console.error(`查询仓库失败 (${repo.status})：${repo.json?.message || ""}；fine-grained token 可能没有被授予该仓库的权限。`);
  process.exit(1);
}
const branch = repo.json.default_branch || "main";

/* ---------- 3 · 收集文件 ---------- */
const SKIP = new Set([".gh-token", "node_modules", ".git"]);
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && statSync(full).size < 25 * 1024 * 1024) files.push(full);
  }
})(projDir);
files.sort();

/* ---------- 4 · 上传 ---------- */
let first = true;
const uploaded = [];
for (const f of files) {
  const path = relative(projDir, f).split(sep).join("/");
  const content = readFileSync(f).toString("base64");

  let sha;
  const cur = await api("GET", `/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}` + (first ? "" : `?ref=${branch}`));
  if (cur.ok && cur.json && cur.json.sha) sha = cur.json.sha;

  const body = { message: `添加 ${path}`, content };
  if (sha) body.sha = sha;
  if (!first) body.branch = branch;

  let put = await api("PUT", `/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`, body);
  if (!put.ok && put.status === 422 && !first) {
    // 空仓库首次提交时不需要指定分支
    delete body.branch;
    put = await api("PUT", `/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`, body);
  }
  if (!put.ok) {
    console.error(`上传失败 ${path} (${put.status})：${put.json?.message || put.text.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  ✓ ${path}（${(statSync(f).size / 1024).toFixed(1)} KB）`);
  uploaded.push(path);
  first = false;
}
console.log(`共上传 ${uploaded.length} 个文件，分支 ${branch}`);

// .nojekyll 让静态文件原样发布
const nj = await api("PUT", `/repos/${owner}/${repoName}/contents/.nojekyll`, {
  message: "添加 .nojekyll", content: Buffer.from("").toString("base64"), branch
});
console.log(nj.ok ? "  ✓ .nojekyll" : `  ! .nojekyll 失败 (${nj.status})`);

/* ---------- 5 · Pages ---------- */
if (vis === "--public") {
  const pageBody = { source: { branch, path: "/" } };
  let pages = await api("POST", `/repos/${owner}/${repoName}/pages`, pageBody);
  if (pages.status === 409) pages = await api("PUT", `/repos/${owner}/${repoName}/pages`, pageBody);
  if (pages.ok || pages.status === 409) {
    console.log("GitHub Pages 已启用（源：main 分支根目录）");
  } else {
    console.log(`Pages 启用失败 (${pages.status})：${pages.json?.message || ""}`);
  }
}

const info = await api("GET", `/repos/${owner}/${repoName}/pages`);
const url = info.ok ? info.json.html_url : `https://${owner}.github.io/${repoName}/`;
console.log("\n仓库地址：https://github.com/" + owner + "/" + repoName);
console.log("在线地址：" + url + "（首次构建约需 30–90 秒）");

/* ---------- 6 · 轮询线上是否可访问 ---------- */
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 6000));
  try {
    const r = await fetch(url, { headers: { "user-agent": "dsh-publish" } });
    if (r.ok) {
      const html = await r.text();
      const title = /<title>(.*?)<\/title>/.exec(html);
      console.log(`线上可访问：HTTP ${r.status}，首页 ${html.length} 字节，标题「${title ? title[1] : "(未解析到)"}」`);
      process.exit(0);
    }
    console.log(`  等待构建… HTTP ${r.status}`);
  } catch (e) {
    console.log("  等待构建… " + e.message);
  }
}
console.log("构建仍在进行，稍后自行刷新上面的在线地址即可。");
