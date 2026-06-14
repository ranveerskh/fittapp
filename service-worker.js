const DEFAULT_URL = "/app.html";

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "ShapeCue has an update for you." };
  }

  const title = payload.title || "ShapeCue";
  const options = {
    body: payload.body || "Open ShapeCue to see your update.",
    icon: payload.icon || "/favicon.ico",
    badge: payload.badge || "/favicon.ico",
    tag: payload.tag || "shapecue",
    renotify: Boolean(payload.tag),
    data: {
      url: payload.url || DEFAULT_URL,
      ...(payload.data || {})
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || DEFAULT_URL, self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        if ("navigate" in client) await client.navigate(targetUrl);
        return client.focus();
      }
    }

    return self.clients.openWindow(targetUrl);
  })());
});
