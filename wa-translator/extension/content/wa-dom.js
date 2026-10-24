/**
 * Akses DOM WhatsApp Web.
 * Semua selector dikumpulkan di sini supaya mudah diperbarui jika WhatsApp mengubah tampilannya.
 * Pola yang dipakai (stabil bertahun-tahun di WhatsApp Web):
 *  - #main                       : panel percakapan yang terbuka
 *  - [data-pre-plain-text]       : pembungkus teks pesan, berisi "[10:31, 20/10/2026] Nama: "
 *  - [data-id="true_..|false_.."]: id pesan; awalan true = pesan keluar (dari kita)
 *  - .message-in / .message-out  : arah pesan (cadangan)
 *  - footer [contenteditable]    : kolom ketik (editor Lexical)
 */
(() => {
  'use strict';
  if (globalThis.WADOM) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const squash = (s) => String(s || '').replace(/[\s‎‏ ]+/g, ' ').trim();

  function main() {
    return document.getElementById('main');
  }

  function chatInfo() {
    const m = main();
    if (!m) return null;
    const header = m.querySelector('header');
    if (!header) return null;
    let title = '';
    const withTitle = header.querySelector('span[dir="auto"][title]');
    if (withTitle) title = withTitle.getAttribute('title');
    if (!title) {
      const span = header.querySelector('span[dir="auto"]');
      title = span ? span.textContent : '';
    }
    title = squash(title);
    if (!title) return null;
    return { title, key: title };
  }

  function extractText(root) {
    const src = root.querySelector('span.selectable-text') || root;
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const el = n;
      if (el.classList && el.classList.contains('wat-tr')) return;
      if (el.getAttribute('role') === 'button') return; // "Baca selengkapnya"
      if (el.tagName === 'IMG') { out += el.getAttribute('alt') || ''; return; }
      if (el.tagName === 'BR') { out += '\n'; return; }
      for (const c of el.childNodes) walk(c);
    };
    walk(src);
    return out.replace(/[‎‏]/g, '').replace(/[ \t]+\n/g, '\n').trim();
  }

  function parsePre(attr) {
    const m = /^\[(.+?),\s*(.+?)\]\s*(.*?):\s*$/.exec(attr || '');
    return m ? { time: m[1], date: m[2], sender: m[3] } : { time: '', date: '', sender: '' };
  }

  function direction(el, mainEl) {
    const idEl = el.closest('[data-id]');
    const id = idEl ? idEl.getAttribute('data-id') : '';
    if (/^true_/.test(id)) return 'out';
    if (/^false_/.test(id)) return 'in';
    if (el.closest('.message-out')) return 'out';
    if (el.closest('.message-in')) return 'in';
    const r = el.getBoundingClientRect();
    const m = (mainEl || main()).getBoundingClientRect();
    return (r.left + r.right) / 2 > (m.left + m.right) / 2 ? 'out' : 'in';
  }

  /** Pesan teks yang sedang dimuat di percakapan, urut lama → baru */
  function messages() {
    const m = main();
    if (!m) return [];
    const out = [];
    for (const el of m.querySelectorAll('[data-pre-plain-text]')) {
      if (el.closest('footer')) continue;
      const text = extractText(el);
      if (!text) continue;
      const pre = parsePre(el.getAttribute('data-pre-plain-text'));
      const idEl = el.closest('[data-id]');
      out.push({ el, id: idEl ? idEl.getAttribute('data-id') : '', dir: direction(el, m), text, ...pre });
    }
    return out;
  }

  function composer() {
    const m = main();
    const scopes = m ? [m, document] : [document];
    for (const s of scopes) {
      const c = s.querySelector('footer div[contenteditable="true"]') ||
        (s === m ? s.querySelector('div[contenteditable="true"][role="textbox"]') : null);
      if (c) return c;
    }
    return null;
  }

  function composerText() {
    const c = composer();
    return c ? c.innerText.replace(/\n{3,}/g, '\n\n').trim() : '';
  }

  function placeCaret(c, mode) {
    c.focus();
    const sel = window.getSelection();
    if (mode === 'replace') {
      document.execCommand('selectAll', false, null);
      if (!sel.rangeCount || !c.contains(sel.anchorNode)) {
        const r = document.createRange();
        r.selectNodeContents(c);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    } else {
      const r = document.createRange();
      r.selectNodeContents(c);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  /**
   * Masukkan teks ke kolom ketik WhatsApp (TIDAK mengirim).
   * mode: 'replace' (ganti isi) | 'append' (tambahkan di akhir)
   * Hasil: 'paste' | 'insertText' | 'clipboard'
   */
  async function insert(text, mode = 'replace') {
    const c = composer();
    if (!c) throw new Error('Kolom ketik WhatsApp tidak ditemukan. Buka sebuah chat terlebih dahulu.');
    const want = squash(text);
    const before = squash(c.innerText);
    const done = () => {
      const now = squash(c.innerText);
      return mode === 'replace' ? now === want : now === squash(before + ' ' + text) || (now.endsWith(want) && now.length >= want.length + before.length);
    };
    const paste = () => {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch (_) { /* lanjut ke cara berikutnya */ }
    };
    // Editor (Lexical) menyinkronkan seleksi lewat event selectionchange yang asinkron,
    // jadi beri jeda setelah memindahkan kursor sebelum menempel.

    // 1) Simulasi paste — ditangani editor seperti paste biasa (mendukung multi-baris)
    placeCaret(c, mode);
    await sleep(60);
    paste();
    await sleep(80);
    if (done()) return 'paste';

    // 2) Kosongkan lalu tempel ulang (jika paste pertama menumpuk / tidak mengganti)
    if (mode === 'replace' && squash(c.innerText)) {
      placeCaret(c, 'replace');
      await sleep(60);
      document.execCommand('delete', false, null);
      await sleep(60);
      paste();
      await sleep(80);
      if (done()) return 'paste';
    }

    // 3) execCommand insertText (beforeinput)
    placeCaret(c, mode);
    await sleep(60);
    document.execCommand('insertText', false, text);
    await sleep(80);
    if (done()) return 'insertText';

    // 4) Terakhir: salin ke clipboard, agen menekan Ctrl+V
    try { await navigator.clipboard.writeText(text); } catch (_) { /* abaikan */ }
    return 'clipboard';
  }

  function diagnostics() {
    const m = main();
    const msgs = messages();
    return {
      main: !!m,
      chat: chatInfo(),
      messages: msgs.length,
      incoming: msgs.filter((x) => x.dir === 'in').length,
      outgoing: msgs.filter((x) => x.dir === 'out').length,
      withDataId: msgs.filter((x) => x.id).length,
      composer: !!composer(),
      url: location.href,
    };
  }

  globalThis.WADOM = { main, chatInfo, messages, extractText, parsePre, composer, composerText, insert, diagnostics };
})();
