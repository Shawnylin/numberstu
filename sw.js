// Bump this version whenever an app-shell file changes. Each version is cached
// together so a new HTML file never runs against scripts from an older release.
const VERSION = 'v2-20261012.2';
const SCOPE = self.registration.scope;
const PREFIX = `baihuafen-${new URL(SCOPE).pathname.replace(/[^a-z0-9]/gi, '_')}-`;
const CACHE = `${PREFIX}${VERSION}`;
const LEGACY = 'baihuafen-v1';
const INDEX = new URL('index.html', SCOPE).href;
const ASSETS = ['index.html', 'styles.css', 'app.js', 'training.js', 'manifest.webmanifest',
  'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'].map(path => new URL(path, SCOPE).href);
const assetSet = new Set(ASSETS);

async function hasLegacyCache() {
  if (!(await caches.keys()).includes(LEGACY)) return false;
  const cache = await caches.open(LEGACY);
  return Boolean(await cache.match(INDEX) || await cache.match(SCOPE));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
      // v1 had no update UI and served stale HTML forever. Adopt this release
      // automatically for v1; later releases wait for the user's update button.
      if (await hasLegacyCache()) await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const legacy = await hasLegacyCache();
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE || key === LEGACY && legacy)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== new URL(SCOPE).origin) return;
  url.search = '';
  url.hash = '';
  const key = url.href === SCOPE ? INDEX : url.href;
  if (!assetSet.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;
    try { return await fetch(event.request); }
    catch { return new Response('离线资源暂未准备好，请联网后重新打开。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});
