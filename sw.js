/* Kumamon 記帳 Service Worker v7
 * App 外殼 cache-first + API 不攔截
 * 修正：PRECACHE 非原子、導航不依賴 waitUntil 背景更新、
 *       offline 頁 200、HTML 非 navigate、SKIP_WAITING listener
 */
const APP_SHELL_CACHE = 'kumamon-shell-v8';
const IMAGE_CACHE = 'kumamon-images-v1';
const IMAGE_CACHE_LIMIT = 200;

/** 外殼資源（逐項 allSettled，避免單一 404 讓整次 install 失敗） */
const PRECACHE = [
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

/** 執行期必需 CDN＝外殼依賴（首次 online 成功後才可離線跑 React） */
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
  return req.mode === 'navigate';
}

/** 導航或明確要 HTML 的 GET（含匯出備份檔被當普通 GET） */
function isHtmlShellRequest(req, url) {
  if (isNavigationRequest(req)) return true;
  if (req.method !== 'GET') return false;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  if (isSameOrigin(url) && /\.html?$/i.test(url.pathname)) return true;
  // 目錄根路徑常當 HTML 入口
  if (isSameOrigin(url) && (url.pathname === '/' || url.pathname.endsWith('/'))) return true;
  return false;
}

function isRuntimeCdn(url) {
  const href = url.href;
  if (RUNTIME_CDN.some((u) => href === u || href.startsWith(u + '?') || href.startsWith(u + '/'))) {
    return true;
  }
  // 寬鬆匹配，避免 query/redirect 變體漏網
  if (href.includes('cdn.tailwindcss.com')) return true;
  if (href.includes('unpkg.com/react@') || href.includes('unpkg.com/react-dom@')) return true;
  if (href.includes('unpkg.com/@babel/standalone')) return true;
  if (href.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js')) return true;
  return false;
}

/** Supabase 後端：不攔截、不快取 */
function isSupabaseApi(url) {
  const host = url.hostname;
  if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) return true;
  // 其他 supabase 子域且路徑像 API
  if (host.includes('supabase')) {
    const p = url.pathname;
    if (
      p.startsWith('/rest/') ||
      p.startsWith('/auth/') ||
      p.startsWith('/realtime/') ||
      p.startsWith('/storage/') ||
      p.startsWith('/functions/')
    ) {
      return true;
    }
  }
  return false;
}

function isImageRequest(req, url) {
  if (req.destination === 'image') return true;
  return /\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|$)/i.test(url.pathname);
}

function isJsonList(url) {
  return (
    isSameOrigin(url) &&
    /\.json(\?|$)/i.test(url.pathname) &&
    !url.pathname.endsWith('manifest.json')
  );
}

function hasAuthHeader(req) {
  return req.headers.has('Authorization') || req.headers.has('authorization');
}

async function matchShellHtml(cache) {
  return (
    (await cache.match('./index.html', { ignoreSearch: true })) ||
    (await cache.match('/index.html', { ignoreSearch: true })) ||
    (await cache.match('index.html', { ignoreSearch: true })) ||
    (await cache.match('./', { ignoreSearch: true })) ||
    (await cache.match(self.registration.scope, { ignoreSearch: true }))
  );
}

async function shellFallback() {
  try {
    const cache = await caches.open(APP_SHELL_CACHE);
    const hit = await matchShellHtml(cache);
    if (hit) return hit;
  } catch (_) {}
  // 200：避免部分 WebView／PWA 殼把 5xx 當錯誤頁
  return new Response(OFFLINE_HTML, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/** 盡力寫入單一 URL；失敗不丟錯 */
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

async function tryCacheCdn(cache, url) {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'reload' });
    if (res && res.ok) {
      // 同時用字串 key 與 Request，提高 match 命中率
      await cache.put(url, res.clone());
      await cache.put(new Request(url, { mode: 'cors', credentials: 'omit' }), res.clone());
      return true;
    }
  } catch (_) {}
  return false;
}

async function trimImageCache() {
  try {
    const cache = await caches.open(IMAGE_CACHE);
    const keys = await cache.keys();
    if (keys.length <= IMAGE_CACHE_LIMIT) return;
    // 規格未保證 keys() 為插入序；此為 best-effort 淘汰，非嚴格 FIFO
    const overflow = keys.length - IMAGE_CACHE_LIMIT;
    for (let i = 0; i < overflow; i++) {
      await cache.delete(keys[i]);
    }
  } catch (_) {}
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);

    // 1) 優先確保 index.html（離線開啟的最低門檻）
    await tryCacheAdd(cache, './index.html');

    // 2) 其餘外殼：allSettled，單一 404 不拖垮 install
    await Promise.allSettled(PRECACHE.map((u) => tryCacheAdd(cache, u)));

    // 3) CDN：失敗不阻 install（但白屏風險仍在，靠首次線上造訪補齊）
    await Promise.allSettled(RUNTIME_CDN.map((u) => tryCacheCdn(cache, u)));

    // 立即接管：記帳 App 需要新 SW 盡快生效以修復離線
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

// 與頁面 reg.waiting.postMessage({ type: 'SKIP_WAITING' }) 對齊
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

  // API 直接放行
  if (isSupabaseApi(url)) return;

  // HTML 外殼（navigate + 非 navigate 的 HTML GET）：純 cache-first，不背景 waitUntil
  if (isHtmlShellRequest(req, url)) {
    event.respondWith((async () => {
      try {
        const cache = await caches.open(APP_SHELL_CACHE);
        const cached = await matchShellHtml(cache);
        if (cached) return cached;

        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            await cache.put('./index.html', fresh.clone());
            // 若請求本身是某 .html，也存一份
            if (isSameOrigin(url)) {
              try { await cache.put(req, fresh.clone()); } catch (_) {}
            }
          }
          return fresh;
        } catch (_) {
          return shellFallback();
        }
      } catch (_) {
        return shellFallback();
      }
    })());
    return;
  }

  // 執行期 CDN：cache-first
  if (isRuntimeCdn(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      const hit =
        (await cache.match(req)) ||
        (await cache.match(url.href)) ||
        (await cache.match(new Request(url.href, { mode: 'cors', credentials: 'omit' })));
      if (hit) return hit;

      try {
        const fresh = await fetch(req, { mode: 'cors', credentials: 'omit' });
        if (fresh && fresh.ok) {
          await cache.put(req, fresh.clone());
          await cache.put(url.href, fresh.clone());
        }
        return fresh;
      } catch (_) {
        return new Response(
          '/* offline: CDN not cached. Open the app once online. */',
          { status: 503, headers: { 'Content-Type': 'application/javascript' } }
        );
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
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  // 同源圖片：獨立 cache + 上限（best-effort 淘汰）
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

  // 其餘同源靜態：cache-first
  event.respondWith((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      if (isHtmlShellRequest(req, url)) return shellFallback();
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
