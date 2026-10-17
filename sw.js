/* Kumamon 記帳 — Service Worker
 * 策略：App Shell 預快取 + CDN Cache First；同源 Network First
 * 記帳資料在 localStorage，離線可正常使用
 */
const CACHE_VERSION = 'kumamon-v3';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const CDN_CACHE = CACHE_VERSION + '-cdn';

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const CDN_URLS = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await Promise.allSettled(
      SHELL_URLS.map((url) => shell.add(url).catch((e) => console.warn('[SW] shell skip', url, e)))
    );
    const cdn = await caches.open(CDN_CACHE);
    await Promise.allSettled(
      CDN_URLS.map((url) => cdn.add(url).catch((e) => console.warn('[SW] cdn skip', url, e)))
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('kumamon-') && k !== SHELL_CACHE && k !== CDN_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isCDN(url) {
  return (
    url.hostname === 'cdn.tailwindcss.com' ||
    url.hostname === 'unpkg.com' ||
    url.hostname.endsWith('.unpkg.com')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // CDN：Cache First
  if (isCDN(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return hit || Response.error();
      }
    })());
    return;
  }

  // 同源
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const isSW = url.pathname.endsWith('sw.js');

      if (isSW) {
        try {
          return await fetch(req);
        } catch {
          return (await cache.match(req)) || Response.error();
        }
      }

      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit =
          (await cache.match(req)) ||
          (await cache.match('./index.html')) ||
          (await cache.match('./'));
        if (hit) return hit;
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>離線</title></head><body style="font-family:system-ui;padding:2rem;text-align:center;color:#333"><h1>目前離線</h1><p>請連上網路後重新整理。</p></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
