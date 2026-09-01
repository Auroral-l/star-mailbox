/* ============================================================
   星空信箱 · 服务器
   - 零依赖（只用 Node 自带模块）
   - 信件数据保存在同目录的 data.json 里，退出后依然保留
   - 电脑打开： http://localhost:3000
   - 手机打开（连同一个WiFi）： http://<本机IP>:3000
   ============================================================ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------------- 数据存储 ---------------- */
// 两种保存模式：
//   1. 本机模式（默认）：保存在本机 data.json 文件里（桌面双击 start.bat 用）
//   2. 云端模式：设置了 GITHUB_REPO 和 GITHUB_TOKEN 后，数据自动保存到
//      GitHub 仓库里，永久保留，即使服务器重启也不会丢
const isCloud = !!(process.env.GITHUB_REPO && process.env.GITHUB_TOKEN);
const GH_REPO = process.env.GITHUB_REPO;   // 例如 myname/starmailbox
const GH_TOKEN = process.env.GITHUB_TOKEN;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');

let letters = [];       // 所有信
let idSeq = 1;          // 信的自增编号

function applyData(data) {
  letters = Array.isArray(data.letters) ? data.letters : [];
  let max = 0;
  for (const l of letters) {
    if (typeof l.id === 'number' && l.id > max) max = l.id;
    if (!Array.isArray(l.replies)) l.replies = [];
  }
  idSeq = (typeof data.idSeq === 'number' && data.idSeq > max) ? data.idSeq : max + 1;
}

function loadLocal() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      applyData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    }
  } catch (e) {
    console.error('读取数据失败，将从空白开始：', e.message);
    letters = [];
    idSeq = 1;
  }
}

/* GitHub API（用内置 https 模块，兼容所有 Node 版本） */
function ghApi(apiPath, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method: method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'star-mailbox',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadCloud() {
  const res = await ghApi('/repos/' + GH_REPO + '/contents/data.json');
  if (res.status === 404) { console.log('云端还没有信件数据，从空白开始'); return; }
  if (res.status !== 200) throw new Error('GitHub 读取失败 HTTP ' + res.status);
  const content = Buffer.from(res.json.content, 'base64').toString('utf8');
  applyData(JSON.parse(content));
}

async function ghSave(payload) {
  const apiPath = '/repos/' + GH_REPO + '/contents/data.json';
  // 先拿到当前文件的 SHA，GitHub 要求带 SHA 更新
  const get = await ghApi(apiPath);
  let sha;
  if (get.status === 200 && get.json && get.json.sha) sha = get.json.sha;
  else if (get.status !== 404) throw new Error('GitHub 文件检查失败 HTTP ' + get.status);

  const put = await ghApi(apiPath, 'PUT', {
    message: '保存信箱数据 ' + new Date().toLocaleString('zh-CN'),
    content: Buffer.from(payload).toString('base64'),
    ...(sha ? { sha } : {})
  });
  if (put.status !== 200 && put.status !== 201) {
    // 可能是并发写入导致 SHA 过期，自动重试一次
    const get2 = await ghApi(apiPath);
    if (get2.status !== 200 || !get2.json || !get2.json.sha) {
      throw new Error('GitHub 保存失败 HTTP ' + put.status);
    }
    const put2 = await ghApi(apiPath, 'PUT', {
      message: '保存信箱数据 ' + new Date().toLocaleString('zh-CN'),
      content: Buffer.from(payload).toString('base64'),
      sha: get2.json.sha
    });
    if (put2.status !== 200 && put2.status !== 201) {
      throw new Error('GitHub 保存失败 HTTP ' + put2.status);
    }
  }
}

let saveScheduled = false;
function saveData() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(async () => {
    saveScheduled = false;
    const payload = JSON.stringify({ idSeq, letters }, null, 2);
    try {
      if (isCloud) {
        await ghSave(payload);
      } else {
        await new Promise((resolve, reject) => {
          fs.writeFile(DATA_FILE, payload, 'utf8', (err) => err ? reject(err) : resolve());
        });
      }
    } catch (e) {
      console.error('保存数据失败：', e.message);
    }
  });
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------------- 工具函数 ---------------- */
function sendJSON(res, status, obj) {
  const str = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(str);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error('内容过大')); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('数据格式不正确')); }
    });
    req.on('error', reject);
  });
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function getLanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1 style="font-family:sans-serif">404 · 页面不存在</h1>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/info' && req.method === 'GET') {
      sendJSON(res, 200, { lanIp: getLanIP(), port: server.address().port });
      return;
    }

    if (p === '/api/letters' && req.method === 'GET') {
      // 最新的信排在最前面
      const sorted = letters.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
      sendJSON(res, 200, { letters: sorted });
      return;
    }

    if (p === '/api/letters' && req.method === 'POST') {
      const body = await readBody(req);
      const title = cleanText(body.title, 80);
      const content = cleanText(body.content, 20000);
      const sender = cleanText(body.sender, 40) || '匿名';
      const recipient = cleanText(body.recipient, 40) || '亲爱的你';
      if (!title) { sendJSON(res, 400, { error: '请填写标题' }); return; }
      if (!content) { sendJSON(res, 400, { error: '请写下信的内容' }); return; }

      const letter = {
        id: idSeq++,
        title,
        content,
        sender,
        recipient,
        createdAt: nowStr(),
        replies: []
      };
      letters.push(letter);
      saveData();
      sendJSON(res, 200, { letter });
      return;
    }

    const replyMatch = p.match(/^\/api\/letters\/(\d+)\/reply$/);
    if (replyMatch && req.method === 'POST') {
      const id = parseInt(replyMatch[1], 10);
      const letter = letters.find((l) => l.id === id);
      if (!letter) { sendJSON(res, 404, { error: '这封信不存在' }); return; }

      const body = await readBody(req);
      const content = cleanText(body.content, 4000);
      const name = cleanText(body.name, 40) || '匿名';
      if (!content) { sendJSON(res, 400, { error: '请写下回复内容' }); return; }

      letter.replies.push({
        id: (letter.replies.reduce((m, r) => Math.max(m, r.id || 0), 0)) + 1,
        name,
        content,
        createdAt: nowStr()
      });
      saveData();
      sendJSON(res, 200, { letter });
      return;
    }

    if (p.startsWith('/api/')) {
      sendJSON(res, 404, { error: '接口不存在' });
      return;
    }

    serveStatic(res, p);
  } catch (e) {
    sendJSON(res, 500, { error: e.message || '服务器出错' });
  }
});

/* ---------------- 启动 ---------------- */
async function init() {
  try {
    if (isCloud) await loadCloud();
    else loadLocal();
  } catch (e) {
    console.error('启动时读取数据失败，将从空白开始：', e.message);
    letters = [];
    idSeq = 1;
  }
  listen(parseInt(process.env.PORT || '3000', 10));
}

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 3010) {
      console.log('端口 ' + port + ' 被占用，尝试 ' + (port + 1) + ' ...');
      listen(port + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const lan = getLanIP();
    const usedPort = server.address().port;
    console.log('');
    console.log('==========================================');
    console.log('   ❤️ 星空信箱 · 已经开启 ❤️');
    console.log('   电脑打开： http://localhost:' + usedPort);
    console.log('   手机打开（连同一个WiFi）：');
    console.log('   http://' + lan + ':' + usedPort);
    console.log('');
    console.log('   ⚠️ 请勿关闭这个黑色窗口，否则网站会关闭');
    console.log('==========================================');
    console.log('');
    // 自动在浏览器中打开
    try {
      exec('start "" "http://localhost:' + usedPort + '"', { shell: 'cmd.exe' });
    } catch (e) { /* 忽略 */ }
  });
}

// 启动
init();

// 退出前保存一次
process.on('SIGINT', () => { saveData(); process.exit(0); });
process.on('SIGTERM', () => { saveData(); process.exit(0); });
