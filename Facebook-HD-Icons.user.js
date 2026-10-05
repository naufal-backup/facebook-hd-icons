// ==UserScript==
// @name         Facebook HD Icons
// @namespace    fb-hd-icons
// @version      3.3
// @description  Ikon Like/Comment/Share, tombol Create a post, avatar, toolbar komentar, sidebar, emoji, dan reaction jadi vector (HD, tidak blur) - dimuat secepat mungkin
// @homepage     https://github.com/naufal-backup/facebook-hd-icons
// @supportURL   https://github.com/naufal-backup/facebook-hd-icons/issues
// @updateURL    https://github.com/naufal-backup/facebook-hd-icons/raw/master/Facebook-HD-Icons.user.js
// @downloadURL  https://github.com/naufal-backup/facebook-hd-icons/raw/master/Facebook-HD-Icons.user.js
// @match        https://*.facebook.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      cdn.jsdelivr.net
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ===== Config =====
  const DEBUG = false;             // true = log kandidat reaction ke console (F12)
  const EMOJI_INPUT_GAP = '2px';   // jarak kiri/kanan tiap emoji di kolom input
  const EMOJI_INPUT_SCALE = '80%'; // ukuran emoji di kolom input (kecilkan jika masih rapat)
  const REACTION_HOVER_SCALE = 1.4; // besar emoji saat di-hover di picker (1 = tanpa efek)
  const REACTION_PICKER_HD = true; // false = jangan ubah ikon reaction picker
  const TWEMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/svg/';
  const PRELOAD_ALL_EMOJI = true;  // unduh seluruh set Twemoji (3.846 file, ~9MB) di latar belakang saat load
  const PRELOAD_CONCURRENCY = 6;   // jumlah request paralel untuk preload latar belakang
  const PRELOAD_RETRY = 2;         // maksimal percobaan per file saat preload (retry sekali)

  // ===== Cache SVG persisten (supaya kunjungan berikutnya langsung HD tanpa jeda) =====
  // Di-pecah jadi 16 shard per-hash-nama: preload penuh ~9MB, kalau disimpan dalam satu key
  // bisa melewati batas per-nilai storage manager, dan parse 9MB saat document-start akan
  // menahan render Facebook. Tiap shard dibaca lazy (baru saat ada nama yang masuk).
  const CACHE_KEY = 'svg_cache_v1';   // key lama (<= 3.2), dimigrasikan ke shard lalu dikosongkan
  const SHARD_KEY = 'svg_cache_v1_s';
  const SHARD_COUNT = 16;             // ~16 x 550KB, aman di bawah batas per-nilai storage
  const shardOf = (name) => {
    let h = 5381; // djb2 -> sebaran merata antar shard
    for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
    return h & (SHARD_COUNT - 1);
  };
  const shards = new Array(SHARD_COUNT).fill(null); // null = belum dibaca dari storage
  const dirty = new Set();            // shard yang menunggu ditulis
  const toUri = (t) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(t);
  const cache = new Map(); // name -> Promise<uri|null>

  function getShard(i) {
    if (shards[i]) return shards[i];
    let o = {};
    try { o = JSON.parse(GM_getValue(SHARD_KEY + i, '{}')) || {}; } catch (e) {}
    shards[i] = o;
    return o;
  }

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Array.from(dirty).forEach((i) => {
        dirty.delete(i);
        try { GM_setValue(SHARD_KEY + i, JSON.stringify(shards[i] || {})); }
        catch (e) { if (DEBUG) console.log('[fb-hd] gagal simpan shard ' + i, e); }
      });
    }, 1000);
  }

  // migrasi cache lama (satu key) -> shard
  try {
    const legacy = JSON.parse(GM_getValue(CACHE_KEY, '{}')) || {};
    const legacyNames = Object.keys(legacy);
    if (legacyNames.length) {
      legacyNames.forEach((n) => { getShard(shardOf(n))[n] = legacy[n]; dirty.add(shardOf(n)); });
      GM_setValue(CACHE_KEY, '{}');
      persist();
      if (DEBUG) console.log('[fb-hd] migrasi cache lama:', legacyNames.length, 'entry');
    }
  } catch (e) {}

  function loadSvg(name) {
    if (cache.has(name)) return cache.get(name);
    const si = shardOf(name);
    const sh = getShard(si);
    if (name in sh) { // sudah pernah diunduh -> ambil dari cache persisten, tanpa jaringan
      const p = Promise.resolve(toUri(sh[name]));
      cache.set(name, p);
      return p;
    }
    const p = new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: TWEMOJI + name + '.svg',
        onload: (r) => {
          if (r.status === 200) {
            getShard(si)[name] = r.responseText;
            dirty.add(si);
            persist();
            resolve(toUri(r.responseText));
          } else {
            cache.delete(name); // gagal -> jangan mem-poison cache, biar bisa dicoba lagi
            resolve(null);
          }
        },
        onerror: () => { cache.delete(name); resolve(null); }
      });
    });
    cache.set(name, p);
    return p;
  }

  // ===== Preload penuh: seluruh set Twemoji diunduh saat Facebook dimuat =====
  // Antrean dengan batas paralel supaya tidak menyalip resource Facebook sendiri.
  // Prioritas on-demand (hover picker, kolom komentar) tetap lewat loadSvg langsung.
  const preQueue = [];
  const preQueued = new Set();
  const preFailed = new Set();
  let preActive = 0;
  let preAttempts = 0;

  function preloadPump() {
    if (!preActive && !preQueue.length && preFailed.size && preAttempts + 1 < PRELOAD_RETRY) {
      preAttempts++;
      if (DEBUG) console.log('[fb-hd] retry preload emoji, percobaan ke-' + (preAttempts + 1));
      preFailed.forEach((n) => { preQueued.delete(n); preQueue.push(n); });
      preFailed.clear();
    }
    while (preActive < PRELOAD_CONCURRENCY && preQueue.length) {
      const name = preQueue.shift();
      preQueued.delete(name);
      preActive++;
      loadSvg(name).then((uri) => {
        if (!uri) preFailed.add(name);
        preActive--;
        preloadPump();
      });
    }
  }

  function preloadSvg(name) {
    if (cache.has(name) || preQueued.has(name)) return;
    preQueued.add(name);
    preQueue.push(name);
    preloadPump();
  }

  // Listing direktori CDN (host ini sudah ada di @connect) -> daftar semua nama file emoji
  function startPreload() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: TWEMOJI,
      onload: (r) => {
        if (r.status !== 200) {
          if (DEBUG) console.log('[fb-hd] listing emoji gagal, HTTP ' + r.status);
          return;
        }
        const re = /\/assets\/svg\/([^\/"]+)\.svg/g;
        let m, n = 0;
        while ((m = re.exec(r.responseText))) { preloadSvg(m[1]); n++; }
        if (DEBUG) console.log('[fb-hd] preload emoji dimulai:', n, 'file, paralel ' + PRELOAD_CONCURRENCY);
      },
      onerror: () => { if (DEBUG) console.log('[fb-hd] listing emoji gagal (network)'); }
    });
  }

  function setImp(el, prop, val) { el.style.setProperty(prop, val, 'important'); }

  // Pantau elemen yang sudah diganti: kalau Facebook mengembalikan ikon lama (hover / re-render),
  // langsung dipasang ulang. Semua fungsi upgrade idempoten, jadi tidak ada loop.
  function watch(el) {
    if (el._hdw) return;
    el._hdw = new MutationObserver(() => run(el.parentElement || el));
    el._hdw.observe(el, { attributes: true, attributeFilter: ['src', 'srcset', 'style', 'alt'] });
  }

  // ===== Data ikon =====
  const PATHS = {
    like: 'M9 21h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2zM9 9l4.34-4.34L12 10h9v2l-3 7H9V9zM1 9h4v12H1z',
    comment: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z',
    share: 'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z'
  };
  const COMPOSER_ICONS = [
    [/avatar/i, 'avatar'],
    [/photo or video|foto atau video/i, 'photo'],
    [/\bgif\b/i, 'gif'],
    [/sticker|stiker/i, 'sticker']
  ];
  const COMPOSER_PATHS = {
    avatar: 'M9 11.75c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zm6 0c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-.29.02-.58.05-.86 2.36-1.05 4.23-2.98 5.21-5.37C11.07 7.5 13.99 9 17.3 9c.75 0 1.47-.11 2.15-.31.35.99.55 2.05.55 3.17 0 4.41-3.59 8-8 8z',
    photo: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
    gif: 'M11.5 9H13v6h-1.5zM9 9H6c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h3c.55 0 1-.45 1-1v-2H8.5v1.5h-2v-3H10V10c0-.55-.45-1-1-1zm10 1.5V9h-4.5v6H16v-2h2v-1.5h-2v-1z',
    sticker: 'M19 3H4.99C3.89 3 3 3.9 3 5l.01 14c0 1.1.89 2 1.99 2h10l6-6V5c0-1.1-.9-2-2-2zM7 8h10v2H7V8zm5 6H7v-2h5v2zm2 5.5V14h5.5L14 19.5z'
  };
  const REACTIONS = [
    [/^(like|suka)$/i, 'like'],
    [/^(love|super)$/i, '2764'],
    [/^(care|peduli)$/i, '1f970'],
    [/^haha$/i, '1f606'],
    [/^wow$/i, '1f62e'],
    [/^(sad|sedih)$/i, '1f622'],
    [/^(angry|marah)$/i, '1f621']
  ];
  const REACTION_ORDER = ['like', '2764', '1f970', '1f606', '1f62e', '1f622', '1f621'];
  const LIKE_SVG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='12' fill='#0866ff'/>` +
    `<path fill='#fff' transform='translate(5.4 5.4) scale(.55)' d='M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.58 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z'/></svg>`
  );
  // [regex href, key, selector CSS untuk sembunyikan ikon lama sebelum diganti]
  const SIDEBAR_ICONS = [
    [/meta\.ai/, 'metaai', 'a[href*="meta.ai"]'],
    [/\/friends\/?$/, '1f9d1-200d-1f91d-200d-1f9d1', 'a[href$="/friends/"]'],
    [/professional_dashboard/, '1f4ca', 'a[href*="professional_dashboard"]'],
    [/onthisday/, '1f570', 'a[href*="onthisday"]'],
    [/\/saved\/\?cref/, '1f516', 'a[href*="/saved/?cref"]'],
    [/\/groups\/\?ref=bookmarks/, '1f465', 'a[href*="/groups/?ref=bookmarks"]'],
    [/ad_center/, '1f4e3', 'a[href*="ad_center"]'],
    [/ad_campaign\/landing/, '1f4c8', 'a[href*="ad_campaign/landing"]'],
    [/\/events\/birthdays/, '1f382', 'a[href*="/events/birthdays"]'],
    [/\/events\?source/, '1f4c5', 'a[href*="/events?source"]'],
    [/sk=h_chr/, '1f4f0', 'a[href*="sk=h_chr"]'],
    [/gaming\/\?external_ref/, '1f3ae', 'a[href*="gaming/?external_ref"]'],
    [/gaming\/play\/\?store_visit/, '1f579', 'a[href*="gaming/play/?store_visit"]'],
    [/\/marketplace\/\?ref=bookmark/, '1f3ea', 'a[href*="/marketplace/?ref=bookmark"]'],
    [/\/messages\/t\/?$/, '1f4ac', 'a[href$="/messages/t/"]'],
    [/messenger_kids/, '1f9f8', 'a[href*="messenger_kids"]'],
    [/facebook_pay/, '1f4b3', 'a[href*="facebook_pay"]'],
    [/\/pages\/\?category/, '1f6a9', 'a[href*="/pages/?category"]'],
    [/\/reel\/\?s=tab/, '1f3ac', 'a[href*="/reel/?s=tab"]'],
    [/ads\/activity/, '1f4cb', 'a[href*="ads/activity"]']
  ];
  const META_AI_SVG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='#0064e0'/><stop offset='.5' stop-color='#0082fb'/><stop offset='1' stop-color='#a33ffd'/></linearGradient></defs>` +
    `<circle cx='18' cy='18' r='13' fill='none' stroke='url(#g)' stroke-width='5.5'/></svg>`
  );

  // ===== CSS: sembunyikan ikon lama sampai versi HD terpasang (tidak ada kedipan) =====
  const HIDE = 'visibility:hidden!important';
  const ACTION_MARK = ':is([data-ad-rendering-role="like_button"],[data-ad-rendering-role="comment_button"],[data-ad-rendering-role="share_button"])';
  const NOT_DONE = ':not([data-hd]):not([data-hd-skip])';
  const preHide = [
    `*:has(> ${ACTION_MARK}) i[data-visualcompletion="css-img"]${NOT_DONE}`,
    '*:has(> [data-ad-rendering-role="like_button"]) img:not([data-hd-act])',
    `ul[data-id$="state-actions-list"] i[data-visualcompletion="css-img"]${NOT_DONE}`,
    'img[src*="emoji.php"]:not([data-hd-done])',
    '[data-testid="emoji"][style*="emoji.php"]:not([data-hd-done])',
    ...SIDEBAR_ICONS.map((x) => `${x[2]} :is(i[data-visualcompletion="css-img"],img):not([data-hd-side])`)
  ];
  const style = document.createElement('style');
  style.id = 'fb-hd-prehide';
  style.textContent = preHide.map((s) => (s.startsWith('[data-testid="emoji"]') ? `${s}{background-image:none!important}` : `${s}{${HIDE}}`)).join('\n') +
    '\n[data-hd-react-host]{background-image:none!important}' +
    '\n[data-hd-react-host] *:not(img[data-hd-react]){visibility:hidden!important}' +
    // Efek membesar saat hover (seperti bawaan Facebook)
    '\n[data-hd-react-host]{overflow:visible!important}' +
    '\n[data-hd-react-host]:hover,[data-hd-lift]{z-index:9999!important}' +
    '\nimg[data-hd-react]{transform-origin:50% 100%;transition:transform .16s cubic-bezier(.2,.9,.3,1.3);will-change:transform}' +
    `\n[data-hd-react-host]:hover img[data-hd-react]{transform:scale(${REACTION_HOVER_SCALE}) translateY(-8%)}`;
  (document.head || document.documentElement).appendChild(style);

  // ===== SVG mask =====
  const svgUrl = (d) =>
    `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${d}'/></svg>`
    )}")`;
  const maskCache = {};
  function applyMask(icon, type, paths, size) {
    const key = 'm' + type;
    const u = maskCache[key] || (maskCache[key] = svgUrl(paths[type]));
    if (icon.dataset.hd === type && icon.style.backgroundImage === 'none') return;
    icon.dataset.hd = type;
    watch(icon);
    setImp(icon, 'background-image', 'none');
    setImp(icon, 'background-color', 'var(--secondary-icon, currentColor)');
    ['', '-webkit-'].forEach((p) => {
      setImp(icon, p + 'mask-image', u);
      setImp(icon, p + 'mask-size', size);
      setImp(icon, p + 'mask-repeat', 'no-repeat');
      setImp(icon, p + 'mask-position', 'center');
    });
  }

  // ===== 1. Ikon Like / Comment / Share =====
  const LIKED_RE = /^(remove|unlike|hapus|batal)/i;
  // Cocokkan nama reaction, termasuk label state terpilih ("Remove Love", "Hapus Super")
  const reactionOf = (label) => REACTIONS.find(([re]) => re.test(String(label).replace(LIKED_RE, '').trim()));
  // Thumb biru terisi untuk status "Like" aktif
  const LIKED_LIKE_SVG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='#0866ff' d='M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.58 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z'/></svg>`
  );
  const MASK_PROPS = ['background-color', 'mask-image', '-webkit-mask-image', 'mask-size', '-webkit-mask-size',
    'mask-repeat', '-webkit-mask-repeat', 'mask-position', '-webkit-mask-position'];

  async function applyLiked(icon, label) {
    const name = label.replace(LIKED_RE, '').trim();
    const hit = REACTIONS.find(([re]) => re.test(name));
    if (!hit) {
      if (DEBUG) console.log('[fb-hd] label reaction aktif tak dikenal:', label);
      icon.dataset.hdSkip = '1'; // biarkan ikon asli
      return;
    }
    const key = hit[1];
    const tag = 'liked-' + key;
    if (icon.dataset.hd === tag && (icon.style.backgroundImage || '').startsWith('url("data:')) return;
    icon.dataset.hd = tag;
    const uri = key === 'like' ? LIKED_LIKE_SVG : await loadSvg(key);
    if (!uri) { delete icon.dataset.hd; icon.dataset.hdSkip = '1'; return; }
    watch(icon);
    MASK_PROPS.forEach((p) => icon.style.removeProperty(p));
    setImp(icon, 'background-image', `url("${uri}")`);
    setImp(icon, 'background-size', 'contain');
    setImp(icon, 'background-position', 'center');
    setImp(icon, 'background-repeat', 'no-repeat');
  }

  // Tombol Like yang sudah dipilih: FB menampilkan <img> SVG bawaan (alt = nama reaction)
  async function applyActiveImg(img) {
    const alt = (img.getAttribute('alt') || '').trim();
    const hit = REACTIONS.find(([re]) => re.test(alt));
    if (!hit) { img.dataset.hdAct = 'skip'; return; }
    const key = hit[1];
    const uri = key === 'like' ? LIKE_SVG : await loadSvg(key);
    if (!uri) { img.dataset.hdAct = 'skip'; return; }
    watch(img);
    if (img.dataset.hdAct === key && img.getAttribute('src') === uri) return;
    img.removeAttribute('srcset');
    img.setAttribute('src', uri);
    img.dataset.hdAct = key;
  }

  function upgradeActionIcons(root) {
    root.querySelectorAll('[data-ad-rendering-role$="_button"]').forEach((marker) => {
      const type = marker.getAttribute('data-ad-rendering-role').replace('_button', '');
      if (!PATHS[type]) return;
      const par = marker.parentElement;
      const img = type === 'like' && par && par.querySelector('img[alt]');
      if (img) { applyActiveImg(img); return; }
      const icon = par && par.querySelector('i[data-visualcompletion="css-img"]');
      if (!icon) return;
      const btn = marker.closest('[role="button"]');
      const label = (btn && btn.getAttribute('aria-label')) || '';

      // Saat sudah di-like/react, FB menampilkan ikon reaction aktif (berwarna)
      if (type === 'like' && LIKED_RE.test(label)) {
        delete icon.dataset.hdSkip;
        applyLiked(icon, label);
        return;
      }
      delete icon.dataset.hdSkip;
      applyMask(icon, type, PATHS, '115%');
    });
  }

  // ===== 1b. Toolbar komentar =====
  function upgradeComposerIcons(root) {
    root.querySelectorAll('ul[data-id$="state-actions-list"] [role="button"][aria-label]').forEach((btn) => {
      const icon = btn.querySelector('i[data-visualcompletion="css-img"]');
      if (!icon) return; // tombol emoji sudah SVG inline
      const hit = COMPOSER_ICONS.find(([re]) => re.test(btn.getAttribute('aria-label')));
      if (!hit) { icon.dataset.hdSkip = '1'; return; } // label tak dikenal -> tampilkan asli
      applyMask(icon, hit[1], COMPOSER_PATHS, '125%');
    });
  }

  // ===== 1c. Ikon tombol "Create a post": Live video / Photo/video / Reel =====
  // Ikon-ikon ini berupa <img> webp 24px dari rsrc.php (sprite -> blur) dan tidak punya
  // aria-label per ikon. Ganti lewat CSS mask: src diganti transparan, warnanya ikut
  // tema halaman (var(--secondary-icon)).
  const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const CREATE_ICONS = [
    [/^(live video|video live|siaran langsung|video langsung)$/i, 'live'],
    [/^(photo\/video|foto\/video)$/i, 'photo'],
    [/^reels?$/i, 'reel']
  ];
  const CREATE_PATHS = {
    live: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
    photo: COMPOSER_PATHS.photo,
    reel: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z'
  };

  function applyImgMask(img, type, paths) {
    const key = 'im' + type;
    const u = maskCache[key] || (maskCache[key] = svgUrl(paths[type]));
    if (img.dataset.hdCp === type && img.getAttribute('src') === BLANK_GIF) return;
    img.dataset.hdCp = type;
    watch(img);
    img.removeAttribute('srcset');
    setImp(img, 'background-image', 'none');
    img.setAttribute('src', BLANK_GIF); // webp lama disembunyikan, kotak tetap 24px
    setImp(img, 'background-color', 'var(--secondary-icon, currentColor)');
    ['', '-webkit-'].forEach((p) => {
      setImp(img, p + 'mask-image', u);
      setImp(img, p + 'mask-size', 'contain');
      setImp(img, p + 'mask-repeat', 'no-repeat');
      setImp(img, p + 'mask-position', 'center');
    });
  }

  function upgradeCreatePostIcons(root) {
    root.querySelectorAll('[role="button"][aria-label]').forEach((btn) => {
      const hit = CREATE_ICONS.find(([re]) => re.test(btn.getAttribute('aria-label') || ''));
      if (!hit) return;
      const img = btn.querySelector('img');
      if (!img) return;
      if ((img.offsetWidth || 24) > 32) return; // bukan ikon kecil komposer
      applyImgMask(img, hit[1], CREATE_PATHS);
    });
  }

  // ===== 1d. Avatar bertanda <image> dengan crop CDN (ctp=sNNxNN) =====
  // Avatar40px meminta gambar 40x40 -> blur di layar retina. Minta versi 160px
  // (SVG-nya tetap dirender 40px oleh Facebook).
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  function upgradeAvatarRes(root) {
    root.querySelectorAll('svg image').forEach((im) => {
      const href = im.getAttribute('xlink:href') || im.getAttribute('href') || '';
      const m = href.match(/ctp=s(\d+)x\d+/);
      if (!m) return;
      if (+m[1] > 80) return; // sudah besar, jangan diubah
      const big = href.replace(/ctp=s\d+x\d+/, 'ctp=s160x160');
      if (href === big) return;
      if (im.hasAttributeNS(XLINK_NS, 'href')) im.setAttributeNS(XLINK_NS, 'xlink:href', big);
      else im.setAttribute('href', big);
    });
  }

  // ===== 1e. Tombol status reaksi komentar: "Remove Haha" / "Change Haha reaction" =====
  // Emoji aktif memakai <img> SVG buatan FB (tanpa alt), tombol gantinya memakai sprite
  // <i> 12px -> keduanya diganti Twemoji supaya konsisten dengan bagian lain & tajam.
  const STATE_RE = /^(?:remove|change|hapus|ganti|ubah|tukar|batal|unlike)\s+(.+?)(?:\s+(?:reaction|reaksi))?$/i;
  function reactionKeyFromStateLabel(label) {
    const m = STATE_RE.exec(String(label || '').trim());
    if (!m) return null;
    const name = m[1].trim().replace(/^(?:reaction|reaksi)\s+/i, '');
    const hit = REACTIONS.find(([re]) => re.test(name));
    return hit ? hit[1] : null;
  }

  async function upgradeReactionStateButtons(root) {
    root.querySelectorAll('[role="button"][aria-label]').forEach(async (btn) => {
      const key = reactionKeyFromStateLabel(btn.getAttribute('aria-label'));
      if (!key) return;
      if (btn.querySelector('[data-ad-rendering-role]')) return; // tombol aksi post: sudah ditangani
      const uri = key === 'like' ? LIKE_SVG : await loadSvg(key);
      if (!uri) return;
      // a) <img> emoji yang sedang aktif (16px)
      const img = btn.querySelector('img');
      if (img && (img.offsetWidth || 16) <= 24) {
        watch(img);
        if (img.dataset.hdState !== key || img.getAttribute('src') !== uri) {
          img.dataset.hdState = key;
          img.removeAttribute('srcset');
          img.setAttribute('src', uri);
        }
      }
      // b) sprite <i> mini "Change X reaction" (12px)
      const icon = btn.querySelector('i[data-visualcompletion="css-img"]');
      if (icon && (icon.offsetWidth || 12) <= 24) {
        watch(icon);
        if (icon.dataset.hdState !== key || !(icon.style.backgroundImage || '').startsWith('url("data:')) {
          icon.dataset.hdState = key;
          setImp(icon, 'background-image', `url("${uri}")`);
          setImp(icon, 'background-size', 'contain');
          setImp(icon, 'background-position', 'center');
          setImp(icon, 'background-repeat', 'no-repeat');
        }
      }
    });
  }

  // ===== 1f. Ikon ringkasan reaction ("3 reactions; see who reacted to this") =====
  // Label tombolnya TIDAK menyebut nama reaction, jadi kenali dari isi SVG native FB:
  // cocokkan set warna di dalam data-URI ke signature tiap reaction -> pemenang harus
  // selisih unik & <= 3. Kalau tidak cocok, biarkan SVG FB asli (tetap vector, tajam).
  const FB_SIG = {
    like:    ['02ADFC', '0866FF', '2B7EFF'],
    '2764':  ['E11731', 'FA2E3E', 'FF5758', 'FF74AE'], // Love (heart)
    '1f970': ['1C1C1D', '4B280E', '791119', 'D9D9D9', 'E0761A', 'E11731', 'F68628', 'FA2E3E', 'FF5758', 'FFE480', 'FFE483', 'FFEB80', 'FFF287'], // Care
    '1f606': ['1C1C1D', '4B280E', 'BC0A26', 'F68628', 'FA2E3E', 'FF5758', 'FF60A4', 'FFF287'], // Haha (smile)
    '1f62e': ['1C1C1D', '4B280E', 'E0761A', 'F68628', 'FF5758', 'FFF287'], // Wow
    '1f622': ['02ADFC', '1C1C1D', '4B280E', 'E0761A', 'F68628', 'FF5758', 'FFF287'], // Sad
    '1f621': ['1C1C1D', '4B280E', 'BC0A26', 'FA2E3E', 'FF5758', 'FFB169']  // Angry
  };

  function fbReactionKey(svg) {
    const set = new Set();
    const re = /#([0-9a-fA-F]{3,6})\b/g;
    let m;
    while ((m = re.exec(svg))) {
      let h = m[1].toUpperCase();
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      set.add(h);
    }
    if (!set.size) return null;
    let best = null, bestD = 1e9, secondD = 1e9;
    for (const k in FB_SIG) {
      const ref = FB_SIG[k];
      let d = 0;
      set.forEach((c) => { if (ref.indexOf(c) < 0) d++; });
      for (let i = 0; i < ref.length; i++) if (!set.has(ref[i])) d++;
      if (d < bestD) { secondD = bestD; bestD = d; best = k; }
      else if (d < secondD) secondD = d;
    }
    return (bestD <= 3 && secondD > bestD) ? best : null;
  }

  function decodeDataUri(src) {
    const comma = src.indexOf(',');
    if (comma < 0) return src;
    const payload = src.slice(comma + 1);
    let svg;
    try { svg = src.slice(0, comma).indexOf(';base64') >= 0 ? atob(payload) : payload; }
    catch (e) { svg = payload; }
    return svg.replace(/%23/gi, '#'); // '#rrggbb' ada di URL-encoded sebagai %23rrggbb
  }

  async function upgradeFbSummaryIcons(root) {
    root.querySelectorAll('[role="button"][aria-label]').forEach(async (btn) => {
      const label = btn.getAttribute('aria-label') || '';
      if (!/react|reaksi|reagi/i.test(label)) return;
      if (reactionKeyFromStateLabel(label)) return; // "Remove/Change X reaction" -> fungsi 1e
      btn.querySelectorAll('img[src^="data:image/svg"]').forEach(async (img) => {
        if (img.dataset.hdFb || img.dataset.hd || img.dataset.hdState ||
            img.dataset.hdAct || img.dataset.hdSum) return;
        const key = fbReactionKey(decodeDataUri(img.getAttribute('src') || ''));
        if (DEBUG && !key) console.log('[fb-hd] signature ringkasan tak dikenal:', label);
        if (!key) return;
        const uri = key === 'like' ? LIKE_SVG : await loadSvg(key);
        if (!uri) return;
        watch(img);
        img.dataset.hdFb = key;
        if (img.getAttribute('src') === uri) return;
        img.removeAttribute('srcset');
        img.setAttribute('src', uri);
      });
    });
  }

  // ===== 2. Emoji (PNG -> Twemoji SVG) =====
  function twemojiName(ch) {
    const s = ch.includes('\u200d') ? ch : ch.replace(/\uFE0F/g, '');
    return [...s].map((c) => c.codePointAt(0).toString(16)).join('-');
  }
  async function upgradeEmojiImg(img) {
    if (img.dataset.hd || img.dataset.hdDone) return;
    if (!img.alt) { img.dataset.hdDone = '1'; return; }
    img.dataset.hd = '1';
    const uri = await loadSvg(twemojiName(img.alt));
    if (uri) { img.removeAttribute('srcset'); img.src = uri; }
    img.dataset.hdDone = '1';
  }

  // ===== 2b. Emoji di kolom input (editor Lexical: span dengan background-image) =====
  // Teks emoji asli tetap ada di dalam span (editor tidak disentuh), hanya gambar latarnya diganti.
  async function upgradeEmojiBg(el) {
    const bg = el.style.backgroundImage || '';
    const ok = bg.startsWith('url("data:');
    // Lexical bisa me-reset background-size jadi "16px 16px" (tanpa !important) -> cek juga ukuran & jarak
    const styled = ok &&
      el.style.getPropertyPriority('background-size') === 'important' &&
      el.style.getPropertyPriority('margin-left') === 'important';
    if (el.dataset.hdBg === 'pending' || el.dataset.hdBg === 'fail') return;
    if (el.dataset.hdBg === 'ok' && styled) return;
    if (!ok && !/emoji\.php/.test(bg)) return;
    const ch = (el.textContent || '').trim();
    if (!ch) { el.dataset.hdDone = '1'; return; }
    el.dataset.hdBg = 'pending';
    const uri = ok ? bg.slice(5, -2) : await loadSvg(twemojiName(ch));
    if (!uri) { el.dataset.hdBg = 'fail'; el.dataset.hdDone = '1'; return; }
    watch(el);
    if (!ok) setImp(el, 'background-image', `url("${uri}")`);
    // Twemoji full-bleed (tanpa padding transparan seperti PNG Facebook): kecilkan + beri jarak antar emoji
    setImp(el, 'background-size', EMOJI_INPUT_SCALE);
    setImp(el, 'background-position', 'center');
    setImp(el, 'background-repeat', 'no-repeat');
    setImp(el, 'margin-left', EMOJI_INPUT_GAP);
    setImp(el, 'margin-right', EMOJI_INPUT_GAP);
    el.dataset.hdBg = 'ok';
    el.dataset.hdDone = '1';
  }

  // ===== 3. Reaction picker (hover Like) =====
  // Satu "host" per reaction: semua isi lama di dalam host disembunyikan lewat CSS
  // (tahan terhadap re-render React), lalu SVG ditaruh sebagai overlay di host itu.
  const OVERLAY = 'img[data-hd-react]';
  const HOST = '[data-hd-react-host]';
  const MEDIA_SEL = 'video, img, canvas, [style*="blob:"]';

  function makeOverlay(uri) {
    const img = document.createElement('img');
    img.dataset.hdReact = '1';
    img.alt = '';
    img.draggable = false;
    img.src = uri;
    img.style.cssText =
      'position:absolute!important;inset:0!important;width:100%!important;height:100%!important;' +
      'object-fit:contain!important;pointer-events:none!important;visibility:visible!important;';
    return img;
  }

  const hostBusy = (el) => el.matches(HOST) || el.closest(HOST) || el.querySelector(HOST);

  async function mountOverlay(host, key) {
    if (hostBusy(host)) return;
    host.dataset.hdReactHost = key; // reservasi sinkron (cegah duplikat)
    const uri = key === 'like' ? LIKE_SVG : await loadSvg(key);
    if (!uri) { delete host.dataset.hdReactHost; return; }
    if (host.querySelector(OVERLAY)) return;
    if (getComputedStyle(host).position === 'static') setImp(host, 'position', 'relative');
    host.appendChild(makeOverlay(uri));
  }

  // Kalau React membuang overlay, lepas penanda supaya dideteksi & dipasang ulang
  function repairHosts() {
    document.querySelectorAll(HOST).forEach((h) => {
      if (!h.querySelector(OVERLAY)) delete h.dataset.hdReactHost;
    });
  }

  function keyFromLabel(el) {
    for (let n = el, i = 0; n && i < 8; n = n.parentElement, i++) {
      const l = n.getAttribute && n.getAttribute('aria-label');
      if (!l) continue;
      const h = reactionOf(l);
      if (h) return { key: h[1], el: n };
    }
    return null;
  }

  // Cari pembungkus terkecil yang hanya berisi SATU reaction
  function hostFor(m) {
    const replaced = m.tagName === 'IMG' || m.tagName === 'VIDEO' || m.tagName === 'CANVAS';
    let host = replaced ? m.parentElement : m;
    for (let i = 0; i < 3 && host && host.parentElement; i++) {
      const par = host.parentElement;
      if (par.querySelectorAll(MEDIA_SEL).length > 1 || par.offsetWidth > 120 || par.textContent.trim()) break;
      host = par;
    }
    return host;
  }

  // Naik ke pembungkus yang hanya berisi SATU reaction berlabel (supaya animasi hover /
  // varian "terpilih" yang bersaudara dengan ikon statis ikut tercakup dalam host)
  function climbHost(el) {
    let host = el;
    for (let i = 0; i < 3; i++) {
      const par = host.parentElement;
      if (!par || par.offsetWidth > 140 || par.textContent.trim()) break;
      let n = 0;
      par.querySelectorAll('[aria-label]').forEach((x) => { if (reactionOf(x.getAttribute('aria-label'))) n++; });
      if (n !== 1) break;
      host = par;
    }
    return host;
  }

  const sizeOk = (el) => el.offsetWidth >= 20 && el.offsetWidth <= 100;
  const hasBlobBg = (el) => /blob:/.test((el.style && el.style.backgroundImage) || '');

  function upgradeReactionMedia(root) {
    const cands = [];
    root.querySelectorAll(MEDIA_SEL).forEach((m) => {
      if (!m.offsetWidth || !sizeOk(m) || m.closest(HOST)) return;
      const tag = m.tagName;
      const isBlob = tag === 'CANVAS' ||
        ((tag === 'VIDEO' || tag === 'IMG') && (m.currentSrc || m.src || '').startsWith('blob:')) ||
        hasBlobBg(m);
      if (isBlob) cands.push(m);
    });
    const unlabeled = [];
    cands.forEach((m) => {
      const lab = keyFromLabel(m);
      if (lab) mountOverlay(climbHost(lab.el), lab.key);
      else if (m.tagName !== 'CANVAS') unlabeled.push(m);
    });
    if (DEBUG && cands.length) console.log('[fb-hd] reaction kandidat:', cands.length, 'tanpa label:', unlabeled.length, cands);
    if (unlabeled.length === 7 || unlabeled.length === 6) {
      const order = unlabeled.length === 7 ? REACTION_ORDER : REACTION_ORDER.filter((k) => k !== '1f970');
      unlabeled.forEach((m, i) => mountOverlay(hostFor(m), order[i]));
    }
  }

  // Item berlabel reaction (sprite / background / img / svg / video apa pun di dalamnya)
  const ICON_SEL = 'img, video, canvas, i, svg, [style*="background-image"]';
  function upgradeReactionPicker(root) {
    root.querySelectorAll('[aria-label]').forEach((item) => {
      const label = item.getAttribute('aria-label');
      if (!label || label.length > 20) return;
      if (item.querySelector('[data-ad-rendering-role]')) return;   // tombol aksi post
      if (reactionKeyFromStateLabel(label)) return;                 // "Remove/Change X reaction" -> fungsi 1e
      const hit = reactionOf(label);
      if (!hit) return;
      const w = item.offsetWidth;
      if (w < 20 || w > 140) return;
      if (!item.querySelector(ICON_SEL)) return;                    // teks saja (mis. "Like" di komentar)
      mountOverlay(climbHost(item), hit[1]);
    });
  }

  // <img alt="Love"> kecil dimana pun (mis. item reaction yang sedang terpilih di picker)
  const ALT_RE = /^(like|love|care|haha|wow|sad|angry|suka|super|peduli|sedih|marah)$/i;
  function upgradeAltReactionImgs(root) {
    root.querySelectorAll('img[alt]').forEach((img) => {
      if (!ALT_RE.test((img.getAttribute('alt') || '').trim())) return;
      const w = img.offsetWidth || img.width;
      if (w > 80) return;
      applyActiveImg(img);
    });
  }

  // ===== 3c. Ikon ringkasan reaction ("Like: 2 people", dst.) =====
  const SUMMARY_RE = /^(like|love|care|haha|wow|sad|angry|suka|super|peduli|sedih|marah)\s*:/i;
  async function upgradeSummaryIcons(root) {
    root.querySelectorAll('[role="button"][aria-label]').forEach(async (btn) => {
      const label = btn.getAttribute('aria-label');
      if (!SUMMARY_RE.test(label)) return;
      const img = btn.querySelector('img');
      if (!img || img.width > 32) return;
      const name = label.split(':')[0].trim();
      const hit = REACTIONS.find(([re]) => re.test(name));
      if (!hit) return;
      const key = hit[1];
      const uri = key === 'like' ? LIKE_SVG : await loadSvg(key);
      if (!uri) return;
      watch(img);
      if (img.dataset.hdSum === key && img.getAttribute('src') === uri) return;
      img.removeAttribute('srcset');
      img.setAttribute('src', uri);
      img.dataset.hdSum = key;
    });
  }

  // ===== 4. Ikon sidebar kiri =====
  async function upgradeSidebarIcons(root) {
    const links = root.querySelectorAll('a[role="link"][href]');
    for (const a of links) {
      const media = a.querySelector('i[data-visualcompletion="css-img"], img');
      if (!media) continue;
      const href = a.getAttribute('href');
      const hit = SIDEBAR_ICONS.find(([re]) => re.test(href));
      if (!hit) continue;
      const w = media.offsetWidth;
      if (w > 0 && (w < 30 || w > 48)) { media.dataset.hdSide = 'skip'; continue; }
      const key = hit[1];
      const ok = media.tagName === 'IMG'
        ? (media.src || '').startsWith('data:')
        : (media.style.backgroundImage || '').startsWith('url("data:');
      if (media.dataset.hdSide === key && ok) continue;
      const uri = key === 'metaai' ? META_AI_SVG : await loadSvg(key);
      if (!uri) { media.dataset.hdSide = 'skip'; continue; }
      media.dataset.hdSide = key;
      watch(media);
      if (media.tagName === 'IMG') {
        media.removeAttribute('srcset');
        media.src = uri;
      } else {
        setImp(media, 'background-image', `url("${uri}")`);
        setImp(media, 'background-size', 'contain');
        setImp(media, 'background-position', 'center');
        setImp(media, 'background-repeat', 'no-repeat');
      }
    }
  }

  // ===== Runner (sinkron di dalam MutationObserver -> jalan sebelum browser menggambar) =====
  function run(root) {
    upgradeActionIcons(root);
    upgradeComposerIcons(root);
    upgradeCreatePostIcons(root);
    upgradeAvatarRes(root);
    upgradeReactionStateButtons(root);
    upgradeFbSummaryIcons(root);
    upgradeSidebarIcons(root);
    upgradeSummaryIcons(root);
    upgradeAltReactionImgs(root);
    root.querySelectorAll('img[src*="emoji.php"]').forEach(upgradeEmojiImg);
    root.querySelectorAll('[data-testid="emoji"]').forEach(upgradeEmojiBg);
    if (REACTION_PICKER_HD) { repairHosts(); upgradeReactionMedia(root); upgradeReactionPicker(root); }
  }

  const root0 = document.documentElement;
  const observer = new MutationObserver((muts) => {
    const roots = new Set();
    for (const m of muts) {
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => { if (n.nodeType === 1) roots.add(n.parentElement || n); });
      } else if (m.target && m.target.nodeType === 1) {
        roots.add(m.target.parentElement || m.target);
      }
      if (roots.size > 60) { roots.clear(); roots.add(root0); break; } // terlalu banyak -> satu pass penuh
    }
    roots.forEach(run);
  });
  observer.observe(root0, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label'] // deteksi status like/unlike
  });

  // Angkat (z-index) item yang sedang di-hover beserta pembungkusnya sampai wadah picker,
  // supaya emoji yang membesar tidak tertindih emoji tetangga yang berada di stacking context lain.
  let lifted = [];
  const unlift = () => { lifted.forEach((el) => el.removeAttribute('data-hd-lift')); lifted = []; };
  document.addEventListener('mouseover', (e) => {
    const host = e.target && e.target.closest && e.target.closest(HOST);
    if (!host) { if (lifted.length) unlift(); return; }
    if (lifted[0] === host) return;
    unlift();
    let n = host;
    for (let i = 0; i < 8 && n && n !== document.body; i++) {
      if (i > 0 && n.querySelectorAll(HOST).length >= 3) break; // sudah mencapai wadah picker
      n.setAttribute('data-hd-lift', '1');
      lifted.push(n);
      n = n.parentElement;
    }
  }, { capture: true, passive: true });

  // ===== Alat bantu diagnosa: Ctrl+Shift+H = salin struktur elemen di bawah kursor =====
  // Hover tombol Like sampai picker muncul, JANGAN gerakkan mouse, lalu tekan Ctrl+Shift+H.
  let mx = 0, my = 0;
  document.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; }, { capture: true, passive: true });
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && e.code === 'KeyH')) return;
    const start = document.elementsFromPoint(mx, my)[0];
    if (!start) return;
    let box = start;
    for (let i = 0; i < 12 && box.parentElement; i++) {
      let n = 0;
      box.querySelectorAll('[aria-label]').forEach((x) => { if (reactionOf(x.getAttribute('aria-label') || '')) n++; });
      if (n >= 5) break;
      box = box.parentElement;
    }
    const clone = box.cloneNode(true);
    [clone, ...clone.querySelectorAll('*')].forEach((n) => {
      n.removeAttribute('class');
      [...n.attributes].forEach((a) => { if (a.value.length > 90) n.setAttribute(a.name, a.value.slice(0, 60) + '...[dipotong]'); });
    });
    const text = clone.outerHTML;
    try { GM_setClipboard(text); } catch (err) {}
    console.log('[fb-hd] struktur picker:', text);
    const t = document.createElement('div');
    t.textContent = 'FB HD: struktur disalin (' + text.length + ' karakter). Tempel ke chat.';
    t.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#111;color:#fff;padding:8px 14px;border-radius:8px;font:13px sans-serif;';
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }, true);

  // Preload prioritas: sidebar + reaction diantar duluan lewat antrean (paralel dibatasi)
  SIDEBAR_ICONS.forEach(([, k]) => { if (k !== 'metaai') preloadSvg(k); });
  REACTION_ORDER.forEach((k) => { if (k !== 'like') preloadSvg(k); });

  // Sisanya (seluruh set Twemoji) diunduh di latar belakang setelah Facebook selesai dimuat,
  // supaya saat interaksi (hover picker, scroll, kolom komentar) tidak ada yang masih menunggu load.
  if (PRELOAD_ALL_EMOJI) {
    const go = () => setTimeout(startPreload, 1000);
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
  }

  // Jaring pengaman: pass penuh saat DOM siap dan berkala
  run(root0);
  document.addEventListener('DOMContentLoaded', () => run(document.documentElement));
  window.addEventListener('load', () => run(document.documentElement));
  setInterval(() => run(document.documentElement), 2000);
})();