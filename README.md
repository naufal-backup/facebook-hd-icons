# Facebook HD Icons

UserScript yang membuat ikon Facebook jadi **vector (HD, tidak blur)** — Like/Comment/Share, toolbar komentar, sidebar, emoji, dan reaction picker. Dimuat secepat mungkin (`document-start`), tanpa kedipan ikon lama.

![Version](https://img.shields.io/badge/version-3.0-blue)
![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey-orange)
![License](https://img.shields.io/badge/license-MIT-green)

## Masalah yang diselesaikan

Facebook menampilkan banyak ikon sebagai PNG/Sprite kecil (16–20px) yang terlihat blur saat di-zoom atau di layar HD. UserScript ini menggantinya dengan SVG vector sehingga tajam di semua ukuran layar.

## Fitur

- **Like / Comment / Share** — ikon tombol aksi post diganti SVG vector, termasuk status aktif (thumb biru terisi, reaction berwarna yang sudah dipilih).
- **Toolbar komentar** — ikon avatar, foto/video, GIF, dan stiker di kolom komentar.
- **Sidebar kiri** — ±20 item (Meta AI, Teman, Grup, Marketplace, Event, Gaming, dsb.) diganti ikon vector/emoji sesuai topiknya.
- **Emoji** — semua emoji PNG (`emoji.php`) diganti Twemoji SVG, termasuk emoji di kolom input (editor Lexical).
- **Reaction picker** — emoji Like/Love/Care/Haha/Wow/Sad/Angry saat hover diganti Twemoji SVG lengkap dengan efek membesar saat hover (seperti bawaan Facebook).
- **Ringkasan reaction** — ikon kecil "Like: 2 orang" di bawah post ikut di-HD-kan.
- **Cache persisten** — SVG diunduh sekali lalu disimpan (via `GM_setValue`), kunjungan berikutnya langsung HD tanpa jeda.
- **Idempoten & tahan re-render** — semua fungsi upgrade bisa dipanggil berulang; MutationObserver memasang ulang ikon jika React mengembalikan ikon lama.

## Instalasi

1. Pasang ekstensi [Tampermonkey](https://www.tampermonkey.net/) (atau Violentmonkey / Greasemonkey).
2. Klik file [`Facebook-HD-Icons-3.0.user.js`](./Facebook-HD-Icons-3.0.user.js) di repo ini, lalu klik **Raw** — Tampermonkey otomatis menawarkan pemasangan.
   - Alternatif: buka tab Tampermonkey → Create new script → tempel seluruh isi file → Save.
3. Buka [facebook.com](https://www.facebook.com) — ikon sudah HD.

> **Catatan:** skrip hanya berjalan di `https://*.facebook.com/*`.

## Konfigurasi

Buka bagian `===== Config =====` di bagian atas skrip:

| Opsi | Default | Fungsi |
|---|---|---|
| `DEBUG` | `false` | `true` = log kandidat reaction ke console (F12) |
| `EMOJI_INPUT_GAP` | `'2px'` | Jarak kiri/kanan tiap emoji di kolom input |
| `EMOJI_INPUT_SCALE` | `'80%'` | Ukuran emoji di kolom input (kecilkan jika masih rapat) |
| `REACTION_HOVER_SCALE` | `1.4` | Besar emoji saat di-hover di picker (`1` = tanpa efek) |
| `REACTION_PICKER_HD` | `true` | `false` = jangan ubah ikon reaction picker |

## Cara kerja (ringkas)

- Berjalan di `document-start` dan memasang CSS *pre-hide* — ikon lama disembunyikan dulu, jadi tidak ada kedipan saat ikon HD muncul.
- `MutationObserver` pada seluruh DOM menjalankan fungsi upgrade secara sinkron sebelum browser menggambar.
- Ikon ubin (sprite) diganti lewat teknik **CSS mask** (`mask-image` + `background-color: var(--secondary-icon)`) agar warnanya ikut tema terang/gelap.
- Reaction picker ditangani dengan pola **host + overlay**: isi lama di dalam host disembunyikan lewat CSS (tahan re-render React), SVG ditaruh sebagai overlay.
- Emoji & sidebar memakai SVG dari [Twemoji](https://github.com/jdecked/twemoji) via `cdn.jsdelivr.net` (di-*whitelist* di `@connect`).

## Alat diagnosa

- **`Ctrl+Shift+H`** — hover tombol Like sampai picker muncul, jangan gerakkan mouse, lalu tekan shortcut ini. Struktur elemen di bawah kursor disalin ke clipboard (berguna untuk melaporkan ikon yang belum terganti).
- Set `DEBUG = true` untuk melihat log kandidat reaction di console.

## Dukungan browser

| Browser | Status |
|---|---|
| Chrome / Edge / Brave (Tampermonkey) | ✅ |
| Firefox (Tampermonkey / Violentmonkey) | ✅ |
| Opera | ✅ |

## Troubleshooting

- **Ikon tertentu masih blur** — pastikan skrip versi terbaru aktif di dasbor Tampermonkey, lalu reload Facebook dengan Ctrl+Shift+R.
- **Reaksi tidak berubah setelah Facebook update** — struktur DOM Facebook bisa berubah; laporkan lewat GitHub Issues sertakan tangkapan layar dan (bila bisa) output `Ctrl+Shift+H`.
- **Emoji terlalu rapat di kolom input** — ubah `EMOJI_INPUT_GAP` / `EMOJI_INPUT_SCALE` (lihat tabel konfigurasi).

## Kredit

- [Twemoji](https://github.com/jdecked/twemoji) oleh jdecked — SVG emoji (lisensi CC-BY 4.0).
- Ikon like/comment/share/sidebar mengikuti gaya Material Icons.

## Lisensi

MIT
