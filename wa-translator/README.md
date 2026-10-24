# WA Translator & Reply Assistant

Extension Chrome untuk **WhatsApp Web** yang membantu tim Customer Service dan tim Bisnis melayani pelanggan dari berbagai negara.

| Fitur | Keterangan |
|---|---|
| **Terjemahan otomatis pesan masuk** | Terjemahan muncul di bawah setiap bubble pesan pelanggan. Bahasa pelanggan terdeteksi otomatis. |
| **3 saran balasan sesuai konteks** | Disusun dari isi percakapan dan profil bisnis, ditulis dalam bahasa pelanggan, disertai artinya dalam Bahasa Indonesia. |
| 🟢 Positif | Mendukung dan melanjutkan percakapan ke langkah berikutnya. |
| 🟠 Tahan | Menahan percakapan dengan sopan, menyampaikan bahwa hal ini akan dibahas dengan tim terkait, tanpa menjanjikan hasil. |
| 🔴 Tolak | Menolak dengan baik dan profesional, dan bila memungkinkan menawarkan alternatif. |
| **Tulis sendiri → terjemahkan** | Agen menulis dalam Bahasa Indonesia, lalu teksnya diterjemahkan ke bahasa pelanggan. Arti terjemahan ditampilkan agar bisa dicek. |
| **Alt+T di kolom ketik** | Isi kolom ketik WhatsApp langsung diganti dengan terjemahannya. |
| **Aman untuk dipakai** | Pesan **tidak pernah terkirim otomatis**. Tombol *Sisipkan* hanya mengisi kolom ketik, lalu agen memeriksa dan menekan Enter sendiri. |

Isi folder:

| Path | Isi |
|---|---|
| `extension/` | Extension Chrome (Manifest V3) |
| `worker/proxy-worker.js` | Proxy tim (opsional) agar API key tidak dibagikan ke setiap agen |

---

## 1. Pasang extension (setiap komputer agen)

1. Ekstrak ZIP.
2. Buka `chrome://extensions`, lalu aktifkan **Developer mode**.
3. Klik **Load unpacked**, lalu pilih folder `extension/`.
4. Halaman **Pengaturan** akan terbuka otomatis. Pilih layanan AI dan isi API key, lalu klik **Tes koneksi** dan **Simpan**.
5. Buka `web.whatsapp.com`. Tombol bulat 🌐 akan muncul di kanan bawah.

Layanan AI yang didukung:

| Pilihan | Yang diisi | Catatan |
|---|---|---|
| Claude (Anthropic) | API key `sk-ant-…`, model `claude-haiku-5-5` (cepat dan hemat) atau `claude-sonnet-5-5` (balasan lebih matang) | Default |
| OpenAI / kompatibel | API key, model, Base URL | Base URL bisa diganti ke layanan lain yang kompatibel dengan Chat Completions |
| Google Gemini | API key, model | |
| Proxy tim | URL Worker + token tim | **Disarankan untuk tim**, lihat bagian 4 |

## 2. Isi profil bisnis (penting)

Buka **Pengaturan → Profil bisnis**, lalu klik **Isi dengan templat** dan lengkapi:

- deskripsi bisnis,
- produk dan harga,
- kebijakan (pembayaran, refund, hal yang tidak dilayani),
- **alur eskalasi** (misalnya: kerja sama → tim bisnis, maksimal 2 hari kerja). Alur ini dipakai untuk jawaban *Tahan*.

AI **hanya** memakai fakta dari profil ini dan dari isi percakapan. Jika ada info yang tidak diketahui, misalnya harga atau tanggal, AI menuliskannya sebagai placeholder seperti `[isi: harga paket]`. Panel menampilkan peringatan *"Isi dulu: …"* supaya agen melengkapinya sebelum mengirim.

## 3. Cara pakai (panduan agen)

| Aksi | Cara |
|---|---|
| Buka/tutup panel | Klik 🌐, klik ikon extension di toolbar, atau tekan **Alt+Q** |
| Buat 3 saran | Klik **Buat 3 saran** atau tekan **Alt+R**. Bisa menambahkan *Arahan untuk AI*, misalnya "tawarkan demo hari Kamis". |
| Buat ulang satu jenis saran | Klik tombol **Positif**, **Tahan**, atau **Tolak** di atas, atau **Ulangi** di kartu |
| Pakai saran | Edit di kartu bila perlu, lalu klik **Sisipkan**. Periksa, lalu tekan Enter di WhatsApp. |
| Tulis sendiri | Tulis di *Tulis sendiri → terjemahkan*, lalu klik **Terjemahkan** (atau Ctrl+Enter), lalu **Sisipkan** |
| Terjemahkan langsung di kolom ketik | Ketik dalam Bahasa Indonesia di WhatsApp, lalu tekan **Alt+T**. Artinya muncul di pojok kanan bawah. |
| Bahasa pelanggan salah terdeteksi | Pilih manual di **Bahasa pelanggan**. Pilihan ini diingat per chat. |
| Matikan terjemahan untuk chat tertentu | Hilangkan centang *Terjemahkan pesan masuk otomatis di chat ini* |
| Ada yang tidak jalan | Klik **Diagnosa** di bawah panel |

Saat panel terbuka, tampilan WhatsApp digeser ke kiri agar tombol kirim tidak tertutup. Perilaku ini bisa dimatikan di Pengaturan.

## 4. Pemasangan untuk tim

**Pilihan A — Ekspor/Impor pengaturan**
1. Admin mengisi profil bisnis sekali, lalu membuka **Pengaturan → Ekspor pengaturan**. Secara default API key tidak ikut diekspor.
2. Agen memilih **Impor pengaturan**, mengisi key atau token sendiri, lalu klik **Simpan**.

**Pilihan B — Proxy tim (direkomendasikan)**

Dengan cara ini API key hanya tersimpan di server, setiap agen cukup memakai token tim, dan token bisa dicabut per orang.

1. Buat Worker baru di Cloudflare (dash.cloudflare.com → Workers & Pages → Create → *Hello World*), lalu ganti isinya dengan `worker/proxy-worker.js` dan klik **Deploy**.
2. Buka **Settings → Variables and Secrets** dan tambahkan:
   - `ANTHROPIC_API_KEY` (Secret): API key Anthropic
   - `TEAM_TOKENS` (Secret): token per agen dipisah koma, misalnya `cs-ani-7f3k…,biz-budi-k2p9…`. Gunakan string acak yang panjang.
   - `MODEL` (opsional): default `claude-haiku-5-5`
3. Di extension, pilih **Proxy tim**, isi URL Worker (`https://….workers.dev`) dan token agen, lalu klik **Simpan**. Chrome akan meminta izin akses ke URL tersebut; klik Izinkan.
4. Untuk mencabut akses seorang agen, hapus tokennya dari `TEAM_TOKENS`.

## 5. Privasi & kebijakan

- Teks chat yang diterjemahkan atau dianalisis **dikirim ke layanan AI yang dipilih**. Pastikan hal ini sesuai dengan kebijakan privasi perusahaan dan perjanjian dengan penyedia AI.
- Opsi **Samarkan nomor telepon & email** (aktif secara default) mengganti data tersebut dengan token seperti `[[PHONE_1]]` sebelum dikirim, lalu mengembalikannya di hasil. Harga dan tanggal tidak ikut disamarkan.
- Terjemahan disimpan di cache lokal Chrome (maksimal 4.000 entri) agar tidak membayar dua kali. Cache bisa dihapus di Pengaturan.
- Extension ini hanya membaca layar WhatsApp Web dan mengisi kolom ketik. Extension ini tidak mengirim pesan, tidak mengirim pesan massal, dan tidak mengakses API WhatsApp. Untuk otomatisasi skala besar, gunakan **WhatsApp Business Platform (API resmi)**.
- Pemakaian harian (jumlah permintaan dan token) bisa dilihat di Pengaturan untuk memantau biaya.

## 6. Jika WhatsApp mengubah tampilannya

Semua selector WhatsApp dikumpulkan di `extension/content/wa-dom.js`:

| Selector | Fungsi |
|---|---|
| `#main` | Panel chat |
| `[data-pre-plain-text]` | Pesan |
| `[data-id^=true_/false_]` | Arah pesan |
| `footer [contenteditable]` | Kolom ketik |

Jika **Diagnosa** menunjukkan "TIDAK ditemukan", file inilah yang perlu diperbarui.

## Pengujian yang sudah dilakukan

**Extension:**
- Dimuat sungguhan di Chromium, terhadap tiruan WhatsApp Web yang kolom ketiknya memakai **Lexical**, editor yang sama dengan WhatsApp.
- 50+ skenario lulus, termasuk:
  - terjemahan otomatis (hanya pesan masuk),
  - deteksi bahasa,
  - 3 saran dan *Ulangi* per nada,
  - Sisipkan (mengganti isi, tidak menumpuk, tidak mengirim otomatis),
  - Alt+T,
  - pindah chat,
  - pesan baru,
  - cache setelah muat ulang,
  - penyamaran data pribadi,
  - pesan error API key,
  - tema gelap,
  - format request Anthropic, OpenAI, Gemini, dan proxy.

**Proxy Worker:** diuji untuk token, batas ukuran, CORS, dan penerusan error.

**Belum diuji:**
- WhatsApp Web asli (perlu login nomor).
- Panggilan sungguhan ke layanan AI. Respons AI disimulasikan, jadi kualitas jawaban perlu dicoba langsung dengan API key Anda.
