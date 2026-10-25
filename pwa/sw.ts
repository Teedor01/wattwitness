/// <reference lib="webworker" />
const sw = self as unknown as ServiceWorkerGlobalScope;
declare const __SHELL__: string[];
declare const __BUILD__: string;

const CACHE = `wattwitness-shell-${__BUILD__}`;

sw.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(__SHELL__)).then(() => sw.skipWaiting()));
});
sw.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => sw.clients.claim()),
  );
});
sw.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== sw.location.origin) return;
  const isConfig = new URL(req.url).pathname.endsWith("/config.json");
  e.respondWith(
    isConfig
      ? fetch(req).then((r) => { const copy = r.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); return r; }).catch(() => caches.match(req).then((m) => m ?? Response.error()))
      : caches.match(req, { ignoreSearch: true }).then((m) => m ?? fetch(req)),
  );
});
