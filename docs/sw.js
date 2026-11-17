// Service worker do Faro: mostra notificações do sistema (inclusive no iPhone, com o Faro na tela inicial)
// e abre a moeda certa ao tocar no aviso. Não guarda nem busca dados: o painel continua sempre online.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const mint = e.notification.data?.mint || '';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all[0];
    if (c) { await c.focus(); if (mint) c.postMessage({ faroGoto: mint }); return; }
    await self.clients.openWindow(mint ? `./?m=${encodeURIComponent(mint)}` : './');
  })());
});

// Pronto para avisos enviados pelo robô (push) no futuro
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Faro', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Faro', { body: d.body || '', tag: d.tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { mint: d.mint || '' } }));
});
