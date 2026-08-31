/* Calculon — service worker.
   Registrato con percorso relativo da index.html: navigator.serviceWorker.register("./sw.js")
   Cambia il numero di versione a ogni rilascio, o gli aggiornamenti non arrivano mai. */
const CACHE = "cc-v52";

/* Guscio: tutto relativo, perché il sito sta in una sottocartella di GitHub Pages. */
const GUSCIO = [
  "./", "./index.html", "./sw.js", "./manifest.json",
  "./favicon-16.png", "./favicon-32.png", "./apple-touch-icon.png",
  "./icon-192.png", "./icon-512.png",
];

/* Origini dei font: messe in cache al primo passaggio, non precaricate.
   Se sono irraggiungibili, il fallback di sistema nello stack CSS tiene l'app leggibile. */
const FONT = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(GUSCIO))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((chiavi) => Promise.all(chiavi.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* API: solo rete. Offline devono fallire — al caso ci pensa l'outbox, non la cache. */
  if (url.pathname.startsWith("/api/")) return;

  /* Navigazione: guscio dalla cache, così offline la pagina si apre comunque. */
  if (req.mode === "navigate"){
    e.respondWith(
      caches.match("./index.html", { ignoreSearch: true })
        .then((hit) => hit || fetch(req))
    );
    return;
  }

  /* Font: cache-first, con riempimento al primo caricamento riuscito. */
  if (FONT.indexOf(url.origin) >= 0){
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok){
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      }))
    );
    return;
  }

  /* Resto di questa origine: cache-first. */
  if (url.origin === self.location.origin){
    e.respondWith(
      caches.match(req, { ignoreSearch: false }).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic"){
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      }))
    );
  }
});
