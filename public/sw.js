// Service worker del panel PmotionIA: permite instalarlo como app y muestra los avisos push.
const CACHE = "pmotionia-v5";
self.addEventListener("push", e => {
  e.waitUntil(self.registration.pushManager.getSubscription().then(sub =>
    fetch("/pushmsg", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ endpoint: sub && sub.endpoint }) })
      .then(r => r.json()).catch(() => ({ title:"PmotionIA", body:"Hay novedades en el panel.", url:"/" }))
  ).then(m => self.registration.showNotification(m.title || "PmotionIA", { body:m.body, icon:"/icon-192.png", badge:"/icon-192.png", tag:"pmotionia", renotify:true, data:{ url:m.url || "/" } })));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type:"window", includeUncontrolled:true }).then(list => {
    const w = list.find(c => new URL(c.url).origin === location.origin);
    return w ? w.focus() : self.clients.openWindow("/");
  }));
});
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"]))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Si el servidor tarda (Render despertando), abre al momento con la copia guardada y se actualiza por detrás
  const key = url.pathname === "/" ? "/" : e.request;
  const red = fetch(e.request, { cache:"no-store" }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); return r; });
  e.waitUntil(red.catch(() => {}));
  e.respondWith(Promise.race([red, new Promise(ok => setTimeout(ok, 2500))]).then(r => r || caches.match(key).then(c => c || red)).catch(() => caches.match(key)));
});
