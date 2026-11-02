/* Kumamon 記帳 Service Worker
 * 策略：App 外殼 cache-first + 資料／API 分層 fallback
 * - 同源靜態／導航：cache-first，離線必回 index 或內建 offline 頁
 * - 執行期 CDN（React／Babel／Tailwind／supabase-js UMD）：視為外殼依賴，cache-first
 * - Supabase REST／Auth／Realtime API：不攔截、不快取
 * - 其他第三方：直接放行
 */
const APP_SHELL_CACHE = 'kumamon-shell-v6';
const IMAGE_CACHE = 'kumamon-images-v1';
const IMAGE_CACHE_LIMIT = 200;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

/** 本 App 執行期必需的 CDN（等同外殼依賴；首次 online 安裝後才可離線） */
const RUNTIME_CDN = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kumamon 記帳 · 離線</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#18181b;padding:24px}
    .card{max-width:360px;background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:24px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    h1{font-size:18px;margin:0 0 8px}
    p{font-size:14px;line-height:1.5;color:#52525b;margin:0 0 12px}
    button{appearance:none;border:0;border-radius:10px;background:#18181b;color:#fff;padding:10px 14px;font-size:14px;font-weight:600}
  </style>
</head>
<body>
  <div class="card">
    <h1>目前離線，且尚未快取 App</h1>
    <p>請先連上網路開啟一次 Kumamon 記帳，讓外殼與必要腳本寫入快取後，之後斷網也能開啟本機帳本。</p>
    <button type="button" onclick="location.reload()">重試</button>
  </div>
</body>
</html>`;

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isNavigationRequest(req) {
  return req.mode === 'navigate' ||
    (req.method === 'GET' && req.headers.get('accept') && req.headers.get('accept').includes('text/html'));
}

function isRuntimeCdn(url) {
  const href = url.href;
  return RUNTIME_CDN.some((u) => href === u || href.startsWith(u + '?') || href.startsWith(u + '/')) ||
    href.includes('cdn.tailwindcss.com') ||
    (href.includes('unpkg.com/react@') || href.includes('unpkg.com/react-dom@') || href.includes('unpkg.com/@babel/')) ||
    href.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js');
}

/** Supabase 後端 API／Realtime／Auth：絕不攔截 */
function isSupabaseApi(url) {
  const host = url.hostname;
  return host.endsWith('.supabase.co') ||
    host.endsWith('.supabase.in') ||
    host.includes('supabase.co') && (
      url.pathname.startsWith('/rest/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/realtime/') ||
      url.pathname.startsWith('/storage/') ||
      url.pathname.startsWith('/functions/')
    );
}

function isImageRequest(req, url) {
  if (req.destination === 'image') return true;
  return /\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|$)/i.test(url.pathname);
}

function isJsonList(url) {
  return /\.json(\?|$)/i.test(url.pathname) && isSameOrigin(url) && !url.pathname.endsWith('manifest.json');
}

function hasAuthHeader(req) {
  return req.headers.has('Authorization') || req.headers.has('authorization');
}

async function trimImageCache() {
  const cache = await caches.open(IMAGE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= IMAGE_CACHE_LIMIT) return;
  const overflow = keys.length - IMAGE_CACHE_LIMIT;
  for (let i = 0; i < overflow; i++) {
    await cache.delete(keys[i]); // FIFO
  }
}

async function shellFallback() {
  const cache = await caches.open(APP_SHELL_CACHE);
  const hit =
    (await cache.match('./index.html', { ignoreSearch: true })) ||
    (await cache.match('/index.html', { ignoreSearch: true })) ||
    (await cache.match('./', { ignoreSearch: true })) ||
    (await cache.match(self.registration.scope, { ignoreSearch: true }));
  if (hit) return hit;
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    await cache.addAll(PRECACHE);
    await Promise.allSettled(
      RUNTIME_CDN.map(async (u) => {
        try {
          const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
          if (res.ok) await cache.put(u, res.clone());
        } catch (_) {}
      })
    );
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (hasAuthHeader(req)) return;

  const url = new URL(req.url);

  if (isSupabaseApi(url)) return;

  // 導航：cache-first → 背景更新 → 內建 offline HTML
  if (isNavigationRequest(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      const cached =
        (await cache.match('./index.html', { ignoreSearch: true })) ||
        (await cache.match(req, { ignoreSearch: true }));
      if (cached) {
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(req);
            if (fresh && fresh.ok) await cache.put('./index.html', fresh.clone());
          } catch (_) {}
        })());
        return cached;
      }
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) await cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        return shellFallback();
      }
    })());
    return;
  }

  // 執行期 CDN：cache-first（外殼依賴）
  if (isRuntimeCdn(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      const hit = await cache.match(req) || await cache.match(url.href);
      if (hit) {
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(req, { mode: 'cors', credentials: 'omit' });
            if (fresh && fresh.ok) await cache.put(req, fresh.clone());
          } catch (_) {}
        })());
        return hit;
      }
      try {
        const fresh = await fetch(req, { mode: 'cors', credentials: 'omit' });
        if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        return new Response('', { status: 503, statusText: 'CDN offline' });
      }
    })());
    return;
  }

  // 其他第三方：不攔截
  if (!isSameOrigin(url)) return;

  // 同源 JSON 清單：network-first + cache
  if (isJsonList(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        return fresh;
      } catch (_) {
        const hit = await cache.match(req);
        if (hit) return hit;
        return new Response(JSON.stringify({ error: 'offline', items: [] }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  // 同源圖片：獨立 cache + 200 筆 FIFO
  if (isImageRequest(req, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(IMAGE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          await cache.put(req, fresh.clone());
          trimImageCache().catch(() => {});
        }
        return fresh;
      } catch (_) {
        const empty = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
        return new Response(empty, { status: 503, headers: { 'Content-Type': 'image/gif' } });
      }
    })());
    return;
  }

  // 其餘同源靜態：cache-first
  event.respondWith((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    const hit = await cache.match(req);
    if (hit) {
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        } catch (_) {}
      })());
      return hit;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      if (req.headers.get('accept') && req.headers.get('accept').includes('text/html')) {
        return shellFallback();
      }
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
