// =====================================================================
// CARTRIDGE — service worker des notifications (à mettre à côté d'index.html)
// Il ne met rien en cache : il sert seulement à afficher les notifications
// de la messagerie, même quand l'app est fermée.
// =====================================================================
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge(); } catch (er) {}
    // L'iPhone exige qu'une notification soit affichée à chaque fois
    await self.registration.showNotification(d.title || "Cartridge", {
      body: d.body || "Nouveau message",
      tag: d.tag || "cartridge-msg",
      renotify: true,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { conv: d.conv || 0 },
    });
  })());
});

// Toucher la notification ouvre Cartridge directement sur la conversation
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const conv = (e.notification.data && e.notification.data.conv) || 0;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      try { await w.focus(); w.postMessage({ type: "cartridge:open-conv", conv }); return; } catch (er) {}
    }
    await self.clients.openWindow("./" + (conv ? "?msg=" + conv : "?msg=0"));
  })());
});
