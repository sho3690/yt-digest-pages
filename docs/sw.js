/* YouTube Digest — Service Worker
   役割は「通知を受け取って表示する」「通知をタップしたら該当画面を開く」の2つだけ。
   ページのキャッシュはしない（古い画面が残るのを避けるため）。 */
"use strict";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });

function appUrl(path) {
  // 通知に入っていたURLは、このサイトの中だけ許す（外部サイトへは飛ばさない）
  var home = new URL("./", self.location.href).href;
  try {
    var u = new URL(path || "./", self.location.href);
    return u.origin === self.location.origin ? u.href : home;
  } catch (e) { return home; }
}

function setBadge(n) {
  try {
    if (self.navigator && typeof self.navigator.setAppBadge === "function") {
      return self.navigator.setAppBadge(typeof n === "number" ? n : 1).catch(function () {});
    }
  } catch (e) { /* 対応していない端末 */ }
  return Promise.resolve();
}

self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  var title = typeof data.title === "string" && data.title ? data.title : "YouTube Digest";
  var options = {
    body: typeof data.body === "string" && data.body ? data.body : "新しい週のまとめが公開されました",
    tag: typeof data.tag === "string" && data.tag ? data.tag : "ytd-week",
    data: { url: appUrl(data.url) },
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png"
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    setBadge(data.badge)
  ]));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || appUrl("./");
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if ("focus" in c) {
        return c.focus().then(function (win) {
          if (win && "navigate" in win) return win.navigate(url).catch(function () {});
        });
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
