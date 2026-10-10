import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, access } from 'node:fs/promises';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const scope = 'https://example.org/numberstu/';

function worker({ legacy = false, failInstall = false } = {}) {
  const handlers = new Map();
  const stores = new Map();
  const state = { skipped: false, claimed: false, network: 0 };
  function store(key) {
    if (!stores.has(key)) stores.set(key, new Map());
    const entries = stores.get(key);
    return { match: async request => entries.get(typeof request === 'string' ? request : request.url),
      addAll: async requests => {
        if (failInstall) throw new Error('offline');
        for (const request of requests) entries.set(request.url, new Response(request.url));
      } };
  }
  if (legacy) stores.set('baihuafen-v1', new Map([[scope, new Response('v1')]]));
  stores.set('unrelated-cache', new Map());
  stores.set('baihuafen-_other_-v1', new Map());
  stores.set('baihuafen-_numberstu_-old', new Map());
  const caches = { open: async key => store(key), keys: async () => [...stores.keys()], delete: async key => stores.delete(key) };
  const self = { registration: { scope }, addEventListener: (name, callback) => handlers.set(name, callback),
    skipWaiting: async () => { state.skipped = true; }, clients: { claim: async () => { state.claimed = true; } } };
  vm.runInNewContext(source, { self, caches, URL, Request, Response, fetch: async () => { state.network++; throw new Error('offline'); } });
  async function event(name, data = {}) {
    let work;
    let response;
    handlers.get(name)({ ...data, waitUntil: promise => { work = promise; }, respondWith: promise => { response = promise; } });
    if (work) await work;
    return response ? await response : null;
  }
  return { state, stores, event };
}

test('precache includes every runtime asset and those files exist', async () => {
  const fake = worker();
  await fake.event('install');
  const cache = [...fake.stores.values()].find(entries => entries.has(`${scope}app.js`));
  assert.equal(cache.size, 8);
  for (const url of cache.keys()) await access(new URL(`../${url.slice(scope.length)}`, import.meta.url));
  assert.equal(fake.state.skipped, false);
});

test('offline root, index and query strings use a consistent cached shell', async () => {
  const fake = worker();
  await fake.event('install');
  await fake.event('activate');
  for (const url of [scope, `${scope}?source=installed`, `${scope}index.html`, `${scope}training.js?v=2`]) {
    const response = await fake.event('fetch', { request: new Request(url) });
    assert.equal(response.status, 200);
  }
  assert.equal(fake.state.network, 0);
  assert.equal(fake.state.claimed, true);
});

test('activation removes only this scope’s old caches and upgrades legacy v1 automatically', async () => {
  const fake = worker({ legacy: true });
  await fake.event('install');
  assert.equal(fake.state.skipped, true);
  await fake.event('activate');
  assert.ok(!fake.stores.has('baihuafen-v1'));
  assert.ok(!fake.stores.has('baihuafen-_numberstu_-old'));
  assert.ok(fake.stores.has('unrelated-cache'));
  assert.ok(fake.stores.has('baihuafen-_other_-v1'));
});

test('POST, third-party and non-shell requests are left to the network', async () => {
  const fake = worker();
  for (const request of [new Request(`${scope}app.js`, { method: 'POST' }), new Request('https://elsewhere.org/app.js'), new Request(`${scope}api`)]) {
    assert.equal(await fake.event('fetch', { request }), null);
  }
});

test('failed precache removes the new cache and preserves the old usable version', async () => {
  const fake = worker({ legacy: true, failInstall: true });
  await assert.rejects(fake.event('install'), /offline/);
  assert.ok(fake.stores.has('baihuafen-v1'));
  assert.ok(![...fake.stores.keys()].some(key => key.includes('v2-20261010')));
  assert.equal(fake.state.skipped, false);
});

test('explicit update message activates the waiting worker', async () => {
  const fake = worker();
  await fake.event('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(fake.state.skipped, true);
});

test('manifest is installable under a subdirectory and includes both required PNG icon sizes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`);
    assert.ok(icon);
    const png = await readFile(new URL(`../${icon.src}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
