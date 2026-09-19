/* Service worker: guarda los archivos de la app en el teléfono para que abra
   sin internet. Al cambiar VERSION se descarga todo de nuevo. */

const VERSION = "semaforo-v1";

const ARCHIVOS = [
  "./",
  "./index.html",
  "./style.css",
  "./db.js",
  "./app.js",
  "./manifest.json",
  "./assets/icono-192.png",
  "./assets/icono-512.png",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(ARCHIVOS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Solo se guardan los archivos propios; Firebase y otros servicios van siempre a la red.
self.addEventListener("fetch", (evento) => {
  if (evento.request.method !== "GET") return;
  if (new URL(evento.request.url).origin !== self.location.origin) return;
  evento.respondWith(
    caches.match(evento.request, { ignoreSearch: true }).then((guardado) => {
      if (guardado) return guardado;
      return fetch(evento.request).then((respuesta) => {
        if (respuesta.ok) {
          const copia = respuesta.clone();
          caches.open(VERSION).then((cache) => cache.put(evento.request, copia));
        }
        return respuesta;
      });
    })
  );
});

// Al tocar una notificación se abre la app.
self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();
  evento.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ventanas) => {
      if (ventanas.length) return ventanas[0].focus();
      return self.clients.openWindow("./");
    })
  );
});
