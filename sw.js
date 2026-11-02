/* Kumamon 記帳 Service Worker v9
 * 只處理同源資源。React / Babel / Tailwind / supabase-js 已改本地 ./vendor/
 * 不再攔截、不快取任何跨域 CDN（避免 Safari CORS / opaque / 錯誤 503 搞亂腳本）
 */
const APP_SHELL_CACHE = 'kumamon-shell-v9';
const IMAGE_CACHE = 'kumamon-images-v1';
const IMAGE_CACHE_LIMIT = 200;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './vendor/tailwindcss.js',
  './vendor/react.production.min.js',
  './vendor/react-dom.production.min.js',
  './vendor/babel.min.js',
  './vendor/supabase.min.js'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kumamon 記帳 · 離線</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#18181b;padding:24px}
    .card{max-width:360px;background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:24px}
    h1{font-size:18px;margin:0 0 8px}
    p{font-size:14px;line-height:1.5;color:#52525b;margin:0 0 12px}
    button{appearance:none;border:0;border-radius:10px;background:#18181b;color:#fff;padding:10px 14px;font-size:14px;font-weight:600}
  </style>
</head>
<body>
  <div class="card">
    <h1>目前離線，且尚未快取 App</h1>
    <p>請先連上網路開啟一次，讓外殼寫入快取後，斷網亦可使用本機帳本。</p>
    <button type="button" onclick="location.reload()">重試</button>
  </div>
</body>
</html>`;

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isHtmlShellRequest(req, url) {
  if (req.mode === 'navigate') return true;
  if (req.method !== 'GET') return false;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  if (isSameOrigin(url) && (/\.html?$/i.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('/'))) {
    return true;
  }
  return false;
}

function isImageRequest(req, url) {
  if (req.destination === 'image') return true;
  return /\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|$)/i.test(url.pathname);
}

function hasAuthHeader(req) {
  return req.headers.has('Authorization') || req.headers.has('authorization');
}

async function matchShellHtml(cache) {
  return (
    (await cache.match('./index.html', { ignoreSearch: true })) ||
    (await cache.match('/index.html', { ignoreSearch: true })) ||
    (await cache.match('index.html', { ignoreSearch: true })) ||
    (await cache.match('./', { ignoreSearch: true }))
  );
}

async function shellFallback() {
  try {
    const cache = await caches.open(APP_SHELL_CACHE);
    const hit = await matchShellHtml(cache);
    if (hit) return hit;
  } catch (_) {}
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function tryCacheAdd(cache, url) {
  try {
    const res = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
    if (res && res.ok) {
      await cache.put(url, res.clone());
      return true;
    }
  } catch (_) {}
  try {
    await cache.add(url);
    return true;
  } catch (_) {}
  return false;
}

async function trimImageCache() {
  try {
    const cache = await caches.open(IMAGE_CACHE);
    const keys = await cache.keys();
    if (keys.length <= IMAGE_CACHE_LIMIT) return;
    const overflow = keys.length - IMAGE_CACHE_LIMIT;
    for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
  } catch (_) {}
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    await tryCacheAdd(cache, './index.html');
    await Promise.allSettled(PRECACHE.map((u) => tryCacheAdd(cache, u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_SHELL_CACHE, IMAGE_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (hasAuthHeader(req)) return;

  const url = new URL(req.url);

  // 跨域一律不攔截
  if (!isSameOrigin(url)) return;

  // HTML：有網 network-first，失敗用 cache
  if (isHtmlShellRequest(req, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const fresh = await fetch(req, { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        if (fresh && fresh.ok) {
          try {
            await cache.put('./index.html', fresh.clone());
            await cache.put(req, fresh.clone());
          } catch (_) {}
          return fresh;
        }
      } catch (_) {}
      const cached = await matchShellHtml(cache);
      if (cached) return cached;
      return shellFallback();
    })());
    return;
  }

  if (isImageRequest(req, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(IMAGE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          await cache.put(req, fresh.clone());
          trimImageCache();
        }
        return fresh;
      } catch (_) {
        const empty = Uint8Array.from(
          atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
          (c) => c.charCodeAt(0)
        );
        return new Response(empty, { status: 200, headers: { 'Content-Type': 'image/gif' } });
      }
    })());
    return;
  }

  // 其餘同源（vendor JS、manifest、icon）：cache-first
  event.respondWith((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
