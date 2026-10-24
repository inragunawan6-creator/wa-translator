/* Daftar bahasa (dipakai background, content script, dan halaman pengaturan) */
(function (root) {
  'use strict';
  // [kode ISO 639-1, label Indonesia, nama Inggris untuk prompt]
  const LIST = [
    ['id', 'Indonesia', 'Indonesian'],
    ['en', 'Inggris (English)', 'English'],
    ['ms', 'Melayu (Malay)', 'Malay'],
    ['jv', 'Jawa', 'Javanese'],
    ['su', 'Sunda', 'Sundanese'],
    ['es', 'Spanyol (Español)', 'Spanish'],
    ['pt', 'Portugis (Português)', 'Portuguese'],
    ['fr', 'Prancis (Français)', 'French'],
    ['de', 'Jerman (Deutsch)', 'German'],
    ['it', 'Italia (Italiano)', 'Italian'],
    ['nl', 'Belanda (Nederlands)', 'Dutch'],
    ['ar', 'Arab (العربية)', 'Arabic'],
    ['tr', 'Turki (Türkçe)', 'Turkish'],
    ['ru', 'Rusia (Русский)', 'Russian'],
    ['hi', 'Hindi (हिन्दी)', 'Hindi'],
    ['bn', 'Bengali (বাংলা)', 'Bengali'],
    ['ur', 'Urdu (اردو)', 'Urdu'],
    ['zh', 'Mandarin (中文)', 'Chinese (Simplified)'],
    ['ja', 'Jepang (日本語)', 'Japanese'],
    ['ko', 'Korea (한국어)', 'Korean'],
    ['th', 'Thai (ไทย)', 'Thai'],
    ['vi', 'Vietnam (Tiếng Việt)', 'Vietnamese'],
    ['tl', 'Tagalog/Filipino', 'Filipino (Tagalog)'],
    ['km', 'Khmer', 'Khmer'],
    ['my', 'Burma', 'Burmese'],
    ['sw', 'Swahili', 'Swahili'],
    ['zu', 'Zulu', 'Zulu'],
    ['af', 'Afrikaans', 'Afrikaans'],
  ];
  const byCode = new Map(LIST.map((l) => [l[0], l]));

  function norm(code) {
    if (!code) return '';
    const c = String(code).trim().toLowerCase().replace('_', '-');
    if (c === 'fil') return 'tl';
    if (c.startsWith('zh')) return 'zh';
    return c.split('-')[0];
  }
  function label(code) {
    const l = byCode.get(norm(code));
    return l ? l[1] : (code ? String(code).toUpperCase() : 'Tidak diketahui');
  }
  function englishName(code) {
    const l = byCode.get(norm(code));
    return l ? l[2] : (code ? `the language with ISO code "${code}"` : 'the same language the customer uses');
  }

  root.WATLangs = { LIST, norm, label, englishName };
})(typeof self !== 'undefined' ? self : globalThis);
