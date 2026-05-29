// ═══════════════════════════════════════════════════════════════════
// SERVICE WORKER — Marjane Étiquettes PWA
// Stratégie : Cache-First pour assets statiques + Network-First pour HTML
// ═══════════════════════════════════════════════════════════════════

const APP_NAME    = 'marjane-etiquettes';
const APP_VERSION = 'v2.2.0';
const CACHE_STATIC = `${APP_NAME}-static-${APP_VERSION}`;
const CACHE_FONTS  = `${APP_NAME}-fonts-${APP_VERSION}`;
const CACHE_IMAGES = `${APP_NAME}-images-${APP_VERSION}`;

// ── Assets à pré-cacher au moment de l'installation ──────────────
const PRECACHE_ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

// ── CDN scripts (cache-first une fois récupérés) ──────────────────
const CDN_SCRIPTS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// ── Google Fonts (cache-first) ────────────────────────────────────
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// ─────────────────────────────────────────────────────────────────
// INSTALL — pré-cache des ressources critiques
// ─────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW ${APP_VERSION}] Installing…`);

  event.waitUntil(
    Promise.all([
      // Cache statique principal
      caches.open(CACHE_STATIC).then(cache => {
        return cache.addAll(PRECACHE_ASSETS)
          .catch(err => console.warn('[SW] Precache partial fail:', err));
      }),
      // Cache CDN scripts
      caches.open(CACHE_STATIC).then(cache => {
        return Promise.allSettled(
          CDN_SCRIPTS.map(url =>
            fetch(url, { mode: 'cors' })
              .then(res => { if (res.ok) cache.put(url, res); })
              .catch(() => {})
          )
        );
      }),
    ])
    .then(() => {
      console.log(`[SW ${APP_VERSION}] Install complete`);
      return self.skipWaiting();
    })
  );
});

// ─────────────────────────────────────────────────────────────────
// ACTIVATE — nettoyage des vieux caches
// ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log(`[SW ${APP_VERSION}] Activating…`);

  const currentCaches = [CACHE_STATIC, CACHE_FONTS, CACHE_IMAGES];

  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith(APP_NAME) && !currentCaches.includes(k))
          .map(k => {
            console.log(`[SW] Deleting old cache: ${k}`);
            return caches.delete(k);
          })
      )
    )
    .then(() => {
      console.log(`[SW ${APP_VERSION}] Activated — claiming clients`);
      return self.clients.claim();
    })
  );
});

// ─────────────────────────────────────────────────────────────────
// FETCH — stratégies de cache par type de ressource
// ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorer les requêtes non-GET
  if (request.method !== 'GET') return;

  // Ignorer les extensions navigateur et requêtes chrome://
  if (!url.protocol.startsWith('http')) return;

  // ── Google Fonts → Cache-First ──────────────────────────────────
  if (FONT_ORIGINS.some(o => url.origin === o || url.href.startsWith(o))) {
    event.respondWith(cacheFirst(request, CACHE_FONTS));
    return;
  }

  // ── CDN (jsPDF, SheetJS, Remix Icons) → Stale-While-Revalidate ──
  if (
    url.hostname === 'cdnjs.cloudflare.com' ||
    url.hostname === 'cdn.jsdelivr.net'     ||
    url.hostname === 'unpkg.com'
  ) {
    event.respondWith(staleWhileRevalidate(request, CACHE_STATIC));
    return;
  }

  // ── Images locales → Cache-First ───────────────────────────────
  if (/\.(png|jpg|jpeg|webp|svg|gif|ico)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, CACHE_IMAGES));
    return;
  }

  // ── Fichiers statiques locaux (JS, CSS, JSON) → Cache-First ─────
  if (/\.(js|css|json|woff2?|ttf)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // ── Page HTML principale → Network-First (offline fallback) ─────
  if (request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(networkFirst(request, CACHE_STATIC));
    return;
  }

  // ── Tout le reste → Network avec fallback cache ─────────────────
  event.respondWith(networkWithCacheFallback(request, CACHE_STATIC));
});

// ─────────────────────────────────────────────────────────────────
// STRATÉGIES DE CACHE
// ─────────────────────────────────────────────────────────────────

/** Cache-First : serve depuis le cache, sinon réseau puis mise en cache */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return offlineFallback(request);
  }
}

/** Network-First : réseau d'abord, fallback cache si hors ligne */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlineFallback(request);
  }
}

/** Stale-While-Revalidate : répond depuis le cache, met à jour en arrière-plan */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}

/** Network avec fallback cache simple */
async function networkWithCacheFallback(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    return cached || offlineFallback(request);
  }
}

/** Page de fallback hors-ligne minimale */
function offlineFallback(request) {
  if (request.destination === 'document') {
    return new Response(
      `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Hors ligne — Marjane Étiquettes</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0b0f14;color:#e5eef7;font-family:'Barlow Condensed',sans-serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;padding:24px;text-align:center}
    .logo{width:80px;height:80px;background:#1a4da0;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:36px}
    h1{font-size:28px;font-weight:900;color:#ffb300}
    p{font-size:15px;color:#9ca3af;max-width:320px;line-height:1.6}
    button{margin-top:8px;background:#1a4da0;color:#fff;border:none;border-radius:999px;
           padding:12px 28px;font-size:15px;font-weight:700;cursor:pointer}
    button:hover{background:#1d5cbf}
    .badge{font-size:11px;color:#6b7280;margin-top:8px}
  </style>
</head>
<body>
  <div class="logo">🏷</div>
  <h1>Mode hors ligne</h1>
  <p>Vous n'êtes pas connecté à Internet. L'application nécessite une connexion pour la première ouverture.</p>
  <button onclick="location.reload()">↻ Réessayer</button>
  <p class="badge">Marjane Étiquettes v${APP_VERSION}</p>
</body>
</html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  return new Response('Ressource indisponible hors ligne', { status: 503 });
}

// ─────────────────────────────────────────────────────────────────
// MESSAGE — skip waiting (mise à jour immédiate)
// ─────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skipping waiting — updating now');
    self.skipWaiting();
  }

  // Répondre avec la version pour diagnostic
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION, cache: CACHE_STATIC });
  }
});

// ─────────────────────────────────────────────────────────────────
// BACKGROUND SYNC (si supporté) — file d'impression
// ─────────────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-print-queue') {
    console.log('[SW] Background sync: print queue');
    // Placeholder pour future synchronisation serveur
  }
});

// ─────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS (si supportées)
// ─────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body:    data.body    || 'Notification Marjane Étiquettes',
    icon:    './icon-192.png',
    badge:   './icon-192.png',
    vibrate: [100, 50, 100],
    data:    { url: data.url || './' },
    actions: [
      { action: 'open',    title: 'Ouvrir' },
      { action: 'dismiss', title: 'Ignorer' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Marjane Étiquettes', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

console.log(`[SW ${APP_VERSION}] Script loaded`);
