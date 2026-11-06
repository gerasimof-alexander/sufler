/* Offline support: the app files are stored on the device on first visit.
   Speech models are not handled here — the speech engine keeps them in its
   own storage (IndexedDB). Bump VERSION whenever any app file changes. */
const VERSION = "sufler-2.3.0";
const FILES = [
  "./", "index.html", "app.js", "tracker.js", "capture-worklet.js", "lib/vosk.js",
  "manifest.webmanifest", "wake.mp4", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes("/models/") || url.pathname.includes("/dev/")) return;
  const dev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (dev) {   // while developing on this Mac: fresh files first, cache only as a fallback
      try { const r = await fetch(req, { cache: "no-store" }); if (r.ok) cache.put(req, r.clone()); return r; } catch (err) { }
    }
    const hit = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === "navigate" ? await cache.match("index.html") : null);
    if (hit) return hit;
    try { return await fetch(req); }
    catch (err) { return new Response("Offline", { status: 503 }); }
  })());
});
