// Chánh Điện Tịnh Tâm — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
const PORT = +process.env.PORT || 3000;

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'Chánh Điện Tịnh Tâm',
  subtitle: 'Nam Mô A Di Đà Phật',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: true, moBpm: 52,
  autoChant: true, chantEveryMin: 3,
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  joinOnEnter: false,                // also seat viewers who only enter the room
  bowSpeed: 'vua', bows: 3,          // how fast and how many times a giver bows
  gifts: { readAll: true, minDiamonds: 1 },
};
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
const startedAt = Date.now();
let tiktok = null, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const log = [];
function addLog(s){ const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t:'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity(){ if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
// A comment changes the outfit only when the whole comment IS the keyword: "Nam mô", "chị ơi" or "thầy ơi" are ordinary talk. Words people use to address each other are not keywords.
const SKIN_WORDS = [
  ['master', ['cao tăng','cao tang']], ['monk', ['sư','su','sư thầy','su thay']], ['nun', ['ni','ni cô','ni co','sư cô','su co']],
  ['child', ['tiểu','tieu','chú tiểu','chu tieu']], ['granny', ['bà','áo nâu','ao nau']],
  ['woman', ['nữ','nu']], ['man', ['nam']],
];
function skinFromText(t){
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const [skin, words] of SKIN_WORDS) if (words.includes(w)) return skin;
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'], chosenSkins = new Map();     // id -> the outfit they asked for
const defaultSkin = id => DEFAULT_SKINS[[...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % DEFAULT_SKINS.length];

// What one gift (price × count) becomes on the altar: vegetarian offerings only, as on a Buddha's altar. The thresholds live only here: the overlay receives them in its snapshot.
const OFFERINGS = [
  { min: 1, key: 'huong', name: 'một nén hương', short: 'Thắp hương' },
  { min: 5, key: 'sen', name: 'hoa sen', short: 'Hoa sen' },
  { min: 10, key: 'nen', name: 'đôi nến', short: 'Đôi nến' },
  { min: 30, key: 'nguqua', name: 'mâm ngũ quả', short: 'Mâm ngũ quả' },
  { min: 50, key: 'banh', name: 'bánh chưng', short: 'Bánh chưng' },
  { min: 100, key: 'xoi', name: 'xôi chè', short: 'Xôi chè' },
  { min: 500, key: 'lequa', name: 'lễ hoa quả', short: 'Lễ hoa quả' },
  { min: 1000, key: 'lexoi', name: 'lễ xôi quả', short: 'Lễ xôi quả' },
  { min: 5000, key: 'lechay', name: 'mâm lễ chay', short: 'Mâm lễ chay' },
  { min: 30000, key: 'daile', name: 'đại lễ chay', short: 'Đại lễ chay' },
];
const offeringFor = coins => OFFERINGS.findLast(o => coins >= o.min) || OFFERINGS[0];

function pub(v){ return { id:v.id, name:v.name, skin:v.skin, avatar:v.avatar||'', coins:v.coins, demo:!!v.demo }; }
function snapshot(){ return { t:'state', settings, viewers:[...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState, offers: OFFERINGS }; }

function seat(id, name, opts = {}){
  let v = viewers.get(id);
  if (v){ v.lastAt = Date.now(); if (opts.avatar) v.avatar = opts.avatar; return { v, isNew:false }; }
  const limit = settings.seatMode === 'auto' ? 100 : +settings.seatMode;
  while (viewers.size >= limit){                // full, and nobody who comments or gives is ever turned away. Who stands up: a quiet non-donor, then the smallest quiet donor, then whoever has been silent longest.
    const all = [...viewers.values()], idle = all.filter(x => Date.now() - x.lastAt > 30_000);
    const out = idle.filter(x => x.coins === 0).sort((a,b) => a.lastAt - b.lastAt)[0] || idle.sort((a,b) => a.coins - b.coins || a.lastAt - b.lastAt)[0] || all.sort((a,b) => a.lastAt - b.lastAt)[0];
    viewers.delete(out.id); broadcast({ t:'leave', id: out.id });
  }
  v = { id, name: (name||id).slice(0, 18), skin: opts.skin || chosenSkins.get(id) || defaultSkin(id),
        avatar: opts.avatar || '', coins: 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo };
  viewers.set(id, v);
  broadcast({ t:'join', v: pub(v), cap: capacity() });
  return { v, isNew:true };
}

/* ------------------------------------------------------------- events in */
function onChat(id, name, text, avatar){
  text = String(text || '').slice(0, 120); id = String(id ?? name ?? 'khach');
  const want = skinFromText(text);
  if (want) chosenSkins.set(id, want);
  const { v, isNew } = seat(id, name, { avatar, skin: want || undefined });
  if (!isNew && want && want !== v.skin){ v.skin = want; broadcast({ t:'skin', id, skin: want }); }
  v.lastText = text; v.lastTextAt = Date.now();
  broadcast({ t:'chat', id, name: v.name, text });
}

function onGift(id, name, giftName, count, diamonds, avatar){
  giftName = String(giftName || 'quà').slice(0, 30); count = Math.max(1, Math.min(9999, +count || 1)); id = String(id ?? name ?? 'khach');
  const { v } = seat(id, name, { avatar });
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins;
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && v.lastText.length > 6) ? v.lastText : pickPrayer();
  const tier = coins >= 1000 ? 3 : coins >= 100 ? 2 : 1;
  const offer = offeringFor(coins);
  const line = `Nam mô A Di Đà Phật. Phật tử ${spoken(v.name)} thành tâm dâng ${offer.name}. ${prayer}.`;
  broadcast({ t:'gift', id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer, offer: offer.key, offerName: offer.name });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag:'gift', id });
}

function pickPrayer(){
  const P = ['Nguyện cầu gia đạo bình an, vạn sự cát tường', 'Nguyện cầu cha mẹ mạnh khỏe, sống lâu', 'Nguyện hồi hướng công đức cho khắp pháp giới chúng sinh',
             'Nguyện cầu thân tâm an lạc, phiền não tiêu trừ', 'Nguyện cầu công việc hanh thông, gia đình hạnh phúc'];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s){ return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function say(text, meta = {}){ if (meta.tag !== 'gift' && ttsQueue.length >= 15) {     // a gift is always read out; only announcements can be skipped when busy
 addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; } ttsQueue.push({ text: String(text).slice(0, 500), meta }); pumpTTS(); }
async function synth(text){
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('close', res); audioStream.on('error', rej); });
    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new Error('Edge TTS trả về âm thanh rỗng');
    return audio;
  } finally { try { tts.close(); } catch {} }
}
// Edge TTS often drops the socket (code 1006) about 2.4s into a line it has not cached, so failed lines are retried.
const TTS_TRIES = 6;
async function synthWithRetry(text){
  for (let i = 1; ; i++){
    try { return await synth(text); }
    catch (e) { if (i >= TTS_TRIES) throw e; await new Promise(r => setTimeout(r, 300)); }
  }
}
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  try {
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    fs.writeFileSync(path.join(TTS_DIR, file), await synthWithRetry(text));
    broadcast({ t:'tts', url: `/live/tts/${file}`, text, ...meta });
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 400) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }     // room for a long backlog: the overlay may not have played these yet
  } catch (e) {
    const tries = (meta.tries || 0) + 1;
    if (meta.tag === 'gift' && tries <= 3){ ttsQueue.push({ text, meta: { ...meta, tries } }); addLog(`TTS lỗi, sẽ đọc lại câu tặng quà (lần ${tries})`); }
    else addLog('TTS lỗi: ' + (e?.message || e));
  }
  ttsBusy = false; setTimeout(pumpTTS, 50);
}

const CHANTS = [
  'Nam mô Bổn Sư Thích Ca Mâu Ni Phật. Nguyện đem công đức này, hướng về khắp tất cả, đệ tử và chúng sinh, đều trọn thành Phật đạo.',
  'Nam mô A Di Đà Phật. Nguyện sanh Tây Phương Tịnh Độ trung, cửu phẩm liên hoa vi phụ mẫu.',
  'Nam mô Đại Bi Quán Thế Âm Bồ Tát. Nguyện cho tất cả chúng sinh thân tâm an lạc, tai qua nạn khỏi.',
  'Quán Tự Tại Bồ Tát hành thâm Bát Nhã Ba La Mật Đa thời, chiếu kiến ngũ uẩn giai không, độ nhất thiết khổ ách.',
];
let chantIdx = 0, chantTimer = null;
function chant(){ const text = CHANTS[chantIdx++ % CHANTS.length]; broadcast({ t:'chant', text }); say(text, { tag:'chant' }); }
function scheduleChant(){ clearInterval(chantTimer); if (settings.autoChant) chantTimer = setInterval(chant, Math.max(1, settings.chantEveryMin) * 60_000); }
scheduleChant();

/* --------------------------------------------------------------- TikTok */
let TikTokLib = null;
let tiktokBusy = false;
// Dropped connections come back on their own, so a network blip does not silently lose the rest of the live.
let tiktokWanted = null, retryTimer = null, retries = 0;
function scheduleRetry(){
  clearTimeout(retryTimer); if (!tiktokWanted) return;
  if (retries >= 40){ addLog(`❌ Đã thử kết nối lại @${tiktokWanted} ${retries} lần không được. Bấm Kết nối để thử lại.`); tiktokWanted = null; return; }
  retries++; addLog(`🔄 Sẽ kết nối lại @${tiktokWanted} (lần ${retries})`);
  retryTimer = setTimeout(() => connectTikTok(tiktokWanted), 15_000);
}
// An exception in one handler must not take the rest of TikTok's batch of events down with it.
const safely = fn => (...args) => { try { fn(...args); } catch (e) { addLog('Lỗi xử lý sự kiện TikTok: ' + (e?.message || e)); } };
async function connectTikTok(uniqueId){
  if (tiktokBusy) return;                                       // a double click must not open a second connection
  tiktokBusy = true;
  try { await openTikTok(uniqueId); } finally { tiktokBusy = false; }
}
async function openTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t:'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: false, processInitialData: false });
    const uid = u => u?.displayId || u?.id;
    const av = u => u?.avatarThumb?.urlList?.[0] || '';
    const nm = u => u?.nickname || u?.displayId || 'ẩn danh';
    conn.on(WebcastEvent.CHAT, safely(d => onChat(uid(d.user), nm(d.user), d.content, av(d.user))));
    conn.on(WebcastEvent.GIFT, safely(d => {
      if (d.gift?.type === 1 && !d.repeatEnd) return;               // streak still running
      const gname = d.gift?.name || 'quà';
      onGift(uid(d.user), nm(d.user), gname, d.repeatCount || 1, d.gift?.diamondCount ?? 1, av(d.user));
      addLog(`🎁 ${nm(d.user)} tặng ${gname} x${d.repeatCount || 1}`);
    }));
    conn.on(WebcastEvent.MEMBER, safely(d => { if (settings.joinOnEnter) seat(uid(d.user), nm(d.user), { avatar: av(d.user) }); }));
    conn.on(WebcastEvent.LIKE, safely(d => broadcast({ t:'like', id: uid(d.user), n: d.count || 1 })));
    conn.on(ControlEvent.DISCONNECTED, () => { if (conn !== tiktok) return; tiktok = null; tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t:'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối'); scheduleRetry(); });
    conn.on(ControlEvent.ERROR, e => addLog('TikTok lỗi: ' + (e?.info || e?.message || e)));
    const st = await conn.connect();
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: st?.roomId || '' };
    tiktokWanted = uniqueId; retries = 0; clearTimeout(retryTimer);
    if (botTimer){ setBots(false); addLog('Đã tắt bot vì đang nối phòng live thật: người xem thật không được thấy người và quà giả.'); }
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
    if (tiktokWanted === uniqueId) scheduleRetry();
  }
  broadcast({ t:'tiktok', ...tiktokState });
}
async function disconnectTikTok(){ if (tiktok){ const c = tiktok; tiktok = null; try { await c.disconnect(); } catch {} } tiktokState = { status:'idle', uniqueId:'', error:'' }; broadcast({ t:'tiktok', ...tiktokState }); }

/* ------------------------------------------------------------- test data */
const DEMO_NAMES = ['Diệu Hạnh','Minh Tâm','Thiện Đức','Huệ An','Tịnh Nhã','Quảng Trí','Chơn Như','Pháp Hỷ','Nguyên Thanh','Tâm Đăng','Diệu Liên','Trí Hải','Phước Lộc','Hạnh Nguyện','Như Ý','Bảo Châu','Thanh Lương','Từ Tâm','An Lạc','Giác Hoa','Tuệ Minh','Liên Hương','Thu Hà','Ngọc Lan','Đức Anh','Hải Đăng','Mai Anh','Phương Thảo','Trung Kiên','Quang Huy','Bảo Ngọc','Diệu Linh'];
function fillDemo(n){
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++){
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    seat('demo_' + i, name, { demo: true, skin: ['man','woman','woman','man','granny','monk','nun','child'][i % 8] });
  }
}
function clearSeats(){ viewers.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
function onControl(m){
  switch (m.cmd){
    case 'connect': tiktokWanted = null; clearTimeout(retryTimer); connectTikTok(m.uniqueId); break;
    case 'disconnect': tiktokWanted = null; clearTimeout(retryTimer); disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': { const n = String(m.name || 'Khách').slice(0, 18); onChat('sim_' + n, n, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120)); break; }
    case 'gift': { const n = String(m.name || 'Khách').slice(0, 18); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'bell': broadcast({ t:'bell' }); break;
    case 'mo': broadcast({ t:'mo1' }); break;
    case 'chant': chant(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag:'say' }); break;
    case 'settings':
      applySettings(m.settings || {});
      scheduleChant(); broadcast({ t:'settings', settings, cap: capacity(), offers: OFFERINGS }); saveSettings(); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
    case 'yt': broadcast({ t:'yt', action: m.action, volume: m.volume }); break;
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  music: Boolean, mo: Boolean, autoChant: Boolean, joinOnEnter: Boolean,
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
  bowSpeed: v => ['cham', 'vua', 'nhanh'].includes(v) ? v : 'vua', bows: v => clamp(v, 1, 3),
  // the coins of each offering: must start at 1 and rise from one to the next, otherwise the current ones stay
  offerMins: v => {
    const m = Array.isArray(v) && v.length === OFFERINGS.length ? v.map(x => clamp(x, 1, 30000)) : null;
    if (!m || m[0] !== 1 || m.some((x, i) => i && x <= m[i - 1])){ addLog('Mốc xu không hợp lệ: phải bắt đầu từ 1 và tăng dần, tối đa 30.000. Giữ nguyên mốc cũ.'); return OFFERINGS.map(o => o.min); }
    m.forEach((x, i) => { OFFERINGS[i].min = x; });
    return m;
  },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o){ for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }
// Settings survive a restart, in a local file that is not part of the shared code.
const SETTINGS_FILE = path.join(__dirname, 'settings.local.json');
function saveSettings(){ try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1)); } catch (e) { addLog('Không lưu được cài đặt: ' + e.message); } }
try { applySettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); scheduleChant(); } catch {}      // no file yet: the defaults stand

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông'];
function setBots(on, n, pace){
  clearInterval(botTimer); botTimer = null;
  if (on && tiktok){ addLog('Không bật bot khi đang nối phòng live thật: người xem thật không được thấy người và quà giả.'); broadcast({ t:'bots', on:false }, 'control'); return; }
  if (on){
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) seat('bot_' + i, DEMO_NAMES[(i + 7) % DEMO_NAMES.length], { demo: true });
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .9) broadcast({ t:'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .985) onGift(id, v.name, 'Hoa hồng', 1 + Math.floor(Math.random() * 3), 1);
      else onGift(id, v.name, 'Đèn hoa sen', 1, 99);
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t:'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t:'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath){
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('error', e => { console.error(`Không mở được server: ${e.message}`); process.exit(1); });     // port taken: stop instead of sitting idle
// A bug in one event must never take the live down: log it and keep going.
process.on('uncaughtException', e => addLog('Lỗi: ' + (e?.message || e)));
process.on('unhandledRejection', e => addLog('Lỗi: ' + (e?.message || e)));
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t:'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => {
  // Only once the port is ours: a second copy started by mistake must not delete the voice lines of the one already live.
  for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
  addLog(`Server chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Overlay: http://localhost:${PORT}/live/overlay.html`);
});
