/* WA Translator & Reply Assistant — service worker */
importScripts('lib/langs.js', 'lib/prompts.js');
const P = self.WATPrompts;
const L = self.WATLangs;

const DEFAULTS = {
  provider: 'anthropic', // anthropic | openai | gemini | proxy
  anthropicKey: '',
  anthropicModel: 'claude-haiku-5-5',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  openaiBase: 'https://api.openai.com/v1',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  proxyUrl: '',
  proxyToken: '',
  agentLang: 'id',
  autoTranslate: true,
  maxAutoPerChat: 20,
  contextMessages: 20,
  businessName: '',
  businessProfile: '',
  formality: 'semi-formal',
  signature: '',
  maskPII: true,
  hotkeys: true,
  pushLayout: true,
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}
function configured(s) {
  return (s.provider === 'anthropic' && s.anthropicKey) || (s.provider === 'openai' && s.openaiKey) ||
    (s.provider === 'gemini' && s.geminiKey) || (s.provider === 'proxy' && s.proxyUrl);
}

chrome.runtime.onInstalled.addListener(async (d) => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULTS });
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab && tab.url && tab.url.startsWith('https://web.whatsapp.com')) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' }); } catch (_) { chrome.tabs.reload(tab.id); }
    return;
  }
  const s = await getSettings();
  if (!configured(s)) { chrome.runtime.openOptionsPage(); return; }
  const [wa] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (wa) {
    await chrome.tabs.update(wa.id, { active: true });
    await chrome.windows.update(wa.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
  }
});

/* ======================= Provider AI ======================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendly(status) {
  if (status === 400) return 'permintaan ditolak (cek nama model/pengaturan)';
  if (status === 401 || status === 403) return 'API key / token tidak valid atau tidak punya akses';
  if (status === 404) return 'endpoint atau model tidak ditemukan';
  if (status === 413) return 'teks terlalu panjang';
  if (status === 429) return 'batas kuota / rate limit tercapai, coba lagi sebentar';
  if (status >= 500) return 'layanan AI sedang bermasalah';
  return 'permintaan gagal';
}

async function httpJSON(url, init, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? `${label}: waktu tunggu habis (60 detik).` : `${label}: tidak dapat terhubung (${e.message}).`);
    err.retry = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* bukan JSON */ }
  if (!res.ok) {
    let apiMsg = data && ((data.error && (data.error.message || data.error)) || data.message);
    if (!apiMsg) apiMsg = text.slice(0, 160);
    if (typeof apiMsg !== 'string') apiMsg = JSON.stringify(apiMsg);
    const err = new Error(`${label} (HTTP ${res.status}): ${friendly(res.status)}${apiMsg ? ' — ' + apiMsg.slice(0, 200) : ''}`);
    err.status = res.status;
    err.retry = res.status === 429 || res.status >= 500;
    throw err;
  }
  if (!data) throw new Error(`${label}: respons bukan JSON.`);
  return data;
}

const PROVIDERS = {
  async anthropic(s, req) {
    if (!s.anthropicKey) throw new Error('API key Anthropic belum diisi di Pengaturan.');
    const d = await httpJSON('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: s.anthropicModel || DEFAULTS.anthropicModel,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
    }, 'Anthropic');
    const text = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, inTok: (d.usage && d.usage.input_tokens) || 0, outTok: (d.usage && d.usage.output_tokens) || 0, truncated: d.stop_reason === 'max_tokens' };
  },

  async openai(s, req) {
    if (!s.openaiKey) throw new Error('API key OpenAI / endpoint kompatibel belum diisi di Pengaturan.');
    const base = (s.openaiBase || DEFAULTS.openaiBase).replace(/\/+$/, '');
    const d = await httpJSON(base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.openaiKey },
      body: JSON.stringify({
        model: s.openaiModel || DEFAULTS.openaiModel,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      }),
    }, 'OpenAI');
    const ch = d.choices && d.choices[0];
    return {
      text: (ch && ch.message && ch.message.content) || '',
      inTok: (d.usage && d.usage.prompt_tokens) || 0,
      outTok: (d.usage && d.usage.completion_tokens) || 0,
      truncated: ch && ch.finish_reason === 'length',
    };
  },

  async gemini(s, req) {
    if (!s.geminiKey) throw new Error('API key Gemini belum diisi di Pengaturan.');
    const model = s.geminiModel || DEFAULTS.geminiModel;
    const d = await httpJSON(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxTokens * 2 + 1024, responseMimeType: 'application/json' },
      }),
    }, 'Gemini');
    const c = d.candidates && d.candidates[0];
    const text = ((c && c.content && c.content.parts) || []).map((p) => p.text || '').join('');
    return {
      text,
      inTok: (d.usageMetadata && d.usageMetadata.promptTokenCount) || 0,
      outTok: (d.usageMetadata && d.usageMetadata.candidatesTokenCount) || 0,
      truncated: c && c.finishReason === 'MAX_TOKENS',
    };
  },

  async proxy(s, req) {
    if (!s.proxyUrl) throw new Error('URL proxy tim belum diisi di Pengaturan.');
    const d = await httpJSON(s.proxyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (s.proxyToken || '') },
      body: JSON.stringify({ system: req.system, user: req.user, maxTokens: req.maxTokens, temperature: req.temperature }),
    }, 'Proxy tim');
    if (d.error) throw new Error('Proxy tim: ' + d.error);
    return { text: d.text || '', inTok: (d.usage && d.usage.input_tokens) || 0, outTok: (d.usage && d.usage.output_tokens) || 0, truncated: !!d.truncated };
  },
};

async function callLLM(s, req) {
  const fn = PROVIDERS[s.provider];
  if (!fn) throw new Error('Provider AI tidak dikenal: ' + s.provider);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fn(s, req);
      recordUsage(r.inTok, r.outTok).catch(() => {});
      return r;
    } catch (e) {
      lastErr = e;
      if (!e.retry || attempt === 2) break;
      await sleep(1500);
    }
  }
  throw lastErr;
}

async function callJSON(s, req) {
  const r = await callLLM(s, req);
  try {
    return P.parseJSON(r.text);
  } catch (e) {
    if (r.truncated) throw new Error('Jawaban AI terpotong (batas token). Coba lagi atau persingkat konteks.');
    throw e;
  }
}

/* ======================= Pemakaian (untuk pantau biaya) ======================= */
async function recordUsage(inTok, outTok) {
  const day = new Date().toISOString().slice(0, 10);
  const { usage = {} } = await chrome.storage.local.get('usage');
  const u = usage[day] || { requests: 0, inTok: 0, outTok: 0 };
  u.requests++; u.inTok += inTok || 0; u.outTok += outTok || 0;
  usage[day] = u;
  const days = Object.keys(usage).sort();
  while (days.length > 31) delete usage[days.shift()];
  await chrome.storage.local.set({ usage });
}

/* ======================= Cache terjemahan ======================= */
let cache = null;
let saveTimer = null;
const CACHE_MAX = 4000;
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + str.length.toString(36);
}
async function loadCache() {
  if (cache) return cache;
  const { trCache } = await chrome.storage.local.get('trCache');
  cache = trCache || {};
  return cache;
}
function scheduleCacheSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a][2] - cache[b][2]).slice(0, keys.length - CACHE_MAX).forEach((k) => delete cache[k]);
    }
    await chrome.storage.local.set({ trCache: cache });
  }, 1500);
}

/* ======================= Handler ======================= */
async function handleTranslateBatch(msg) {
  const s = await getSettings();
  const target = L.norm(msg.target || s.agentLang);
  await loadCache();
  const out = [];
  const miss = [];
  for (const it of msg.items || []) {
    if (!it || typeof it.text !== 'string' || !it.text.trim()) continue;
    const h = fnv(target + '|' + it.text);
    const c = cache[h];
    if (c) { c[2] = Date.now(); out.push({ id: it.id, lang: c[0], translation: c[1], cached: true }); }
    else miss.push({ ...it, h });
  }
  for (let i = 0; i < miss.length; i += 12) {
    const chunk = miss.slice(i, i + 12);
    const masker = P.createMasker(s.maskPII);
    const data = await callJSON(s, P.translateBatch(chunk.map((m, j) => ({ id: String(j), text: masker.mask(m.text) })), target));
    const byId = new Map((Array.isArray(data.items) ? data.items : []).map((x) => [String(x.id), x]));
    chunk.forEach((m, j) => {
      const x = byId.get(String(j));
      if (!x || typeof x.translation !== 'string') return;
      const lang = L.norm(x.lang) || 'und';
      const tr = masker.unmask(x.translation);
      cache[m.h] = [lang, tr, Date.now()];
      out.push({ id: m.id, lang, translation: tr });
    });
  }
  if (miss.length) scheduleCacheSave();
  return { ok: true, items: out };
}

async function handleSuggest(msg) {
  const s = await getSettings();
  const conv = (msg.conversation || []).filter((m) => m && m.text && m.text.trim()).slice(-Math.max(4, s.contextMessages));
  if (!conv.length) throw new Error('Belum ada pesan teks di chat ini untuk dijadikan konteks.');
  const masker = P.createMasker(s.maskPII);
  const req = P.suggestReplies({
    businessName: s.businessName,
    businessProfile: s.businessProfile,
    formality: msg.formality || s.formality,
    signature: s.signature,
    agentLang: s.agentLang,
    customerLang: msg.customerLang && msg.customerLang !== 'auto' ? msg.customerLang : '',
    notes: msg.notes ? masker.mask(msg.notes) : '',
    tones: msg.tones,
    conversation: conv.map((m) => ({ ...m, text: masker.mask(m.text) })),
  });
  const data = masker.unmaskDeep(await callJSON(s, req));
  const replies = {};
  for (const t of ['positive', 'hold', 'decline']) {
    const r = data.replies && data.replies[t];
    if (r && typeof r.text === 'string' && r.text.trim()) replies[t] = { text: r.text.trim(), back_translation: String(r.back_translation || '').trim() };
  }
  if (!Object.keys(replies).length) throw new Error('AI tidak mengembalikan saran jawaban. Coba lagi.');
  return {
    ok: true,
    customer_language: L.norm(data.customer_language) || '',
    summary: String(data.summary || ''),
    intent: String(data.intent || ''),
    sentiment: String(data.sentiment || ''),
    notes_for_agent: String(data.notes_for_agent || ''),
    replies,
  };
}

async function handleTranslateOut(msg) {
  const s = await getSettings();
  if (!msg.text || !msg.text.trim()) throw new Error('Teks kosong.');
  if (!msg.targetLang || msg.targetLang === 'auto') throw new Error('Bahasa pelanggan belum diketahui. Pilih bahasa pelanggan di panel.');
  const masker = P.createMasker(s.maskPII);
  const data = masker.unmaskDeep(await callJSON(s, P.translateOutgoing({
    text: masker.mask(msg.text),
    agentLang: s.agentLang,
    targetLang: msg.targetLang,
    formality: msg.formality || s.formality,
    context: (msg.context || []).map((m) => ({ ...m, text: masker.mask(m.text) })),
  })));
  if (typeof data.translation !== 'string' || !data.translation.trim()) throw new Error('AI tidak mengembalikan terjemahan.');
  return { ok: true, translation: data.translation.trim(), back_translation: String(data.back_translation || '').trim() };
}

async function handlePing(msg) {
  const s = { ...(await getSettings()), ...(msg.settings || {}) };
  const t0 = Date.now();
  const r = await callLLM(s, P.ping());
  return { ok: true, ms: Date.now() - t0, sample: r.text.slice(0, 80) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    translateBatch: handleTranslateBatch,
    suggest: handleSuggest,
    translateOut: handleTranslateOut,
    ping: handlePing,
    getSettings: async () => ({ ok: true, settings: await getSettings() }),
    openOptions: async () => { await chrome.runtime.openOptionsPage(); return { ok: true }; },
    clearCache: async () => { cache = {}; await chrome.storage.local.set({ trCache: {} }); return { ok: true }; },
  };
  const h = handlers[msg && msg.type];
  if (!h) return false;
  h(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
