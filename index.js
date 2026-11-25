require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let canvasLib;
try {
  canvasLib = require('@napi-rs/canvas');
} catch {
  console.error('Missing @napi-rs/canvas. Run: npm install');
  process.exit(1);
}

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT ?? 5); // 0 = unlimited
const MAX_SEC = Number(process.env.MAX_SEC || 180);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const DOWNLOAD_LIMIT_MB = 20; // Telegram only lets bots download files up to 20 MB
const UPLOAD_LIMIT_MB = 50; // ...and upload up to 50 MB
const ENC_PRESET = process.env.ENC_PRESET || 'veryfast';
const ENC_CRF = String(process.env.ENC_CRF || 22);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
for (const f of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, f), { recursive: true, force: true }); // leftovers from a previous run

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('ffmpeg-static') || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}
const FFMPEG = resolveFfmpeg();

if (process.env.PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Blog frame bot is running');
    })
    .listen(process.env.PORT, '0.0.0.0');
}

// ---------- Small helpers ----------
const isAdmin = (id) => ADMIN_IDS.includes(id);
const escHtml = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (str, n) => {
  const a = Array.from(String(str));
  return a.length > n ? a.slice(0, n).join('') + '…' : String(str);
};
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const fmtDuration = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s` : `${Math.round(sec)}s`);
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Storage (one JSON file: blog details + daily usage) ----------
const DB_FILE = path.join(DATA_DIR, 'data.json');
let db = { profiles: {}, usage: {} };
try {
  db = { profiles: {}, usage: {}, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {
  /* first run */
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) {
      console.error('Save error:', e.message);
    }
  }, 300);
}
const newProfile = () => ({ name: '', handle: '', ig: '', fb: '', tg: '', tiktok: '', wa: '', x: '', yt: '', cta: '', logo: null, theme: 'slate', swap: false });
const getProfile = (uid) => (db.profiles[uid] ? { ...newProfile(), ...db.profiles[uid] } : null);
const setProfile = (uid, p) => {
  db.profiles[uid] = p;
  saveDb();
};
const ready = (p) => Boolean(p && p.name);
function usedToday(uid) {
  const u = db.usage[uid];
  return u && u.day === today() ? u.n : 0;
}
function bumpUsage(uid) {
  db.usage[uid] = { day: today(), n: usedToday(uid) + 1 };
  saveDb();
}

// ---------- Blog details: parsing ----------
const THEMES = {
  slate: { label: '🩶 Slate', head: '#3d5457', card: '#8c1c1c', accent: '#22a6c3' },
  navy: { label: '🔵 Navy', head: '#1e3a8a', card: '#0f172a', accent: '#38bdf8' },
  forest: { label: '🟢 Forest', head: '#14532d', card: '#052e16', accent: '#facc15' },
  plum: { label: '🟣 Plum', head: '#581c87', card: '#3b0764', accent: '#f472b6' },
  sunset: { label: '🟠 Sunset', head: '#9a3412', card: '#7c2d12', accent: '#fbbf24' },
  black: { label: '⚫ Black', head: '#111827', card: '#000000', accent: '#f59e0b' },
};
const SOCIALS = [
  { key: 'ig', label: 'IG', color: '#d97706' },
  { key: 'fb', label: 'FB', color: '#dc2626' },
  { key: 'tg', label: 'TG', color: '#7c3aed' },
  { key: 'tiktok', label: 'TikTok', color: '#0d9488' },
  { key: 'wa', label: 'WhatsApp', color: '#0891b2' },
  { key: 'x', label: 'X', color: '#374151' },
  { key: 'yt', label: 'YouTube', color: '#b91c1c' },
];
const ALIASES = {
  name: ['name', 'blog', 'blog name', 'blogname'],
  handle: ['handle', 'username', 'user'],
  ig: ['ig', 'instagram', 'insta'],
  fb: ['fb', 'facebook'],
  tg: ['tg', 'telegram'],
  tiktok: ['tiktok', 'tik tok', 'tt'],
  wa: ['wa', 'whatsapp', 'phone', 'contact'],
  x: ['x', 'twitter'],
  yt: ['yt', 'youtube'],
  cta: ['cta', 'message', 'tagline', 'call to action'],
};
const CTA_DEFAULT = 'Like, comment, share & follow us on our other platforms!';

function cleanValue(key, raw) {
  let v = String(raw).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!v || /^(-|none|remove|clear|delete)$/i.test(v)) return '';
  v = clip(v, key === 'cta' ? 90 : 60);
  if (key === 'name' || key === 'wa' || key === 'cta') return v;
  const url = v.match(/^https?:\/\/(?:www\.|m\.)?[^/\s]+\/@?([^/?#\s]+)/i);
  const user = (url ? url[1] : v).replace(/^(?:www\.)?t\.me\//i, '').replace(/^@+/, '');
  if (!user) return '';
  return key === 'tg' ? `t.me/${user}` : `@${user}`;
}
function parseDetails(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]{0,18}?)\s*[:=]\s*(.*?)\s*$/);
    if (!m) continue;
    const k = m[1].toLowerCase().trim();
    const key = Object.keys(ALIASES).find((f) => ALIASES[f].includes(k));
    if (key) out[key] = cleanValue(key, m[2]);
  }
  return out;
}
const socialText = (s, p) => (p[s.key] ? `${s.label}: ${p[s.key]}` : '');
const template = (p) => {
  const q = p || {};
  return [
    `Name: ${q.name || 'My Blog Media'}`,
    `Handle: ${q.handle || '@myblog'}`,
    `IG: ${q.ig || '@myblog'}`,
    `FB: ${q.fb || '@myblog'}`,
    `TG: ${q.tg || 't.me/myblog'}`,
    `TikTok: ${q.tiktok || '@myblog'}`,
    `WhatsApp: ${q.wa || '08012345678'}`,
  ].join('\n');
};

// ---------- Drawing the frame (text + emojis as separate runs so colour emojis render) ----------
const FONT = {
  text: '"Roboto", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  emoji: '"Noto Color Emoji", "Segoe UI Emoji", "Apple Color Emoji"',
};
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));
function isEmoji(g) {
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(g)) return false;
  return g.codePointAt(0) >= 0x231a || /\uFE0F/.test(g);
}
function toRuns(str) {
  const runs = [];
  for (const g of graphemes(str)) {
    const e = isEmoji(g);
    if (runs.length && runs[runs.length - 1].e === e) runs[runs.length - 1].t += g;
    else runs.push({ t: g, e });
  }
  return runs;
}
function wrapText(text, maxW, width) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + w : w;
      if (width(test) <= maxW) {
        line = test;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      if (width(w) <= maxW) {
        line = w;
        continue;
      }
      let chunk = '';
      for (const g of graphemes(w)) {
        if (chunk && width(chunk + g) > maxW) {
          lines.push(chunk);
          chunk = g;
        } else chunk += g;
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines.slice(0, 6);
}

const W = 1080;
const H = 1440;
const M = 40;
const HEAD = { y: 40, h: 190 };
const PANEL = { y: 246, h: 220 };
const BODY = { y: 482, h: 880 };
const VW = 496; // video box 496x880 (9:16)
const BAR = { y: 1380, h: 22 };
const PAGE = '#f1f5f9';

function rr(ctx, x, y, w, h, r, begin = true) {
  if (begin) ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const setFont = (ctx, size, weight, emoji) => (ctx.font = emoji ? `${size}px ${FONT.emoji}` : `${weight} ${size}px ${FONT.text}`);
const textWidth = (ctx, str, size, weight) => toRuns(str).reduce((w, r) => (setFont(ctx, size, weight, r.e), w + ctx.measureText(r.t).width), 0);
function drawText(ctx, str, x, y, size, weight, color, align = 'left') {
  const w = textWidth(ctx, str, size, weight);
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  for (const run of toRuns(str)) {
    setFont(ctx, size, weight, run.e);
    ctx.fillText(run.t, cx, y);
    cx += ctx.measureText(run.t).width;
  }
}
function fitSize(ctx, str, maxW, size, weight, min = 18) {
  let s = size;
  while (s > min && textWidth(ctx, str, s, weight) > maxW) s -= 2;
  return s;
}
async function drawLogo(ctx, p, th, cx, cy, d) {
  const r = d / 2;
  let img = null;
  if (p.logo) {
    try {
      img = await canvasLib.loadImage(Buffer.from(p.logo, 'base64'));
    } catch {
      img = null;
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) ctx.drawImage(img, cx - r, cy - r, d, d);
  else {
    ctx.fillStyle = th.accent;
    ctx.fillRect(cx - r, cy - r, d, d);
  }
  ctx.restore();
  if (!img) {
    const ini = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]).join('').toUpperCase();
    drawText(ctx, ini, cx, cy + 2, Math.round(d * 0.4), '800', '#ffffff', 'center');
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = th.accent;
  ctx.stroke();
}

// -> { base, mask, box }. base = whole frame, mask = transparent PNG rounding the video box corners, box = where the video goes.
// preview = true: dark placeholder in the video box, one finished picture.
async function renderFrame(p, headline, { preview = false } = {}) {
  const th = THEMES[p.theme] || THEMES.slate;
  const canvas = canvasLib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAGE;
  ctx.fillRect(0, 0, W, H);
  const fullW = W - M * 2;

  // header
  const hx = M;
  const hy = HEAD.y;
  const hh = HEAD.h;
  ctx.fillStyle = th.head;
  rr(ctx, hx, hy, fullW, hh, 34);
  ctx.fill();
  const ld = 140;
  await drawLogo(ctx, p, th, hx + 30 + ld / 2, hy + hh / 2, ld);
  const tx = hx + 30 + ld + 30;
  const tMax = hx + fullW - 30 - tx;
  const rows = [{ t: p.name, size: fitSize(ctx, p.name, tMax, 62, '800', 30), w: '800', c: '#ffffff', lh: 72 }];
  if (p.handle) rows.push({ t: p.handle, size: fitSize(ctx, p.handle, tMax, 38, '600', 22), w: '600', c: 'rgba(255,255,255,0.88)', lh: 48 });
  if (p.wa) {
    const t = `WhatsApp: ${p.wa}`;
    rows.push({ t, size: fitSize(ctx, t, tMax, 32, '500', 20), w: '500', c: 'rgba(255,255,255,0.8)', lh: 42 });
  }
  let ry = hy + hh / 2 - rows.reduce((a, r) => a + r.lh, 0) / 2;
  for (const r of rows) {
    drawText(ctx, r.t, tx, ry + r.lh / 2, r.size, r.w, r.c);
    ry += r.lh;
  }

  // headline panel
  const px = M;
  const py = PANEL.y;
  const ph = PANEL.h;
  ctx.fillStyle = '#ffffff';
  rr(ctx, px, py, fullW, ph, 30);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#dbe2ea';
  ctx.stroke();
  const hMaxW = fullW - 64;
  let hSize = 54;
  let hLines = [];
  for (const s of [54, 48, 44, 40, 36, 32, 28]) {
    hSize = s;
    hLines = wrapText(headline, hMaxW, (t) => textWidth(ctx, t, s, '700'));
    if (hLines.length * s * 1.25 <= ph - 36) break;
  }
  const maxLines = Math.max(1, Math.floor((ph - 36) / (hSize * 1.25)));
  if (hLines.length > maxLines) {
    hLines = hLines.slice(0, maxLines);
    const last = hLines[maxLines - 1];
    hLines[maxLines - 1] = clip(last, Math.max(1, Array.from(last).length - 2));
  }
  const lh = hSize * 1.25;
  let ly = py + (ph - hLines.length * lh) / 2 + lh / 2;
  for (const line of hLines) {
    drawText(ctx, line, px + 32, ly, hSize, '700', '#0f172a');
    ly += lh;
  }

  // body: social card + video box
  const vw = VW;
  const vh = BODY.h;
  const vy = BODY.y;
  const vx = p.swap ? M : W - M - vw;
  const cw = fullW - vw - 30;
  const cx0 = p.swap ? vx + vw + 30 : M;
  ctx.fillStyle = th.card;
  rr(ctx, cx0, vy, cw, vh, 34);
  ctx.fill();
  await drawLogo(ctx, p, th, cx0 + cw / 2, vy + 44 + 95, 190);
  const ctaLines = wrapText(p.cta || CTA_DEFAULT, cw - 56, (t) => textWidth(ctx, t, 30, '800')).slice(0, 3);
  let cy = vy + 44 + 190 + 30 + 19;
  for (const line of ctaLines) {
    drawText(ctx, line, cx0 + cw / 2, cy, 30, '800', '#ffffff', 'center');
    cy += 38;
  }
  const pills = SOCIALS.map((s) => ({ s, t: socialText(s, p) })).filter((x) => x.t);
  if (pills.length) {
    const startY = cy - 19 + 24;
    const avail = vy + vh - 30 - startY;
    const gap = 14;
    const pillH = Math.min(76, Math.floor((avail - (pills.length - 1) * gap) / pills.length));
    let y = startY;
    for (const { s, t } of pills) {
      ctx.fillStyle = s.color;
      rr(ctx, cx0 + 28, y, cw - 56, pillH, Math.round(pillH * 0.28));
      ctx.fill();
      const size = fitSize(ctx, t, cw - 56 - 32, Math.min(32, Math.round(pillH * 0.46)), '700', 16);
      drawText(ctx, t, cx0 + cw / 2, y + pillH / 2 + 1, size, '700', '#ffffff', 'center');
      y += pillH + gap;
    }
  }

  // bottom bar
  ctx.fillStyle = th.head;
  rr(ctx, M, BAR.y, fullW, BAR.h, 11);
  ctx.fill();

  // corner mask + border around the video box
  const mask = canvasLib.createCanvas(W, H);
  const m = mask.getContext('2d');
  m.fillStyle = PAGE;
  m.beginPath();
  m.rect(vx - 4, vy - 4, vw + 8, vh + 8);
  rr(m, vx, vy, vw, vh, 30, false);
  m.fill('evenodd');
  rr(m, vx, vy, vw, vh, 30);
  m.lineWidth = 6;
  m.strokeStyle = th.head;
  m.stroke();

  const box = { x: vx, y: vy, w: vw, h: vh };
  if (preview) {
    ctx.fillStyle = '#0f172a';
    rr(ctx, vx, vy, vw, vh, 30);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const mx = vx + vw / 2;
    const my = vy + vh / 2 - 20;
    ctx.moveTo(mx - 34, my - 52);
    ctx.lineTo(mx - 34, my + 52);
    ctx.lineTo(mx + 56, my);
    ctx.closePath();
    ctx.fill();
    drawText(ctx, 'YOUR VIDEO', mx, my + 120, 34, '800', '#94a3b8', 'center');
    ctx.drawImage(mask, 0, 0);
    return { base: canvas.toBuffer('image/png'), mask: null, box };
  }
  return { base: canvas.toBuffer('image/png'), mask: mask.toBuffer('image/png'), box };
}

// ---------- ffmpeg ----------
const jobs = new Map(); // userId -> { cancelled, procs:Set }
let active = 0;

function runFfmpeg(args, job, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (job) job.procs.add(child);
    let err = '';
    child.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-6000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (job) job.procs.delete(child);
      if (job && job.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code === 0 || allowFail) return resolve(err);
      reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with ${code}`));
    });
  });
}
async function probeDuration(file) {
  const out = await runFfmpeg(['-hide_banner', '-i', file], null, { allowFail: true });
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}
function buildArgs({ src, basePng, maskPng, box, out, maxKbps, secs }) {
  const { x, y, w, h } = box;
  const fc = [
    '[1:v]fps=30,setsar=1,split=2[a][b]',
    `[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=28:4[bg]`,
    `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[vb]',
    `[0:v][vb]overlay=${x}:${y}:shortest=1[t]`,
    '[t][2:v]overlay=0:0,format=yuv420p[v]',
  ].join(';');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', basePng, '-i', src, '-i', maskPng];
  args.push('-filter_complex', fc, '-map', '[v]', '-map', '1:a?', '-t', String(Math.ceil(secs)));
  args.push('-c:v', 'libx264', '-preset', ENC_PRESET, '-crf', ENC_CRF, '-pix_fmt', 'yuv420p');
  if (maxKbps > 0) args.push('-maxrate', `${maxKbps}k`, '-bufsize', `${maxKbps * 2}k`);
  args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', out);
  return args;
}

function downloadTo(url, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    const req = lib.get(String(url), (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const out = fs.createWriteStream(dest);
      let n = 0;
      res.on('data', (d) => {
        n += d.length;
        if (n > maxBytes) req.destroy(new Error('File too big'));
      });
      res.pipe(out);
      out.on('finish', () => resolve(n));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Download timed out')));
  });
}
function httpGetBuf(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https') ? https : http;
    lib
      .get(String(url), (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 30 * 60 * 1000 });
const pending = new Map(); // userId -> { kind: 'details' | 'logo' | 'headline', ..., expires }
setInterval(() => {
  const now = Date.now();
  for (const [uid, p] of pending) if (p.expires < now) pending.delete(uid);
}, 5 * 60 * 1000);
const setPending = (uid, kind, extra = {}) => pending.set(uid, { kind, expires: Date.now() + 10 * 60 * 1000, ...extra });

const BTN_MAKE = '🎬 Make a blog video';
const BTN_BLOG = '⚙️ My blog';
const BTN_PREVIEW = '👁 Preview';
const BTN_HELP = '❓ Help';
const mainMenu = Markup.keyboard([[BTN_MAKE], [BTN_BLOG, BTN_PREVIEW], [BTN_HELP]]).resize().placeholder('Send a video…');

const HELP =
  '📰 <b>Blog frame bot</b>\n\n' +
  'Send me a short video and I\'ll put it inside your blog-post frame: your <b>blog name</b> at the top, a headline, your <b>social handles</b> on one side and the video on the other.\n\n' +
  '1️⃣ Tap <b>⚙️ My blog</b> and save your details once (name, @handle, socials, logo)\n' +
  '2️⃣ Send a video. The <b>caption you write on it becomes the headline</b>. No caption? I\'ll ask for one.\n' +
  '3️⃣ Get your finished video back\n\n' +
  `📏 Videos up to <b>${fmtDuration(MAX_SEC)}</b> and <b>${DOWNLOAD_LIMIT_MB} MB</b> (Telegram\'s limit for bots).` +
  (DAILY_LIMIT ? `\n🆓 ${DAILY_LIMIT} videos per day.` : '') +
  '\n\n<i>Tip: if your video is bigger than 20 MB, send it as a normal video (not as a file) so Telegram compresses it first.</i>';

function blogMenu(p) {
  const ok = ready(p);
  const th = ok ? THEMES[p.theme] || THEMES.slate : THEMES.slate;
  let text = '⚙️ <b>My blog</b>\n\n';
  if (!ok) text += 'Save your blog details once, then every video you send gets your frame. Tap <b>✏️ Set up my blog</b> 👇';
  else {
    const socials = SOCIALS.map((s) => socialText(s, p)).filter(Boolean);
    text +=
      `<b>${escHtml(p.name)}</b>${p.handle ? ' · ' + escHtml(p.handle) : ''}\n` +
      (socials.length ? socials.map((x) => '• ' + escHtml(x)).join('\n') + '\n' : '') +
      `🖼 Logo: ${p.logo ? 'set' : 'not set'}  ·  🎨 ${th.label.replace(/^\S+\s/, '')}  ·  🎞 Video on the <b>${p.swap ? 'left' : 'right'}</b>`;
  }
  const rows = [[Markup.button.callback(ok ? '✏️ Edit details' : '✏️ Set up my blog', 'edit')]];
  if (ok) {
    rows.push([Markup.button.callback('🖼 Logo', 'logo'), Markup.button.callback('🎨 Colour', 'theme')]);
    rows.push([Markup.button.callback(`↔️ Video: ${p.swap ? 'Left' : 'Right'}`, 'swap'), Markup.button.callback('👁 Preview', 'prev')]);
    rows.push([Markup.button.callback('🗑 Reset', 'reset')]);
  }
  return { text, markup: Markup.inlineKeyboard(rows).reply_markup };
}
const openBlog = (ctx) => {
  const m = blogMenu(getProfile(ctx.from.id));
  return ctx.reply(m.text, { parse_mode: 'HTML', reply_markup: m.markup });
};
const refreshBlog = (ctx) => {
  const m = blogMenu(getProfile(ctx.from.id));
  return ctx.editMessageText(m.text, { parse_mode: 'HTML', reply_markup: m.markup }).catch(() => {});
};

bot.start(async (ctx) => {
  await ctx.reply('🏠 Ready. Use the buttons below.', mainMenu);
  await ctx.reply(HELP, { parse_mode: 'HTML' });
  if (!ready(getProfile(ctx.from.id))) await openBlog(ctx);
});
bot.command('menu', (ctx) => ctx.reply('🏠 Menu', mainMenu));
bot.help((ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
bot.command('blog', (ctx) => openBlog(ctx));
bot.command('cancel', async (ctx) => {
  const job = jobs.get(ctx.from.id);
  if (!job) return ctx.reply('Nothing is running right now.');
  cancelJob(job);
  return ctx.reply('🛑 Stopping…');
});
bot.hears(BTN_MAKE, (ctx) => {
  if (!ready(getProfile(ctx.from.id))) return openBlog(ctx);
  return ctx.reply('🎬 Send me the video now (add a caption to use it as the headline).');
});
bot.hears(BTN_BLOG, (ctx) => openBlog(ctx));
bot.hears(BTN_HELP, (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
bot.hears(BTN_PREVIEW, (ctx) => sendPreview(ctx));

function cancelJob(job) {
  job.cancelled = true;
  for (const p of job.procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

async function sendPreview(ctx) {
  const p = getProfile(ctx.from.id);
  if (!ready(p)) return openBlog(ctx);
  try {
    const f = await renderFrame(p, 'Your headline goes here: the caption you write on the video 🔥', { preview: true });
    await ctx.replyWithPhoto({ source: f.base }, { caption: '👁 <b>Preview</b>: your video goes in the dark box.', parse_mode: 'HTML' });
  } catch (e) {
    console.error('Preview error:', e.stack || e.message);
    await ctx.reply('❌ Couldn\'t draw the preview.' + (isAdmin(ctx.from.id) ? '\n\nDebug: ' + escHtml(clip(e.message, 300)) : ''), { parse_mode: 'HTML' });
  }
}

// ----- blog menu buttons -----
bot.action('edit', async (ctx) => {
  await ctx.answerCbQuery();
  setPending(ctx.from.id, 'details');
  return ctx.reply(
    '✏️ <b>Your blog details</b>\n\nCopy this, change it, and send it back. Delete the lines you don\'t use. ' +
      'When editing later, only the lines you send are changed (write <code>IG: -</code> to remove one).\n\n<pre>' +
      escHtml(template(getProfile(ctx.from.id))) +
      '</pre>',
    { parse_mode: 'HTML' }
  );
});
bot.action('logo', async (ctx) => {
  await ctx.answerCbQuery();
  setPending(ctx.from.id, 'logo');
  return ctx.reply('🖼 Send your <b>logo as a photo</b> (a square picture works best).', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🚫 Remove my logo', 'nologo')]]),
  });
});
bot.action('nologo', async (ctx) => {
  const p = getProfile(ctx.from.id);
  if (p) {
    p.logo = null;
    setProfile(ctx.from.id, p);
  }
  pending.delete(ctx.from.id);
  await ctx.answerCbQuery('Logo removed');
  return ctx.editMessageText('🚫 Logo removed. Your blog\'s initials are used instead.').catch(() => {});
});
bot.action('theme', async (ctx) => {
  await ctx.answerCbQuery();
  const btns = Object.keys(THEMES).map((k) => Markup.button.callback(THEMES[k].label, `t:${k}`));
  return ctx
    .editMessageText('🎨 <b>Pick a colour</b> for the header and social card:', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([btns.slice(0, 3), btns.slice(3), [Markup.button.callback('⬅️ Back', 'back')]]).reply_markup,
    })
    .catch(() => {});
});
bot.action(/^t:(\w+)$/, async (ctx) => {
  const p = getProfile(ctx.from.id);
  if (!p || !THEMES[ctx.match[1]]) return ctx.answerCbQuery();
  p.theme = ctx.match[1];
  setProfile(ctx.from.id, p);
  await ctx.answerCbQuery('Colour changed');
  return refreshBlog(ctx);
});
bot.action('back', async (ctx) => {
  await ctx.answerCbQuery();
  return refreshBlog(ctx);
});
bot.action('swap', async (ctx) => {
  const p = getProfile(ctx.from.id);
  if (!p) return ctx.answerCbQuery();
  p.swap = !p.swap;
  setProfile(ctx.from.id, p);
  await ctx.answerCbQuery(p.swap ? 'Video on the left' : 'Video on the right');
  return refreshBlog(ctx);
});
bot.action('prev', async (ctx) => {
  await ctx.answerCbQuery('Drawing…');
  return sendPreview(ctx);
});
bot.action('reset', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx
    .editMessageText('🗑 Delete your saved blog details and logo?', {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('Yes, delete', 'reset2'), Markup.button.callback('Keep', 'back')]]).reply_markup,
    })
    .catch(() => {});
});
bot.action('reset2', async (ctx) => {
  delete db.profiles[ctx.from.id];
  saveDb();
  await ctx.answerCbQuery('Deleted');
  return ctx.editMessageText('🗑 Deleted. Tap <b>⚙️ My blog</b> to set up again.', { parse_mode: 'HTML' }).catch(() => {});
});
bot.action('hl_skip', async (ctx) => {
  const pend = pending.get(ctx.from.id);
  if (!pend || pend.kind !== 'headline' || pend.expires < Date.now()) return ctx.answerCbQuery('That request expired. Send the video again.', { show_alert: true });
  pending.delete(ctx.from.id);
  await ctx.answerCbQuery('Starting…');
  await ctx.editMessageText('⏭ No headline: using your blog name.').catch(() => {});
  makeVideo(ctx, { ...pend.video, headline: '' }).catch((e) => console.error('Job error:', e.message));
});
bot.action('cancel_job', async (ctx) => {
  const job = jobs.get(ctx.from.id);
  if (!job) return ctx.answerCbQuery('Nothing is running.');
  cancelJob(job);
  return ctx.answerCbQuery('🛑 Stopping…');
});

// ----- logo upload (photo or image file) -----
async function saveLogo(ctx, fileId) {
  const uid = ctx.from.id;
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const img = await canvasLib.loadImage(await httpGetBuf(link));
    const S = 256;
    const c = canvasLib.createCanvas(S, S);
    const side = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
    const p = getProfile(uid) || newProfile();
    p.logo = c.toBuffer('image/png').toString('base64');
    setProfile(uid, p);
    pending.delete(uid);
    await ctx.reply('✅ <b>Logo saved.</b>', { parse_mode: 'HTML' });
    if (ready(p)) await openBlog(ctx);
  } catch (e) {
    console.error('Logo error:', e.message);
    await ctx.reply('❌ I couldn\'t read that picture. Send it again as a normal photo.');
  }
}
bot.on('photo', async (ctx, next) => {
  const pend = pending.get(ctx.from.id);
  if (!pend || pend.kind !== 'logo') return next();
  const photos = ctx.message.photo;
  return saveLogo(ctx, photos[photos.length - 1].file_id);
});

// ----- text: blog details or headline -----
bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const text = ctx.message.text;
  const pend = pending.get(uid);
  if (pend && pend.expires > Date.now()) {
    if (pend.kind === 'details') {
      const fields = parseDetails(text);
      if (!Object.keys(fields).length) {
        return ctx.reply('⚠️ I couldn\'t read that. Send it like this, one per line:\n\n<pre>' + escHtml(template(null)) + '</pre>', { parse_mode: 'HTML' });
      }
      const p = getProfile(uid) || newProfile();
      Object.assign(p, fields);
      if (!p.name) return ctx.reply('⚠️ Your blog needs a <b>Name:</b> line.', { parse_mode: 'HTML' });
      pending.delete(uid);
      setProfile(uid, p);
      await ctx.reply('✅ <b>Saved!</b> Add a logo with 🖼 Logo, then send me a video.', { parse_mode: 'HTML' });
      return openBlog(ctx);
    }
    if (pend.kind === 'logo') return ctx.reply('🖼 Send your logo as a <b>photo</b> (not text).', { parse_mode: 'HTML' });
    if (pend.kind === 'headline') {
      pending.delete(uid);
      const headline = Array.from(text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()).slice(0, 180).join('');
      makeVideo(ctx, { ...pend.video, headline }).catch((e) => console.error('Job error:', e.message));
      return;
    }
  }
  return ctx.reply('🎬 Send me a <b>video</b> to put in your blog frame, or use the menu buttons.', { parse_mode: 'HTML', ...mainMenu });
});

// ----- the video upload -----
bot.on(['video', 'animation', 'video_note', 'document'], async (ctx, next) => {
  const m = ctx.message;
  const uid = ctx.from.id;
  const pend = pending.get(uid);
  // an image sent as a file while we wait for the logo
  if (m.document && pend && pend.kind === 'logo' && /^image\//.test(m.document.mime_type || '')) return saveLogo(ctx, m.document.file_id);
  const f = m.video || m.animation || m.video_note || (m.document && /^video\//.test(m.document.mime_type || '') ? m.document : null);
  if (!f) return next();

  if (!ready(getProfile(uid))) {
    await ctx.reply('📰 Set up your blog first (name, handle, socials). It takes a minute 👇');
    return openBlog(ctx);
  }
  if (f.duration && f.duration > MAX_SEC) {
    return ctx.reply(`❌ <b>That video is ${fmtDuration(f.duration)}</b>. The longest I accept is ${fmtDuration(MAX_SEC)}.`, { parse_mode: 'HTML' });
  }
  if (f.file_size && f.file_size > DOWNLOAD_LIMIT_MB * 1024 * 1024) {
    return ctx.reply(
      `❌ <b>That file is ${mb(f.file_size)} MB.</b> Telegram only lets bots download files up to ${DOWNLOAD_LIMIT_MB} MB.\n\nSend it as a normal video (not as a file) so Telegram compresses it, or trim it first.`,
      { parse_mode: 'HTML' }
    );
  }
  const video = { fileId: f.file_id, size: f.file_size || 0, duration: f.duration || 0 };
  const caption = Array.from((m.caption || '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()).slice(0, 180).join('');
  if (caption) {
    makeVideo(ctx, { ...video, headline: caption }).catch((e) => console.error('Job error:', e.message));
    return;
  }
  setPending(uid, 'headline', { video });
  return ctx.reply('✍️ <b>Type the headline</b> for this video (it goes in the white box under your blog name).', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('⏭ Skip, use my blog name', 'hl_skip')]]),
  });
});

// ----- the job -----
async function makeVideo(ctx, o) {
  const uid = ctx.from.id;
  const p = getProfile(uid);
  if (!ready(p)) return openBlog(ctx);
  if (jobs.has(uid)) return ctx.reply('⏳ You already have a video in progress. Wait for it to finish (or /cancel).');
  if (active >= MAX_CONCURRENT) return ctx.reply('⏳ I\'m busy with other videos. Try again in a minute.');
  if (DAILY_LIMIT && !isAdmin(uid) && usedToday(uid) >= DAILY_LIMIT) {
    return ctx.reply(`🔒 You\'ve used your ${DAILY_LIMIT} free videos for today. Come back tomorrow.`);
  }

  const id = crypto.randomBytes(4).toString('hex');
  const prefix = path.join(TMP_DIR, id);
  const job = { cancelled: false, procs: new Set() };
  jobs.set(uid, job);
  active++;
  const cancelKb = Markup.inlineKeyboard([[Markup.button.callback('🛑 Cancel', 'cancel_job')]]).reply_markup;
  const status = await ctx.reply('⬇️ <b>Getting your video…</b>\n▰▱▱  Step 1 of 3', { parse_mode: 'HTML', reply_markup: cancelKb });
  const edit = (t, markup) =>
    ctx.telegram
      .editMessageText(ctx.chat.id, status.message_id, undefined, t, { parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) })
      .catch(() => {});
  const check = () => {
    if (job.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
  };
  const headline = (o.headline || '').trim() || p.name;
  let stage = 'download';
  try {
    ctx.sendChatAction('upload_video').catch(() => {});
    const src = `${prefix}_src.mp4`;
    const link = await ctx.telegram.getFileLink(o.fileId);
    await downloadTo(link, src, DOWNLOAD_LIMIT_MB * 1024 * 1024 + 1024 * 1024);
    check();

    stage = 'render';
    await edit('🖼 <b>Building your blog frame…</b>\n▰▰▱  Step 2 of 3', cancelKb);
    const secs = Math.max(1, Math.min((await probeDuration(src).catch(() => 0)) || o.duration || 60, MAX_SEC + 1));
    if (secs > MAX_SEC) {
      await edit(`❌ <b>That video is ${fmtDuration(secs)}</b>. The longest I accept is ${fmtDuration(MAX_SEC)}.`);
      return;
    }
    const frame = await renderFrame(p, headline);
    const basePng = `${prefix}_base.png`;
    const maskPng = `${prefix}_mask.png`;
    fs.writeFileSync(basePng, frame.base);
    fs.writeFileSync(maskPng, frame.mask);
    const out = `${prefix}_out.mp4`;
    const maxKbps = Math.max(400, Math.min(12000, Math.floor((UPLOAD_LIMIT_MB * 1024 * 1024 * 8 * 0.9) / secs / 1000) - 128));
    await runFfmpeg(buildArgs({ src, basePng, maskPng, box: frame.box, out, maxKbps, secs }), job);
    check();

    const size = fs.statSync(out).size;
    if (size > UPLOAD_LIMIT_MB * 1024 * 1024) {
      await edit(`❌ <b>The result is ${mb(size)} MB</b>, over Telegram\'s ${UPLOAD_LIMIT_MB} MB limit. Try a shorter video.`);
      return;
    }
    stage = 'upload';
    await edit(`⬆️ <b>Uploading (${mb(size)} MB)…</b>\n▰▰▰  Step 3 of 3`);
    ctx.sendChatAction('upload_video').catch(() => {});
    await ctx.replyWithVideo(
      { source: out },
      {
        caption: `${escHtml(clip(headline, 300))}\n\n✅ <i>Made with @${ctx.botInfo.username}</i>`.slice(0, 1000),
        parse_mode: 'HTML',
        duration: Math.round(secs),
        width: W,
        height: H,
        supports_streaming: true,
      }
    );
    if (!isAdmin(uid)) bumpUsage(uid);
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (err) {
    if (err.cancelled || job.cancelled) {
      await edit('🛑 <b>Cancelled.</b> Nothing was sent.');
    } else {
      console.error('Job error:', stage, err.stack || err.message);
      const msg =
        stage === 'download'
          ? '❌ <b>I couldn\'t download that video.</b> Please send it again.'
          : '❌ <b>Couldn\'t build the blog frame.</b> Please try again.';
      await edit(msg + (isAdmin(uid) ? '\n\nDebug: ' + escHtml(clip(err.message, 300)) : ''));
    }
  } finally {
    active--;
    jobs.delete(uid);
    for (const f of fs.readdirSync(TMP_DIR)) if (f.startsWith(id)) fs.unlink(path.join(TMP_DIR, f), () => {});
  }
}

bot.catch((err, ctx) => console.error('Bot error for update', ctx && ctx.update && ctx.update.update_id, err.message));

// Runs once at startup and prints the result in the log, so a drawing problem on the server is visible straight away
async function selfTest() {
  console.log(`Node ${process.version}, ffmpeg: ${FFMPEG}`);
  try {
    const f = await renderFrame(
      { ...newProfile(), name: 'Self Test Media', handle: '@selftest', ig: '@selftest', wa: '08000000000' },
      'Self test headline 🔥',
      { preview: true }
    );
    console.log(`Frame self-test OK (${f.base.length} bytes)`);
  } catch (e) {
    console.error('Frame self-test FAILED:', e.stack || e.message);
  }
  try {
    await runFfmpeg(['-version'], null);
    console.log('ffmpeg OK');
  } catch (e) {
    console.error('ffmpeg self-test FAILED:', e.message);
  }
}

(async () => {
  await selfTest();
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🏠 Start' },
      { command: 'blog', description: '⚙️ My blog details' },
      { command: 'cancel', description: '🛑 Stop the running job' },
      { command: 'help', description: '❓ How it works' },
    ]);
  } catch (e) {
    console.error('Menu setup error:', e.message);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.launch({ dropPendingUpdates: true }, () => console.log('Blog frame bot running…'));
      return;
    } catch (err) {
      const is409 = err && err.response && err.response.error_code === 409;
      if (is409 && attempt <= 12) {
        console.warn(`409 Conflict: another instance is polling this token. Retry ${attempt}/12 in 10s…`);
        try {
          bot.stop('retry');
        } catch {
          /* not running */
        }
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      console.error('Startup error:', err);
      process.exit(1);
    }
  }
})();

function shutdown(sig) {
  for (const job of jobs.values()) cancelJob(job);
  try {
    bot.stop(sig);
  } catch {
    /* not running */
  }
  setTimeout(() => process.exit(0), 500).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));