/* WA Translator & Reply Assistant — content script utama di web.whatsapp.com */
(() => {
  'use strict';
  if (window.__WAT_LOADED) return;
  window.__WAT_LOADED = true;

  const D = globalThis.WADOM;
  const LANGS = globalThis.WATLangs;
  const TONES = {
    positive: { label: 'Positif', sub: 'Mendukung & melanjutkan percakapan', color: '#16a34a' },
    hold: { label: 'Tahan', sub: 'Menahan, dibahas dulu dengan tim terkait', color: '#d97706' },
    decline: { label: 'Tolak', sub: 'Menolak dengan baik & profesional', color: '#dc2626' },
  };
  const PLACEHOLDER_RE = /\[(?!\[)[^\]\n]{2,80}\]/g;

  let settings = null;
  let chatKey = null;
  let chatTitle = '';
  let chatPrefs = {};
  const results = new Map(); // teks asli -> { lang, translation }
  const pending = new Set();
  const failedAt = new Map();
  const suggestionsByChat = new Map();
  let translating = false;
  let lastError = '';
  let ui = null;

  /* ---------------- util ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function alive() {
    try { return !!chrome.runtime.id; } catch (_) { return false; }
  }
  async function send(type, payload = {}) {
    if (!alive()) throw new Error('Extension diperbarui. Muat ulang halaman WhatsApp (F5).');
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r) throw new Error('Tidak ada respons dari extension.');
    if (r.ok === false) throw new Error(r.error || 'Gagal');
    return r;
  }
  async function loadSettings() {
    const r = await send('getSettings');
    settings = r.settings;
  }
  async function loadPrefs() {
    const { chatPrefs: p } = await chrome.storage.local.get('chatPrefs');
    chatPrefs = p || {};
  }
  async function savePref(patch) {
    if (!chatKey) return;
    chatPrefs[chatKey] = { ...(chatPrefs[chatKey] || {}), ...patch, t: Date.now() };
    const keys = Object.keys(chatPrefs);
    if (keys.length > 800) keys.sort((a, b) => (chatPrefs[a].t || 0) - (chatPrefs[b].t || 0)).slice(0, keys.length - 800).forEach((k) => delete chatPrefs[k]);
    await chrome.storage.local.set({ chatPrefs });
  }
  const agentLang = () => LANGS.norm((settings && settings.agentLang) || 'id');
  const pref = () => (chatKey && chatPrefs[chatKey]) || {};
  const autoOn = () => settings && settings.autoTranslate && pref().auto !== false;

  function translatable(text) {
    const t = text.replace(/https?:\/\/\S+/g, '').replace(/[\d\s\p{P}\p{S}]/gu, '');
    return t.length >= 2;
  }

  /* ---------------- bahasa pelanggan ---------------- */
  function detectedLang() {
    const counts = {};
    for (const m of D.messages()) {
      if (m.dir !== 'in') continue;
      const r = results.get(m.text);
      if (!r || !r.lang || r.lang === 'und') continue;
      counts[r.lang] = (counts[r.lang] || 0) + m.text.length;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : (pref().detected || '');
  }
  function customerLang() {
    const p = pref();
    if (p.lang && p.lang !== 'auto') return p.lang;
    return detectedLang();
  }

  /* ---------------- terjemahan inline ---------------- */
  function renderInline(m) {
    const next = m.el.nextElementSibling;
    const existing = next && next.classList && next.classList.contains('wat-tr') ? next : null;
    const r = autoOn() ? results.get(m.text) : null;
    const show = r && r.lang !== agentLang() && r.lang !== 'und' && squash(r.translation).toLowerCase() !== squash(m.text).toLowerCase();
    if (!show) { if (existing) existing.remove(); return; }
    if (existing && existing.dataset.src === m.text) return;
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'wat-tr';
    div.dataset.src = m.text;
    const badge = document.createElement('span');
    badge.className = 'wat-badge';
    badge.textContent = `${r.lang} → ${agentLang()}`;
    const body = document.createElement('span');
    body.className = 'wat-text';
    body.textContent = r.translation;
    div.append(badge, body);
    m.el.insertAdjacentElement('afterend', div);
  }

  async function translatePending(msgs) {
    if (translating || !autoOn()) return;
    const now = Date.now();
    const need = [];
    const seen = new Set();
    for (const m of msgs.filter((x) => x.dir === 'in').slice(-settings.maxAutoPerChat)) {
      if (seen.has(m.text) || results.has(m.text) || pending.has(m.text) || !translatable(m.text)) continue;
      if (failedAt.has(m.text) && now - failedAt.get(m.text) < 60000) continue;
      seen.add(m.text);
      need.push(m.text);
    }
    if (!need.length) return;
    translating = true;
    need.forEach((t) => pending.add(t));
    setStatus(`Menerjemahkan ${need.length} pesan…`);
    try {
      const r = await send('translateBatch', { target: agentLang(), items: need.map((text, i) => ({ id: String(i), text })) });
      for (const it of r.items) results.set(need[+it.id], { lang: it.lang, translation: it.translation });
      need.forEach((t) => { if (!results.has(t)) failedAt.set(t, Date.now()); });
      lastError = '';
      setStatus('');
      const d = detectedLang();
      if (d && d !== pref().detected) await savePref({ detected: d });
    } catch (e) {
      need.forEach((t) => failedAt.set(t, Date.now()));
      lastError = e.message;
      setStatus('Terjemahan gagal: ' + e.message, 'bad');
    } finally {
      need.forEach((t) => pending.delete(t));
      translating = false;
      schedule(50);
    }
  }

  /* ---------------- pemindaian ---------------- */
  let scanTimer = null;
  function schedule(ms = 350) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scan().catch((e) => console.warn('[WAT]', e)); }, ms);
  }
  async function scan() {
    if (!settings || !alive()) return;
    const info = D.chatInfo();
    const key = info ? info.key : null;
    if (key !== chatKey) {
      chatKey = key;
      chatTitle = info ? info.title : '';
      onChatChanged();
    }
    if (!key) return;
    const msgs = D.messages();
    for (const m of msgs) if (m.dir === 'in') renderInline(m);
    updateLangUI();
    await translatePending(msgs);
  }

  function onChatChanged() {
    if (!ui) return;
    ui.chat.textContent = chatTitle || 'Belum ada chat yang dibuka';
    ui.auto.checked = !!(settings && settings.autoTranslate) && pref().auto !== false;
    ui.auto.disabled = !(settings && settings.autoTranslate);
    ui.lang.value = pref().lang || 'auto';
    renderSuggestions(suggestionsByChat.get(chatKey) || null);
    ui.draftOut.textContent = '';
    updateLangUI();
  }

  /* ---------------- konteks percakapan ---------------- */
  function conversation(limit) {
    return D.messages().slice(-(limit || settings.contextMessages)).map((m) => ({
      role: m.dir === 'in' ? 'customer' : 'agent',
      text: m.text,
      time: m.time,
    }));
  }

  /* ---------------- aksi ---------------- */
  async function generate(tones) {
    if (!chatKey) { toast('Buka sebuah chat terlebih dahulu.', 'bad'); return; }
    const conv = conversation();
    if (!conv.length) { toast('Belum ada pesan teks di chat ini.', 'bad'); return; }
    const all = !tones || tones.length === 3;
    const key = chatKey;
    setBusy(true, all ? 'Menyusun 3 saran jawaban…' : `Menyusun ulang jawaban ${TONES[tones[0]].label}…`);
    try {
      const r = await send('suggest', {
        conversation: conv,
        customerLang: customerLang(),
        notes: ui.notes.value.trim(),
        tones: tones || ['positive', 'hold', 'decline'],
      });
      if (r.customer_language && !customerLang()) await savePref({ detected: r.customer_language });
      const prev = suggestionsByChat.get(key);
      const merged = all || !prev ? r : { ...prev, replies: { ...prev.replies, ...r.replies } };
      suggestionsByChat.set(key, merged);
      if (key === chatKey) renderSuggestions(merged);
      updateLangUI();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function insertText(text) {
    const ph = text.match(PLACEHOLDER_RE);
    try {
      const how = await D.insert(text, 'replace');
      if (how === 'clipboard') toast('Tidak bisa menyisipkan otomatis. Teks sudah disalin — tekan Ctrl+V di kolom ketik.', 'warn');
      else if (ph) toast(`Sudah disisipkan. Lengkapi dulu ${ph.join(', ')} sebelum mengirim.`, 'warn');
      else toast('Sudah disisipkan ke kolom ketik. Periksa, lalu tekan Enter untuk mengirim.', 'ok');
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  async function translateDraft() {
    const text = ui.draft.value.trim();
    if (!text) { toast('Tulis draf terlebih dahulu.', 'bad'); return; }
    const target = customerLang();
    if (!target) { toast('Bahasa pelanggan belum diketahui. Pilih di bagian atas panel.', 'bad'); return; }
    setBusy(true, 'Menerjemahkan draf…');
    try {
      const r = await send('translateOut', { text, targetLang: target, context: conversation(6) });
      renderDraftOut(r, target);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function translateComposer() {
    const text = D.composerText();
    if (!text) { toast('Kolom ketik kosong. Tulis pesan dalam Bahasa ' + LANGS.label(agentLang()) + ' lalu tekan Alt+T.', 'warn'); return; }
    const target = customerLang();
    if (!target) { toast('Bahasa pelanggan belum diketahui. Pilih di panel (Alt+Q).', 'bad'); openPanel(true); return; }
    if (target === agentLang()) { toast('Pelanggan memakai bahasa yang sama, tidak perlu diterjemahkan.', 'warn'); return; }
    setStatus('Menerjemahkan isi kolom ketik…');
    try {
      const r = await send('translateOut', { text, targetLang: target, context: conversation(6) });
      const how = await D.insert(r.translation, 'replace');
      if (how === 'clipboard') toast('Terjemahan disalin — tekan Ctrl+V untuk menempel.', 'warn');
      else toast('Arti: ' + (r.back_translation || '-'), 'ok', 9000);
      setStatus('');
    } catch (e) {
      setStatus('');
      toast(e.message, 'bad');
    }
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(() => toast('Disalin.', 'ok'), () => toast('Gagal menyalin.', 'bad'));
  }

  /* ---------------- UI (shadow DOM) ---------------- */
  const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.fab{position:fixed;right:14px;bottom:86px;z-index:2147483000;width:44px;height:44px;border-radius:50%;border:0;background:#0f766e;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.fab:hover{background:#115e59}
.panel{position:fixed;top:0;right:0;z-index:2147483001;width:372px;max-width:100vw;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border-left:1px solid var(--line);box-shadow:-6px 0 20px rgba(0,0,0,.15);font-size:13px;line-height:1.45}
.panel.hidden{display:none}
.panel{--bg:#ffffff;--fg:#111b21;--muted:#667781;--line:#e9edef;--card:#f7f8fa;--accent:#0f766e;--accentfg:#fff}
@media (prefers-color-scheme:dark){.panel{--bg:#111b21;--fg:#e9edef;--muted:#8696a0;--line:#2a3942;--card:#1f2c34;--accent:#14b8a6;--accentfg:#062925}}
.panel.light{--bg:#ffffff;--fg:#111b21;--muted:#667781;--line:#e9edef;--card:#f7f8fa;--accent:#0f766e;--accentfg:#fff}
.panel.dark{--bg:#111b21;--fg:#e9edef;--muted:#8696a0;--line:#2a3942;--card:#1f2c34;--accent:#14b8a6;--accentfg:#062925}
header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
header .t{flex:1;min-width:0}
header b{display:block;font-size:14px}
header .chat{display:block;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x{border:0;background:transparent;color:var(--muted);font-size:20px;cursor:pointer;padding:2px 6px}
.body{flex:1;overflow:auto;padding:12px 14px 20px}
.row{display:flex;align-items:center;gap:8px;margin:0 0 8px}
label.lbl{font-size:12px;color:var(--muted)}
select,textarea{width:100%;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 9px}
select{width:auto;flex:1}
textarea{resize:vertical;min-height:54px}
.det{font-size:12px;color:var(--muted);margin:-4px 0 10px}
.chk{display:flex;gap:8px;align-items:center;font-size:12px;margin:0 0 12px;color:var(--fg)}
h3{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:6px 10px}
button:hover:not(:disabled){border-color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accentfg);font-weight:600}
.tones{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:6px;margin:8px 0}
.tones button{padding:6px 4px;font-size:12px}
.sum{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin:8px 0;font-size:12px}
.sum .k{color:var(--muted)}
.sum .warn{color:#b45309;margin-top:4px}
.card{border:1px solid var(--line);border-left:4px solid var(--c);border-radius:10px;padding:9px 10px;margin:8px 0;background:var(--bg)}
.card .hd{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}
.card .hd b{color:var(--c)}
.card .hd span{color:var(--muted);font-size:11px}
.card textarea{min-height:76px}
.card .bt{font-size:12px;color:var(--muted);margin:6px 0;white-space:pre-wrap}
.card .ph{font-size:11px;color:#b45309;margin:4px 0}
.card .act{display:flex;gap:6px}
.card .act button{font-size:12px;padding:5px 9px}
.card .act .ins{background:var(--accent);border-color:var(--accent);color:var(--accentfg)}
.out{margin-top:8px}
.foot{border-top:1px solid var(--line);padding:8px 14px;font-size:11px;color:var(--muted)}
.foot a{color:var(--accent);cursor:pointer;text-decoration:none}
.status{font-size:12px;color:var(--muted);min-height:16px;margin-top:4px}
.status.bad{color:#dc2626}
.busy{display:none;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin:6px 0}
.busy.on{display:flex}
.spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
.toast{position:fixed;right:16px;bottom:16px;z-index:2147483002;max-width:360px;padding:10px 12px;border-radius:10px;background:#111827;color:#fff;font-size:13px;line-height:1.4;box-shadow:0 6px 20px rgba(0,0,0,.3);opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none;white-space:pre-wrap}
.toast.on{opacity:1;transform:none}
.toast.ok{background:#065f46}.toast.bad{background:#991b1b}.toast.warn{background:#92400e}
.empty{color:var(--muted);font-size:12px;padding:6px 0}
`;

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids) if (c) n.append(c);
    return n;
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'wat-root';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const langSel = el('select', { title: 'Bahasa pelanggan untuk chat ini' });
    langSel.append(el('option', { value: 'auto', text: 'Deteksi otomatis' }));
    for (const [code, label] of LANGS.LIST) langSel.append(el('option', { value: code, text: label }));

    const auto = el('input', { type: 'checkbox' });
    const notes = el('textarea', { placeholder: 'Arahan untuk AI (opsional). Contoh: tawarkan demo hari Kamis; harga paket Pro Rp499rb/bulan' });
    notes.style.minHeight = '44px';
    const draft = el('textarea', { placeholder: 'Tulis balasan dalam Bahasa Indonesia, lalu klik Terjemahkan…' });
    const panel = el('aside', { class: 'panel hidden' });
    const ui0 = {
      host, root, panel, lang: langSel, auto, notes, draft,
      chat: el('span', { class: 'chat' }),
      det: el('div', { class: 'det' }),
      sum: el('div'),
      cards: el('div'),
      draftOut: el('div', { class: 'out' }),
      status: el('div', { class: 'status' }),
      busy: el('div', { class: 'busy' }, el('div', { class: 'spin' }), el('span')),
      toast: el('div', { class: 'toast' }),
      buttons: [],
    };
    const tb = (label, tones, cls) => {
      const b = el('button', { class: cls || '', text: label, onclick: () => generate(tones) });
      ui0.buttons.push(b);
      return b;
    };
    const trBtn = el('button', { class: 'primary', text: 'Terjemahkan', onclick: translateDraft });
    ui0.buttons.push(trBtn);

    panel.append(
      el('header', {},
        el('div', { class: 't' }, el('b', { text: 'Asisten Terjemah & Balasan' }), ui0.chat),
        el('button', { class: 'x', title: 'Tutup (Alt+Q)', text: '×', onclick: () => openPanel(false) })),
      el('div', { class: 'body' },
        el('div', { class: 'row' }, el('label', { class: 'lbl', text: 'Bahasa pelanggan' }), langSel),
        ui0.det,
        el('label', { class: 'chk' }, auto, el('span', { text: 'Terjemahkan pesan masuk otomatis di chat ini' })),
        el('h3', { text: 'Saran balasan' }),
        notes,
        el('div', { class: 'tones' },
          tb('Buat 3 saran', null, 'primary'),
          tb('Positif', ['positive']),
          tb('Tahan', ['hold']),
          tb('Tolak', ['decline'])),
        ui0.busy,
        ui0.sum,
        ui0.cards,
        el('h3', { text: 'Tulis sendiri → terjemahkan' }),
        draft,
        el('div', { class: 'row', style: 'margin-top:6px' }, trBtn),
        ui0.draftOut,
        ui0.status),
      el('div', { class: 'foot' },
        el('span', { text: 'Alt+T terjemahkan kolom ketik · Alt+R buat saran · Alt+Q panel · ' }),
        el('a', { text: 'Pengaturan', onclick: () => send('openOptions').catch((e) => toast(e.message, 'bad')) }),
        el('span', { text: ' · ' }),
        el('a', { text: 'Diagnosa', onclick: showDiagnostics })),
    );
    const fab = el('button', { class: 'fab', title: 'Asisten Terjemah (Alt+Q)', text: '🌐', onclick: () => openPanel() });
    root.append(style, fab, panel, ui0.toast);

    langSel.addEventListener('change', async () => {
      await savePref({ lang: langSel.value });
      updateLangUI();
    });
    auto.addEventListener('change', async () => {
      await savePref({ auto: auto.checked });
      schedule(10);
    });
    draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); translateDraft(); }
      e.stopPropagation();
    });
    notes.addEventListener('keydown', (e) => e.stopPropagation());
    // Jangan biarkan WhatsApp menangkap ketikan di panel
    for (const t of ['keypress', 'keyup', 'input', 'paste']) panel.addEventListener(t, (e) => e.stopPropagation());
    return ui0;
  }

  function themeSync() {
    if (!ui) return;
    const dark = document.body.classList.contains('dark') || document.documentElement.classList.contains('dark');
    const light = document.body.classList.contains('light');
    ui.panel.classList.toggle('dark', dark);
    ui.panel.classList.toggle('light', light && !dark);
  }

  async function openPanel(force) {
    if (!ui) return;
    const show = typeof force === 'boolean' ? force : ui.panel.classList.contains('hidden');
    ui.panel.classList.toggle('hidden', !show);
    // Geser tampilan WhatsApp agar tombol kirim & isi chat tidak tertutup panel
    document.documentElement.classList.toggle('wat-open', show && settings && settings.pushLayout !== false);
    themeSync();
    try { await chrome.storage.local.set({ panelOpen: show }); } catch (_) { /* abaikan */ }
  }

  function updateLangUI() {
    if (!ui) return;
    const p = pref();
    const d = detectedLang();
    const cl = customerLang();
    let t;
    if (!chatKey) t = '';
    else if (p.lang && p.lang !== 'auto') t = `Dipilih manual: ${LANGS.label(p.lang)}${d && d !== p.lang ? ` (terdeteksi: ${LANGS.label(d)})` : ''}`;
    else if (d) t = `Terdeteksi: ${LANGS.label(d)}`;
    else t = 'Belum terdeteksi — akan terdeteksi dari pesan pelanggan.';
    if (cl && cl === agentLang()) t += ' · sama dengan bahasa Anda';
    ui.det.textContent = t;
    if (document.activeElement !== ui.host) ui.lang.value = p.lang || 'auto';
  }

  function setBusy(on, text) {
    if (!ui) return;
    ui.busy.classList.toggle('on', !!on);
    ui.busy.lastChild.textContent = text || '';
    ui.buttons.forEach((b) => { b.disabled = !!on; });
  }
  function setStatus(text, kind) {
    if (!ui) return;
    ui.status.textContent = text || '';
    ui.status.className = 'status ' + (kind || '');
  }
  let toastTimer = null;
  function toast(text, kind = '', ms = 5000) {
    if (!ui) { console.log('[WAT]', text); return; }
    ui.toast.textContent = text;
    ui.toast.className = 'toast on ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.className = 'toast ' + kind; }, ms);
  }

  function renderSuggestions(data) {
    ui.sum.textContent = '';
    ui.cards.textContent = '';
    if (!data) {
      ui.cards.append(el('div', { class: 'empty', text: 'Klik "Buat 3 saran" untuk jawaban Positif, Tahan, dan Tolak berdasarkan percakapan ini.' }));
      return;
    }
    const sum = el('div', { class: 'sum' });
    if (data.intent || data.summary) {
      sum.append(el('div', {}, el('span', { class: 'k', text: 'Maksud pelanggan: ' }), document.createTextNode(data.intent || '-')));
      if (data.summary) sum.append(el('div', { text: data.summary }));
      if (data.sentiment) sum.append(el('div', {}, el('span', { class: 'k', text: 'Sentimen: ' }), document.createTextNode({ positive: 'positif', neutral: 'netral', negative: 'negatif' }[data.sentiment] || data.sentiment)));
    }
    if (data.notes_for_agent) sum.append(el('div', { class: 'warn', text: '⚠ ' + data.notes_for_agent }));
    if (sum.childNodes.length) ui.sum.append(sum);

    for (const tone of ['positive', 'hold', 'decline']) {
      const r = data.replies && data.replies[tone];
      if (!r) continue;
      const meta = TONES[tone];
      const ta = el('textarea');
      ta.value = r.text;
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      const ph = el('div', { class: 'ph' });
      const updPh = () => {
        const m = ta.value.match(PLACEHOLDER_RE);
        ph.textContent = m ? `Isi dulu: ${m.join(', ')}` : '';
        ph.style.display = m ? '' : 'none';
      };
      ta.addEventListener('input', () => { updPh(); autoGrow(ta); });
      updPh();
      const regen = el('button', { text: 'Ulangi', title: 'Buat ulang jawaban ini', onclick: () => generate([tone]) });
      ui.buttons.push(regen);
      const card = el('div', { class: 'card', 'data-tone': tone },
        el('div', { class: 'hd' }, el('b', { text: meta.label }), el('span', { text: meta.sub })),
        ta,
        ph,
        r.back_translation ? el('div', { class: 'bt', text: 'Arti: ' + r.back_translation }) : null,
        el('div', { class: 'act' },
          el('button', { class: 'ins', text: 'Sisipkan', title: 'Masukkan ke kolom ketik WhatsApp (tidak langsung terkirim)', onclick: () => insertText(ta.value) }),
          el('button', { text: 'Salin', onclick: () => copy(ta.value) }),
          regen));
      card.style.setProperty('--c', meta.color);
      ui.cards.append(card);
    }
    growAll(ui.cards);
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(260, Math.max(60, ta.scrollHeight + 2)) + 'px';
  }
  function growAll(scope) {
    requestAnimationFrame(() => scope.querySelectorAll('textarea').forEach(autoGrow));
  }

  function renderDraftOut(r, target) {
    ui.draftOut.textContent = '';
    const ta = el('textarea');
    ta.value = r.translation;
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    const card = el('div', { class: 'card' },
      el('div', { class: 'hd' }, el('b', { text: LANGS.label(target) }), el('span', { text: 'hasil terjemahan' })),
      ta,
      r.back_translation ? el('div', { class: 'bt', text: 'Arti: ' + r.back_translation }) : null,
      el('div', { class: 'act' },
        el('button', { class: 'ins', text: 'Sisipkan', onclick: () => insertText(ta.value) }),
        el('button', { text: 'Salin', onclick: () => copy(ta.value) })));
    card.style.setProperty('--c', '#0f766e');
    ui.draftOut.append(card);
    ta.addEventListener('input', () => autoGrow(ta));
    growAll(ui.draftOut);
  }

  function showDiagnostics() {
    const d = D.diagnostics();
    const lines = [
      `Panel chat: ${d.main ? 'ditemukan' : 'TIDAK ditemukan'}`,
      `Chat: ${d.chat ? d.chat.title : '-'}`,
      `Pesan terbaca: ${d.messages} (masuk ${d.incoming}, keluar ${d.outgoing}, ber-id ${d.withDataId})`,
      `Kolom ketik: ${d.composer ? 'ditemukan' : 'TIDAK ditemukan'}`,
      `Terjemahan tersimpan: ${results.size}`,
      `Provider: ${settings ? settings.provider : '-'}`,
      lastError ? `Error terakhir: ${lastError}` : '',
    ].filter(Boolean).join('\n');
    toast(lines, d.main && d.composer && d.messages ? 'ok' : 'warn', 12000);
    console.log('[WAT] diagnostics', d);
  }

  /* ---------------- shortcut ---------------- */
  document.addEventListener('keydown', (e) => {
    if (!settings || !settings.hotkeys || !e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyT') { e.preventDefault(); e.stopPropagation(); translateComposer(); }
    else if (e.code === 'KeyR') { e.preventDefault(); e.stopPropagation(); openPanel(true); generate(null); }
    else if (e.code === 'KeyQ') { e.preventDefault(); e.stopPropagation(); openPanel(); }
  }, true);

  /* ---------------- start ---------------- */
  async function start() {
    await loadSettings();
    await loadPrefs();
    ui = buildUI();
    const { panelOpen } = await chrome.storage.local.get('panelOpen');
    if (panelOpen) openPanel(true);
    onChatChanged();
    renderSuggestions(null);
    new MutationObserver(() => schedule()).observe(document.body, { childList: true, subtree: true });
    new MutationObserver(themeSync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    themeSync();
    schedule(100);

    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.settings) {
        const before = agentLang();
        settings = { ...settings, ...ch.settings.newValue };
        if (agentLang() !== before) { results.clear(); document.querySelectorAll('.wat-tr').forEach((n) => n.remove()); }
        onChatChanged();
        schedule(10);
      }
    });
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg && msg.type === 'togglePanel') { openPanel(); reply({ ok: true }); }
      return false;
    });
    globalThis.__WAT = { results, generate, translateComposer, translateDraft, openPanel, ui: () => ui, customerLang, scan };
  }

  start().catch((e) => console.error('[WAT] gagal mulai', e));
})();
