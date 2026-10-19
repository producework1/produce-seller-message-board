// Produce Seller Message Board - self-contained deployable server.
// Node.js built-in modules only. No npm dependencies.
//
// Env vars:
//   PORT     - port to listen on (default 3000)
//   DATA_DIR - directory for persistent storage (default ./data next to this file)
//   BOARD_OWNER_CODE  - optional seed: if set (with BOARD_SELLER_CODE) and the
//   BOARD_SELLER_CODE   saved store has no completed setup, the board boots
//                       already set up with these codes. Signing secret and
//                       invite version are derived deterministically from
//                       them, so sign-in tokens survive restarts even when
//                       the data dir is wiped (e.g. Render free tier). Once a
//                       persisted store has a completed setup, it wins and
//                       these are ignored.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const PURGE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_IMAGE_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_POST_LEN = 2000;
const MAX_PRODUCE_LEN = 120;
const MAX_TEXT_LEN = 2000;

const PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'cunt', 'whore', 'slut', 'retard'];
function containsProfanity(text) {
  const t = (' ' + String(text || '').toLowerCase() + ' ');
  return PROFANITY.some(w => t.includes(w));
}

// ---------- persistence ----------
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}
function saveStore(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}
let store = loadStore();
if (!store) {
  store = {
    setupComplete: false,
    ownerCodeHash: null,
    sellerCodeHash: null,
    inviteVersion: 1,
    admins: [], // {id, label, codeHash}
    posts: [],  // {id, type, produceItem, text, image, createdAt, hidden, autoHidden, flags, replies:[...]}
    secret: crypto.randomBytes(32).toString('hex')
  };
  saveStore(store);
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- env seed (free-tier workaround) ----------
const ENV_OWNER_CODE = process.env.BOARD_OWNER_CODE || '';
const ENV_SELLER_CODE = process.env.BOARD_SELLER_CODE || '';
if (ENV_OWNER_CODE && ENV_SELLER_CODE) {
  if (!store.setupComplete) {
    const seedMaterial = 'seller-board-seed:' + ENV_OWNER_CODE + ':' + ENV_SELLER_CODE;
    store.secret = crypto.createHash('sha256').update(seedMaterial).digest('hex');
    store.ownerCodeHash = hashCode(ENV_OWNER_CODE);
    store.sellerCodeHash = hashCode(ENV_SELLER_CODE);
    // Tie inviteVersion to the seller code, so changing the env seller code
    // invalidates previously issued seller tokens, same as an in-app rotation.
    const fp = crypto.createHash('sha256').update('invite:' + ENV_SELLER_CODE).digest();
    store.inviteVersion = fp.readUInt32BE(0) || 1;
    store.setupComplete = true;
    saveStore(store);
    console.log('Board seeded from BOARD_OWNER_CODE / BOARD_SELLER_CODE env vars.');
  }
} else if (ENV_OWNER_CODE || ENV_SELLER_CODE) {
  console.warn('Only one of BOARD_OWNER_CODE / BOARD_SELLER_CODE is set - seed skipped; both are required.');
}

// ---------- crypto helpers ----------
function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(code), salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyCodeHash(stored, code) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const check = crypto.scryptSync(String(code), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(check, 'hex'));
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64').toString('utf8'); }
function sign(payload) {
  const p = b64url(payload);
  const sig = crypto.createHmac('sha256', store.secret).update(p).digest('hex');
  return p + '.' + sig;
}
function decodeToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const sig = crypto.createHmac('sha256', store.secret).update(parts[0]).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[1]))) return null;
  try { return JSON.parse(unb64url(parts[0])); } catch (e) { return null; }
}
function roleFromToken(token) {
  const t = decodeToken(token);
  if (!t) return null;
  if (t.role === 'owner') {
    return store.setupComplete ? { role: 'owner' } : null;
  }
  if (t.role === 'seller') {
    if (!store.setupComplete || t.v !== store.inviteVersion) return null;
    return { role: 'seller' };
  }
  if (t.role === 'admin') {
    const a = store.admins.find(x => x.id === t.aid);
    if (!a) return null; // revoked
    return { role: 'admin', adminId: t.aid, label: a.label };
  }
  return null;
}

// ---------- throttling (in-memory) ----------
const throttle = new Map();
function throttled(key, limit, windowMs) {
  const now = Date.now();
  const arr = (throttle.get(key) || []).filter(ts => now - ts < windowMs);
  if (arr.length >= limit) return true;
  arr.push(now);
  throttle.set(key, arr);
  return false;
}

// ---------- purge expired posts ----------
function purgeExpired() {
  const cutoff = Date.now() - PURGE_AFTER_MS;
  let changed = false;
  const keep = [];
  for (const p of store.posts) {
    if (p.createdAt < cutoff) {
      if (p.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, p.image)); } catch (e) {} }
      changed = true;
    } else keep.push(p);
  }
  if (changed) { store.posts = keep; saveStore(store); }
}

// ---------- HTTP helpers ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function authRole(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return roleFromToken(m[1]);
}
function adminRole(r) { return r && (r.role === 'admin' || r.role === 'owner'); }
function detectMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}
function storeImage(dataB64) {
  let buf;
  try { buf = Buffer.from(dataB64, 'base64'); } catch (e) { return { error: 'Invalid image data.' }; }
  if (buf.length > MAX_IMAGE_BYTES) return { error: 'Picture is too large. Keep it under 2 MB.' };
  const mime = detectMime(buf);
  if (!mime || !ALLOWED_IMAGE_MIME[mime]) return { error: 'Picture must be a JPEG, PNG, WebP, or GIF file.' };
  const name = crypto.randomUUID() + '.' + ALLOWED_IMAGE_MIME[mime];
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { name };
}
function publicPost(p, forAdmin) {
  const out = {
    id: p.id, type: p.type, produceItem: p.produceItem, text: p.text,
    image: p.image ? ('/uploads/' + p.image) : null,
    createdAt: p.createdAt,
    flags: forAdmin ? p.flags : 0,
    hidden: forAdmin ? p.hidden : false,
    autoHidden: forAdmin ? p.autoHidden : false,
    replies: p.replies.map(r => ({ id: r.id, text: r.text, createdAt: r.createdAt }))
  };
  return out;
}
const PROFANITY_MSG = 'That post was blocked because it contains language that is not allowed on this board. Please reword it and try again.';

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pth = url.pathname;

    // --- static files ---
    if (req.method === 'GET' && (pth === '/' || pth === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
      return;
    }
    if (req.method === 'GET' && pth.startsWith('/uploads/')) {
      const r = authRole(req);
      if (!r) { res.writeHead(403); res.end('forbidden'); return; }
      const name = path.basename(pth.slice('/uploads/'.length));
      const f = path.join(UPLOAD_DIR, name);
      if (!/^[a-f0-9-]+\.(jpg|png|webp|gif)$/.test(name) || !fs.existsSync(f)) {
        res.writeHead(404); res.end('not found'); return;
      }
      const ext = name.split('.').pop();
      const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(f).pipe(res);
      return;
    }

    // --- API ---
    if (pth === '/api/status' && req.method === 'GET') {
      return send(res, 200, { setupComplete: store.setupComplete });
    }

    if (pth === '/api/setup' && req.method === 'POST') {
      if (store.setupComplete) return send(res, 403, { error: 'Setup has already been completed.' });
      const body = JSON.parse(await readBody(req, 10 * 1024));
      const ownerCode = String(body.ownerCode || '').trim();
      const sellerCode = String(body.sellerCode || '').trim();
      if (ownerCode.length < 6 || sellerCode.length < 6)
        return send(res, 400, { error: 'Both codes must be at least 6 characters long.' });
      if (ownerCode === sellerCode)
        return send(res, 400, { error: 'Owner code and seller invite code must be different.' });
      store.ownerCodeHash = hashCode(ownerCode);
      store.sellerCodeHash = hashCode(sellerCode);
      store.setupComplete = true;
      saveStore(store);
      return send(res, 200, { ok: true });
    }

    if (pth === '/api/verify' && req.method === 'POST') {
      if (!store.setupComplete) return send(res, 400, { error: 'Setup not complete yet.' });
      const body = JSON.parse(await readBody(req, 10 * 1024));
      const code = String(body.code || '').trim();
      if (verifyCodeHash(store.ownerCodeHash, code))
        return send(res, 200, { role: 'owner', token: sign(JSON.stringify({ role: 'owner' })) });
      const admin = store.admins.find(a => verifyCodeHash(a.codeHash, code));
      if (admin)
        return send(res, 200, { role: 'admin', token: sign(JSON.stringify({ role: 'admin', aid: admin.id })) });
      if (verifyCodeHash(store.sellerCodeHash, code))
        return send(res, 200, { role: 'seller', token: sign(JSON.stringify({ role: 'seller', v: store.inviteVersion })) });
      return send(res, 401, { error: 'That code is not valid. Check it and try again.' });
    }

    const r = authRole(req);
    const needAuth = ['/api/posts', '/api/admin/'].some(x => pth === x || pth.startsWith(x)) ||
      (pth.startsWith('/api/posts/'));
    if (needAuth && !r) return send(res, 401, { error: 'Sign in with your code first.' });

    if (pth === '/api/posts' && req.method === 'GET') {
      purgeExpired();
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const type = url.searchParams.get('type') || '';
      const isAdmin = adminRole(r);
      let list = store.posts.slice().sort((a, b) => b.createdAt - a.createdAt);
      if (!isAdmin) list = list.filter(p => !p.hidden);
      if (type === 'experience' || type === 'concern') list = list.filter(p => p.type === type);
      if (q) list = list.filter(p => (p.text + ' ' + p.produceItem).toLowerCase().includes(q));
      return send(res, 200, { posts: list.map(p => publicPost(p, isAdmin)), role: r.role });
    }

    if (pth === '/api/posts' && req.method === 'POST') {
      purgeExpired();
      if (throttled('post:' + (r.role === 'seller' ? req.socket.remoteAddress : r.role), 5, 60 * 1000))
        return send(res, 429, { error: 'You are posting too fast. Wait a minute and try again.' });
      const body = JSON.parse(await readBody(req, 5 * 1024 * 1024));
      const type = body.type === 'concern' ? 'concern' : 'experience';
      const produceItem = String(body.produceItem || '').slice(0, MAX_PRODUCE_LEN);
      const text = String(body.text || '').trim().slice(0, MAX_TEXT_LEN);
      if (!text) return send(res, 400, { error: 'Write something before posting.' });
      if (containsProfanity(text) || containsProfanity(produceItem))
        return send(res, 400, { error: PROFANITY_MSG });
      let image = null;
      if (body.image) {
        const st = storeImage(body.image);
        if (st.error) return send(res, 400, { error: st.error });
        image = st.name;
      }
      const post = {
        id: crypto.randomUUID(), type, produceItem, text, image,
        createdAt: Date.now(), hidden: false, autoHidden: false, flags: 0, replies: []
      };
      store.posts.push(post);
      saveStore(store);
      return send(res, 200, { ok: true, post: publicPost(post, adminRole(r)) });
    }

    let m;
    if ((m = pth.match(/^\/api\/posts\/([a-f0-9-]+)\/reply$/)) && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 64 * 1024));
      const text = String(body.text || '').trim().slice(0, MAX_TEXT_LEN);
      if (!text) return send(res, 400, { error: 'Write a reply first.' });
      if (containsProfanity(text)) return send(res, 400, { error: PROFANITY_MSG });
      const post = store.posts.find(p => p.id === m[1]);
      if (!post || (!adminRole(r) && post.hidden)) return send(res, 404, { error: 'Post not found.' });
      post.replies.push({ id: crypto.randomUUID(), text, createdAt: Date.now() });
      saveStore(store);
      return send(res, 200, { ok: true, post: publicPost(post, adminRole(r)) });
    }

    if ((m = pth.match(/^\/api\/posts\/([a-f0-9-]+)\/report$/)) && req.method === 'POST') {
      const post = store.posts.find(p => p.id === m[1]);
      if (!post || (!adminRole(r) && post.hidden)) return send(res, 404, { error: 'Post not found.' });
      post.flags = (post.flags || 0) + 1;
      if (post.flags >= 2 && !post.hidden) { post.hidden = true; post.autoHidden = true; }
      saveStore(store);
      return send(res, 200, { ok: true, autoHidden: !!post.autoHidden });
    }

    // --- admin routes ---
    if (pth.startsWith('/api/admin/')) {
      if (!adminRole(r)) return send(res, 403, { error: 'Admin access required.' });
      const isOwner = r.role === 'owner';

      if (pth === '/api/admin/posts' && req.method === 'GET') {
        purgeExpired();
        const list = store.posts.slice().sort((a, b) => b.createdAt - a.createdAt);
        return send(res, 200, { posts: list.map(p => publicPost(p, true)) });
      }
      if ((m = pth.match(/^\/api\/admin\/posts\/([a-f0-9-]+)\/(hide|unhide|delete)$/)) && req.method === 'POST') {
        const post = store.posts.find(p => p.id === m[1]);
        if (!post) return send(res, 404, { error: 'Post not found.' });
        if (m[2] === 'hide') { post.hidden = true; post.autoHidden = false; }
        if (m[2] === 'unhide') { post.hidden = false; post.autoHidden = false; }
        if (m[2] === 'delete') {
          if (post.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, post.image)); } catch (e) {} }
          store.posts = store.posts.filter(p => p.id !== post.id);
        }
        saveStore(store);
        return send(res, 200, { ok: true });
      }
      if ((m = pth.match(/^\/api\/admin\/posts\/([a-f0-9-]+)\/restore$/)) && req.method === 'POST') {
        const post = store.posts.find(p => p.id === m[1]);
        if (!post) return send(res, 404, { error: 'Post not found.' });
        post.hidden = false; post.autoHidden = false; post.flags = 0; // clear reports so it does not instantly re-hide
        saveStore(store);
        return send(res, 200, { ok: true });
      }
      if (pth === '/api/admin/invite' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 10 * 1024));
        const code = String(body.code || '').trim();
        if (code.length < 6) return send(res, 400, { error: 'Invite code must be at least 6 characters.' });
        store.sellerCodeHash = hashCode(code);
        store.inviteVersion += 1; // old code stops working instantly
        saveStore(store);
        return send(res, 200, { ok: true });
      }
      if (pth === '/api/admin/admins' && req.method === 'GET') {
        if (!isOwner) return send(res, 403, { error: 'Only the owner can manage admins.' });
        return send(res, 200, { admins: store.admins.map(a => ({ id: a.id, label: a.label })) });
      }
      if (pth === '/api/admin/admins' && req.method === 'POST') {
        if (!isOwner) return send(res, 403, { error: 'Only the owner can manage admins.' });
        const body = JSON.parse(await readBody(req, 10 * 1024));
        const code = String(body.code || '').trim();
        const label = String(body.label || '').slice(0, 60);
        if (code.length < 6) return send(res, 400, { error: 'Admin code must be at least 6 characters.' });
        const a = { id: crypto.randomUUID(), label, codeHash: hashCode(code) };
        store.admins.push(a);
        saveStore(store);
        return send(res, 200, { ok: true, admin: { id: a.id, label: a.label } });
      }
      if ((m = pth.match(/^\/api\/admin\/admins\/([a-f0-9-]+)$/)) && req.method === 'DELETE') {
        if (!isOwner) return send(res, 403, { error: 'Only the owner can manage admins.' });
        const before = store.admins.length;
        store.admins = store.admins.filter(a => a.id !== m[1]);
        if (store.admins.length === before) return send(res, 404, { error: 'Admin not found.' });
        saveStore(store); // their token no longer resolves -> access revoked immediately
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Unknown admin action.' });
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e.message === 'body too large') return send(res, 413, { error: 'Request too large.' });
    console.error(e);
    return send(res, 500, { error: 'Something went wrong. Try again.' });
  }
});

server.listen(PORT, () => console.log('Seller board listening on port ' + PORT + ', data dir: ' + DATA_DIR));
