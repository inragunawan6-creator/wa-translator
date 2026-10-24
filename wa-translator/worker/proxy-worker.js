/**
 * Proxy tim untuk WA Translator — Cloudflare Worker.
 * API key Anthropic hanya tersimpan di sini (secret), agen memakai token tim.
 *
 * Variabel lingkungan (Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY  (secret)  API key Anthropic
 *   TEAM_TOKENS        (secret)  daftar token tim dipisah koma, mis. "cs-ani-8f2…,cs-budi-91c…"
 *   MODEL              (opsional) default "claude-haiku-5-5"
 *   MAX_TOKENS_LIMIT   (opsional) default 2500
 */
const MAX_INPUT_CHARS = 60000;

function cors(origin) {
  const ok = origin && origin.startsWith('chrome-extension://');
  return {
    'access-control-allow-origin': ok ? origin : 'null',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(origin) } });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ error: 'Gunakan POST.' }, 405, origin);

    const tokens = String(env.TEAM_TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean);
    const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!tokens.length || !auth || !tokens.some((t) => timingSafeEqual(t, auth))) return json({ error: 'Token tim tidak valid.' }, 401, origin);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY belum diset di Worker.' }, 500, origin);

    let body;
    try { body = await request.json(); } catch (_) { return json({ error: 'Body bukan JSON.' }, 400, origin); }
    const system = typeof body.system === 'string' ? body.system : '';
    const user = typeof body.user === 'string' ? body.user : '';
    if (!user) return json({ error: 'Field "user" wajib diisi.' }, 400, origin);
    if (system.length + user.length > MAX_INPUT_CHARS) return json({ error: 'Teks terlalu panjang.' }, 413, origin);
    const limit = Number(env.MAX_TOKENS_LIMIT) || 2500;
    const maxTokens = Math.max(16, Math.min(limit, Number(body.maxTokens) || 1000));
    const temperature = Math.max(0, Math.min(1, Number(body.temperature ?? 0.3)));

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.MODEL || 'claude-haiku-5-5', max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] }),
      });
    } catch (e) {
      return json({ error: 'Tidak dapat menghubungi Anthropic: ' + e.message }, 502, origin);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      const m = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      return json({ error: 'Anthropic: ' + m }, res.status === 429 ? 429 : 502, origin);
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return json({ text, usage: data.usage || {}, truncated: data.stop_reason === 'max_tokens' }, 200, origin);
  },
};
