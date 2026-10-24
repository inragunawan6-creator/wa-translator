const $ = (id) => document.getElementById(id);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const FIELDS = ['anthropicKey', 'anthropicModel', 'openaiKey', 'openaiModel', 'openaiBase', 'geminiKey', 'geminiModel',
  'proxyUrl', 'proxyToken', 'agentLang', 'formality', 'maxAutoPerChat', 'contextMessages', 'businessName',
  'businessProfile', 'signature'];
const CHECKS = ['autoTranslate', 'hotkeys', 'maskPII', 'pushLayout'];
const SECRET = ['anthropicKey', 'openaiKey', 'geminiKey', 'proxyToken'];
const BUILTIN = ['https://api.anthropic.com', 'https://api.openai.com', 'https://generativelanguage.googleapis.com'];

const TEMPLATE = `Tentang kami:
- [Nama bisnis] adalah [jelaskan singkat: platform / layanan apa, untuk siapa].
- Wilayah layanan: [kota/negara].
- Jam operasional CS: Senin–Jumat 09.00–18.00 WIB.

Produk / paket:
- [Nama paket A]: [isi & harga]
- [Nama paket B]: [isi & harga]

Kebijakan:
- Pembayaran: [metode].
- Refund / pembatalan: [aturan].
- Hal yang TIDAK kami layani: [contoh].

Alur eskalasi (untuk jawaban "Tahan"):
- Pertanyaan kerja sama / partnership → tim bisnis, respons maks. 2 hari kerja.
- Masalah teknis / akun → tim teknis, respons maks. 1 hari kerja.

Gaya komunikasi:
- Sapa pelanggan dengan nama jika diketahui; jangan menjanjikan diskon tanpa persetujuan.`;

function msg(el, text, kind = '') { el.textContent = text; el.className = 'msg ' + kind; }

function fillLangs() {
  const sel = $('agentLang');
  for (const [code, label] of WATLangs.LIST) {
    const o = document.createElement('option');
    o.value = code; o.textContent = label;
    sel.append(o);
  }
}

function showProvider(p) {
  document.querySelectorAll('.pv').forEach((d) => d.classList.toggle('on', d.dataset.pv === p));
}

function readForm() {
  const s = {};
  for (const f of FIELDS) s[f] = $(f).value.trim();
  for (const c of CHECKS) s[c] = $(c).checked;
  s.provider = (document.querySelector('input[name=provider]:checked') || {}).value || 'anthropic';
  s.maxAutoPerChat = Math.max(5, Math.min(60, parseInt(s.maxAutoPerChat, 10) || 20));
  s.contextMessages = Math.max(4, Math.min(60, parseInt(s.contextMessages, 10) || 20));
  s.businessProfile = $('businessProfile').value; // simpan apa adanya
  return s;
}

function writeForm(s) {
  for (const f of FIELDS) if (s[f] !== undefined) $(f).value = s[f];
  for (const c of CHECKS) if (s[c] !== undefined) $(c).checked = !!s[c];
  const r = document.querySelector(`input[name=provider][value="${s.provider}"]`);
  if (r) r.checked = true;
  showProvider(s.provider);
}

/** Origin tambahan (base URL kustom / proxy) perlu izin host opsional */
function extraOrigin(s) {
  let url = '';
  if (s.provider === 'openai') url = s.openaiBase;
  if (s.provider === 'proxy') url = s.proxyUrl;
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('URL harus memakai https://');
    if (BUILTIN.includes(u.origin)) return null;
    return u.origin + '/*';
  } catch (e) {
    throw new Error('URL tidak valid: ' + url);
  }
}

async function ensurePermission(s) {
  const origin = extraOrigin(s);
  if (!origin) return true;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function renderUsage() {
  const { usage = {} } = await chrome.storage.local.get('usage');
  const tb = document.querySelector('#usage tbody');
  tb.textContent = '';
  const days = Object.keys(usage).sort().reverse().slice(0, 7);
  if (!days.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 4; td.textContent = 'Belum ada pemakaian.';
    tr.append(td); tb.append(tr);
    return;
  }
  for (const d of days) {
    const u = usage[d];
    const tr = document.createElement('tr');
    [d, u.requests, u.inTok.toLocaleString('id-ID'), u.outTok.toLocaleString('id-ID')].forEach((v) => {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    });
    tb.append(tr);
  }
}

async function load() {
  fillLangs();
  const r = await send('getSettings');
  writeForm(r.settings);
  renderUsage();
}

document.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', () => showProvider(r.value)));

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  let s;
  try { s = readForm(); extraOrigin(s); } catch (err) { msg($('msg'), err.message, 'bad'); return; }
  // Permintaan izin harus langsung di dalam gesture klik
  ensurePermission(s).then(async (granted) => {
    if (!granted) { msg($('msg'), 'Izin akses ke URL tersebut ditolak, pengaturan tidak disimpan.', 'bad'); return; }
    const { settings: old } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(old || {}), ...s } });
    msg($('msg'), 'Tersimpan. Panel di WhatsApp Web langsung memakai pengaturan baru.', 'ok');
  }).catch((err) => msg($('msg'), err.message, 'bad'));
});

$('test').addEventListener('click', () => {
  let s;
  try { s = readForm(); extraOrigin(s); } catch (err) { msg($('testMsg'), err.message, 'bad'); return; }
  msg($('testMsg'), 'Menghubungi layanan AI…');
  ensurePermission(s).then(async (granted) => {
    if (!granted) throw new Error('Izin akses URL ditolak.');
    const r = await send('ping', { settings: s });
    if (r && r.ok) msg($('testMsg'), `Terhubung (${r.ms} ms).`, 'ok');
    else throw new Error((r && r.error) || 'Gagal');
  }).catch((err) => msg($('testMsg'), err.message, 'bad'));
});

$('template').addEventListener('click', () => {
  const ta = $('businessProfile');
  if (ta.value.trim() && !confirm('Ganti isi profil bisnis dengan templat?')) return;
  ta.value = TEMPLATE;
});

$('clearCache').addEventListener('click', async () => {
  await send('clearCache');
  msg($('msg'), 'Cache terjemahan dihapus.', 'ok');
});

$('export').addEventListener('click', () => {
  const s = readForm();
  if (!$('exportKeys').checked) for (const k of SECRET) delete s[k];
  const blob = new Blob([JSON.stringify({ app: 'wa-translator', version: 1, settings: s }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wa-translator-pengaturan.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || data.app !== 'wa-translator' || typeof data.settings !== 'object') throw new Error('Bukan file pengaturan WA Translator.');
    const allowed = new Set([...FIELDS, ...CHECKS, 'provider']);
    const clean = {};
    for (const [k, v] of Object.entries(data.settings)) if (allowed.has(k)) clean[k] = v;
    writeForm({ ...readForm(), ...clean });
    msg($('msg'), 'Pengaturan diimpor. Periksa lalu klik Simpan.', 'ok');
  } catch (err) {
    msg($('msg'), 'Gagal impor: ' + err.message, 'bad');
  } finally {
    e.target.value = '';
  }
});

load();
