/* Waraq service worker.
 * - App shell + static assets cache-first, navigations network-first with /offline fallback.
 * - Never caches /api responses except page thumbnails (stale-while-revalidate).
 * - Handles the PWA share target when offline or signed out: files are stashed in
 *   IndexedDB (idb-keyval default store) and /import-pending uploads them later.
 * - Versioned per build: the page registers /sw.js?v=<buildId>, so each deploy
 *   installs a new worker with fresh cache names (old caches are dropped on
 *   activate). A new worker waits until the page asks it to take over
 *   (postMessage {type:"SKIP_WAITING"} from the in-app "Update" button).
 */
/* eslint-disable */
"use strict";

var BUILD = (function () {
  try {
    return new URL(self.location.href).searchParams.get("v") || "dev";
  } catch (e) {
    return "dev";
  }
})();
var VERSION = "waraq-v4-" + BUILD.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
var SHELL = VERSION + "-shell";
var STATIC = VERSION + "-static";
var PAGES = VERSION + "-pages";
// thumbnails are keyed by ?v=<doc version>, so they survive app updates
var THUMBS = "waraq-thumbs-v1";
var KEEP = [SHELL, STATIC, PAGES, THUMBS];
var PRECACHE = [
  "/offline",
  "/import-pending",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/favicon-32.png",
  // same URL the page starts the worker with (src/lib/client/scanner/engine.ts)
  "/scan-worker.js?v=" + encodeURIComponent(BUILD),
];
var PENDING_KEY = "waraq-pending-share";
var MAX_THUMBS = 800;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL)
      .then(function (cache) {
        return Promise.all(
          PRECACHE.map(function (url) {
            return fetch(url, { cache: "reload", credentials: "same-origin" })
              .then(function (res) {
                if (res.ok && !res.redirected) return cache.put(url, res);
              })
              .catch(function () {});
          }),
        );
      }),
    // no skipWaiting here: the first install activates on its own, updates wait
    // for the user's "Update" tap so open pages never mix two builds.
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      var names = await caches.keys();
      await Promise.all(
        names
          .filter(function (n) {
            return n.indexOf("waraq-") === 0 && KEEP.indexOf(n) < 0;
          })
          .map(function (n) {
            return caches.delete(n);
          }),
      );
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (e) {}
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ------------------------------- fetch ------------------------------------ */

self.addEventListener("fetch", function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(req));
    return;
  }
  if (req.method !== "GET") return;

  var p = url.pathname;

  if (/^\/api\/docs\/[^/]+\/pages\/\d+\/thumb$/.test(p)) {
    event.respondWith(staleWhileRevalidate(req, THUMBS, true));
    return;
  }
  if (p.indexOf("/api/") === 0) return; // never cache API

  // OpenCV: the scanner worker keeps it in its own Cache Storage ("scanner-opencv-<ver>", survives deploys and works
  // without this worker, e.g. in the Android app); caching it here as well would store 7.7 MB twice
  if (p.indexOf("/vendor/opencv-") === 0) return;

  if (p.indexOf("/_next/static/") === 0 || p.indexOf("/icons/") === 0 || p.indexOf("/vendor/") === 0) {
    event.respondWith(cacheFirst(req, STATIC));
    return;
  }
  if (p === "/scan-worker.js" || p === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(req, SHELL, false));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(networkFirstPage(event));
    return;
  }
});

async function cacheFirst(req, cacheName) {
  var cache = await caches.open(cacheName);
  var hit = await cache.match(req);
  if (hit) return hit;
  var res = await fetch(req);
  if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(function () {});
  return res;
}

async function staleWhileRevalidate(req, cacheName, trim) {
  var cache = await caches.open(cacheName);
  var hit = await cache.match(req);
  var network = fetch(req)
    .then(function (res) {
      // 202 = page still processing: never cache it
      if (res.status === 200 && res.type === "basic") {
        cache.put(req, res.clone()).then(function () {
          if (trim) trimCache(cacheName, MAX_THUMBS);
        });
      }
      return res;
    })
    .catch(function () {
      return hit || Response.error();
    });
  return hit || network;
}

async function trimCache(name, max) {
  var cache = await caches.open(name);
  var keys = await cache.keys();
  if (keys.length <= max) return;
  for (var i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function networkFirstPage(event) {
  var req = event.request;
  var url = new URL(req.url);
  try {
    var preloaded = event.preloadResponse ? await event.preloadResponse : null;
    var res = preloaded || (await fetch(req));
    var cacheable =
      res.ok &&
      !res.redirected &&
      res.type === "basic" &&
      url.pathname.indexOf("/s/") !== 0 &&
      url.pathname !== "/login";
    if (cacheable) {
      var copy = res.clone();
      caches.open(PAGES).then(function (c) {
        c.put(url.pathname, copy);
      });
    }
    return res;
  } catch (e) {
    var cache = await caches.open(PAGES);
    var hit = (await cache.match(url.pathname)) || (await caches.match(url.pathname));
    if (hit) return hit;
    // dynamic routes: fall back to the closest cached shell
    if (url.pathname === "/import-pending") {
      var ip = await caches.match("/import-pending");
      if (ip) return ip;
    }
    var off = await caches.match("/offline");
    return off || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

/* --------------------------- share target --------------------------------- */

async function handleShareTarget(req) {
  var form;
  try {
    form = await req.formData();
  } catch (e) {
    return Response.redirect("/", 303);
  }
  var files = form.getAll("files").filter(function (f) {
    return f && typeof f === "object" && typeof f.size === "number" && f.size > 0;
  });
  var title = String(form.get("title") || "");
  var text = String(form.get("text") || "");

  var authed = null; // null = unknown (offline)
  try {
    var me = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    authed = me.ok;
    if (me.ok && files.length) {
      var fd = new FormData();
      files.forEach(function (f) {
        fd.append("files", f, f.name || "shared");
      });
      if (title) fd.append("title", title);
      if (text) fd.append("text", text);
      var res = await fetch("/share-target", { method: "POST", body: fd, credentials: "same-origin", redirect: "follow" });
      var finalPath = new URL(res.url || "/", self.location.origin).pathname;
      if (res.ok && finalPath.indexOf("/login") !== 0) {
        if (res.redirected) return Response.redirect(res.url, 303);
        return res;
      }
      if (finalPath.indexOf("/login") === 0) authed = false;
    }
  } catch (e) {
    /* offline: stash below */
  }

  if (!files.length) return Response.redirect("/", 303);

  try {
    await idbSet(PENDING_KEY, {
      createdAt: Date.now(),
      title: title,
      text: text,
      files: files.map(function (f) {
        return { name: f.name || "shared", type: f.type || "", blob: f };
      }),
    });
  } catch (e) {
    return Response.redirect("/offline", 303);
  }
  if (authed === false) return Response.redirect("/login?next=%2Fimport-pending", 303);
  return Response.redirect("/import-pending", 303);
}

/* idb-keyval compatible store: db "keyval-store", object store "keyval". */
function idbOpen(version) {
  return new Promise(function (resolve, reject) {
    var r = version ? indexedDB.open("keyval-store", version) : indexedDB.open("keyval-store");
    r.onupgradeneeded = function () {
      if (!r.result.objectStoreNames.contains("keyval")) r.result.createObjectStore("keyval");
    };
    r.onsuccess = function () {
      var db = r.result;
      if (db.objectStoreNames.contains("keyval")) return resolve(db);
      // db exists without the store (created elsewhere): bump the version to add it
      var v = db.version + 1;
      db.close();
      idbOpen(v).then(resolve, reject);
    };
    r.onerror = function () {
      reject(r.error);
    };
  });
}

async function idbSet(key, value) {
  var db = await idbOpen();
  await new Promise(function (resolve, reject) {
    var tx = db.transaction("keyval", "readwrite");
    tx.objectStore("keyval").put(value, key);
    tx.oncomplete = function () {
      resolve();
    };
    tx.onerror = tx.onabort = function () {
      reject(tx.error);
    };
  });
  db.close();
}
