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
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_DIR = path.join(ROOT, 'media');   // 本机模式下的照片存放处

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
let profiles = [];      // 个人主页
let profileSeq = 1;     // 主页自增编号

function applyData(data) {
  letters = Array.isArray(data.letters) ? data.letters : [];
  let max = 0;
  for (const l of letters) {
    if (typeof l.id === 'number' && l.id > max) max = l.id;
    if (!Array.isArray(l.replies)) l.replies = [];
  }
  idSeq = (typeof data.idSeq === 'number' && data.idSeq > max) ? data.idSeq : max + 1;

  profiles = Array.isArray(data.profiles) ? data.profiles : [];
  let maxP = 0;
  for (const p of profiles) {
    if (typeof p.id === 'number' && p.id > maxP) maxP = p.id;
  }
  profileSeq = (typeof data.profileSeq === 'number' && data.profileSeq > maxP) ? data.profileSeq : maxP + 1;
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

let saveTimer = null;
let saveChain = Promise.resolve();

function snapshotPayload() {
  return JSON.stringify({ idSeq, profileSeq, letters, profiles }, null, 2);
}

function saveData() {
  // 短时间内多次修改合并成一次保存；所有保存排队执行，避免同时写坏文件
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = snapshotPayload();
    saveChain = saveChain.then(async () => {
      try {
        if (isCloud) {
          await ghSave(payload);
        } else {
          // 先写临时文件再改名，避免程序恰好被杀时留下写了一半的文件
          const tmp = DATA_FILE + '.tmp';
          await fs.promises.writeFile(tmp, payload, 'utf8');
          await fs.promises.rename(tmp, DATA_FILE);
        }
      } catch (e) {
        console.error('保存数据失败：', e.message);
      }
    });
  }, 50);
}

function nowStr() {
  // 统一使用北京时间（UTC+8），不受服务器所在时区影响
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
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
      if (body.length > 10 * 1024 * 1024) { req.destroy(); reject(new Error('内容过大')); }
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

/* ---------------- 个人主页 ---------------- */
function publicProfile(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, bio: p.bio, createdAt: p.createdAt };
}

// 头像可以是表情（几个字符），也可以是上传的照片（压缩后的 data URL）
function cleanAvatar(s) {
  if (typeof s !== 'string') return '💗';
  s = s.trim();
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    return s.length <= 300000 ? s : '💗';
  }
  if (s.length > 0 && s.length <= 16) return s;
  return '💗';
}

/* ---------------- 照片存储 ---------------- */
// 照片单独存放（本机：media 文件夹；云端：私有仓库的 media/ 目录），
// 数据文件里只保存照片文件名，避免 data.json 变得巨大。
const MAX_IMAGES = 3;                       // 每封信/每条回复最多几张
const MAX_IMAGE_BYTES = 700 * 1024;         // 单张照片压缩后最大约 700KB
const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MEDIA_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function imageError(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

function parseImageDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  return { mime: m[1], ext: IMG_EXT[m[1]], buf };
}

async function saveImage(img) {
  const name = crypto.randomBytes(10).toString('hex') + '.' + img.ext;
  if (isCloud) {
    const put = await ghApi('/repos/' + GH_REPO + '/contents/media/' + name, 'PUT', {
      message: '上传照片 ' + name,
      content: img.buf.toString('base64')
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error('照片保存失败 HTTP ' + put.status);
    }
  } else {
    await fs.promises.mkdir(MEDIA_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(MEDIA_DIR, name), img.buf);
  }
  return name;
}

async function saveImages(list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > MAX_IMAGES) throw imageError('最多上传 ' + MAX_IMAGES + ' 张照片');
  const parsed = list.map(parseImageDataUrl);
  if (parsed.some((p) => !p)) throw imageError('照片格式不正确，或单张照片太大了');
  return Promise.all(parsed.map(saveImage));
}

// 内存缓存，避免每次打开照片都去 GitHub 取
const MEDIA_CACHE = new Map();
let mediaCacheSize = 0;
const MEDIA_CACHE_MAX = 80 * 1024 * 1024;   // 最多缓存 80MB

async function loadMedia(name) {
  if (MEDIA_CACHE.has(name)) {
    const item = MEDIA_CACHE.get(name);
    MEDIA_CACHE.delete(name);
    MEDIA_CACHE.set(name, item);            // 刷新为最近使用
    return item;
  }
  let buf;
  if (isCloud) {
    const res = await ghApi('/repos/' + GH_REPO + '/contents/media/' + name);
    if (res.status !== 200 || !res.json || res.json.encoding !== 'base64') return null;
    buf = Buffer.from(res.json.content, 'base64');
  } else {
    const file = path.join(MEDIA_DIR, name);
    if (!fs.existsSync(file)) return null;
    buf = await fs.promises.readFile(file);
  }
  const ext = name.split('.').pop();
  const item = { buf, type: MEDIA_MIME[ext] || 'application/octet-stream' };
  MEDIA_CACHE.set(name, item);
  mediaCacheSize += buf.length;
  while (mediaCacheSize > MEDIA_CACHE_MAX) {
    const firstKey = MEDIA_CACHE.keys().next().value;
    if (firstKey === undefined) break;
    const first = MEDIA_CACHE.get(firstKey);
    MEDIA_CACHE.delete(firstKey);
    mediaCacheSize -= first.buf.length;
  }
  return item;
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
      // 最新的信排在最前面；顺便带上所有主页信息，回复里只存主页编号
      const sorted = letters.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
      sendJSON(res, 200, { letters: sorted, profiles: profiles.map(publicProfile) });
      return;
    }

    /* ---- 个人主页 ---- */
    if (p === '/api/profiles' && req.method === 'POST') {
      const body = await readBody(req);
      const name = cleanText(body.name, 24);
      if (!name) { sendJSON(res, 400, { error: '请填写名字' }); return; }
      const profile = {
        id: profileSeq++,
        name,
        avatar: cleanAvatar(body.avatar),
        bio: cleanText(body.bio, 60),
        token: crypto.randomBytes(24).toString('hex'),
        createdAt: nowStr(),
        updatedAt: nowStr()
      };
      profiles.push(profile);
      saveData();
      sendJSON(res, 200, { profile: publicProfile(profile), token: profile.token });
      return;
    }

    const profileMatch = p.match(/^\/api\/profiles\/(\d+)$/);
    if (profileMatch && req.method === 'GET') {
      const id = parseInt(profileMatch[1], 10);
      const profile = profiles.find((x) => x.id === id);
      if (!profile) { sendJSON(res, 404, { error: '这个主页不存在' }); return; }
      sendJSON(res, 200, { profile: publicProfile(profile) });
      return;
    }

    if (profileMatch && req.method === 'PUT') {
      const id = parseInt(profileMatch[1], 10);
      const profile = profiles.find((x) => x.id === id);
      if (!profile) { sendJSON(res, 404, { error: '这个主页不存在' }); return; }
      const body = await readBody(req);
      if (!body.token || body.token !== profile.token) {
        sendJSON(res, 403, { error: '没有权限修改这个主页' });
        return;
      }
      const name = cleanText(body.name, 24);
      if (!name) { sendJSON(res, 400, { error: '请填写名字' }); return; }
      profile.name = name;
      profile.avatar = cleanAvatar(body.avatar);
      profile.bio = cleanText(body.bio, 60);
      profile.updatedAt = nowStr();
      saveData();
      sendJSON(res, 200, { profile: publicProfile(profile) });
      return;
    }

    if (p === '/api/letters' && req.method === 'POST') {
      const body = await readBody(req);
      const title = cleanText(body.title, 80);
      const content = cleanText(body.content, 20000);
      const sender = cleanText(body.sender, 40) || '匿名';
      const recipient = cleanText(body.recipient, 40) || '亲爱的你';
      if (!title) { sendJSON(res, 400, { error: '请填写标题' }); return; }
      if (!content && !(Array.isArray(body.images) && body.images.length)) {
        sendJSON(res, 400, { error: '请写下信的内容或添加照片' });
        return;
      }
      const images = await saveImages(body.images);

      const letter = {
        id: idSeq++,
        title,
        content,
        sender,
        recipient,
        images,
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
      let name = cleanText(body.name, 40) || '匿名';
      if (!content && !(Array.isArray(body.images) && body.images.length)) {
        sendJSON(res, 400, { error: '请写下回复内容或添加照片' });
        return;
      }
      const images = await saveImages(body.images);

      // 如果带了个人主页，就用主页上的名字
      const author = body.profileId != null
        ? profiles.find((x) => x.id === Number(body.profileId))
        : null;
      if (author) name = author.name;

      const reply = {
        id: (letter.replies.reduce((m, r) => Math.max(m, r.id || 0), 0)) + 1,
        name,
        content,
        images,
        createdAt: nowStr()
      };
      if (author) reply.profileId = author.id;
      // 支持"回复某一条回复"
      if (body.replyTo != null) {
        const target = letter.replies.find((r) => r.id === Number(body.replyTo));
        if (target) {
          reply.replyTo = target.id;
          reply.replyToName = target.name;
          const flat = target.content.replace(/\s+/g, ' ');
          reply.quote = flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
        }
      }
      letter.replies.push(reply);
      saveData();
      sendJSON(res, 200, { letter });
      return;
    }

    /* ---- 照片 ---- */
    const mediaMatch = p.match(/^\/media\/([a-f0-9]{20}\.(?:jpg|png|webp))$/);
    if (mediaMatch && req.method === 'GET') {
      const item = await loadMedia(mediaMatch[1]);
      if (!item) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': item.type,
        'Content-Length': item.buf.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(item.buf);
      return;
    }

    if (p.startsWith('/api/')) {
      sendJSON(res, 404, { error: '接口不存在' });
      return;
    }

    serveStatic(res, p);
  } catch (e) {
    sendJSON(res, e.status || 500, { error: e.message || '服务器出错' });
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
  // 安全提醒：如果是在云端运行，但没设置 GITHUB_REPO / GITHUB_TOKEN，
  // 数据会存在服务器临时磁盘上，重启后可能丢失
  if (!isCloud && (process.env.RENDER || process.env.VERCEL)) {
    console.log('');
    console.log('⚠️ 警告：当前是云端部署，但没有设置 GITHUB_REPO 和 GITHUB_TOKEN！');
    console.log('   信的数据会保存在服务器临时磁盘上，重启后可能丢失！');
    console.log('   请到部署平台的环境变量里设置这两个值。');
    console.log('');
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
    // 自动在浏览器中打开（测试时可设置 NO_OPEN=1 跳过）
    if (!process.env.NO_OPEN) {
      try {
        exec('start "" "http://localhost:' + usedPort + '"', { shell: 'cmd.exe' });
      } catch (e) { /* 忽略 */ }
    }
  });
}

// 启动
init();

// 退出前保存一次（先等正在进行的保存完成，再写最新数据）
function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const payload = snapshotPayload();
    if (!isCloud) {
      try { fs.writeFileSync(DATA_FILE, payload, 'utf8'); } catch (e) { /* 忽略 */ }
      process.exit(0);
    }
    ghSave(payload).catch(() => {}).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  saveChain.then(finish, finish);
  setTimeout(finish, 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
