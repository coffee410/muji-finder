/* MUJI 제품 찾기 — 서비스 워커 (오프라인 캐시)
 *
 * 전략:
 *  - 페이지(index.html)·데이터(products.json 등)·무인양품 API: 네트워크 우선, 실패(오프라인) 시 캐시
 *    → 온라인일 땐 항상 최신이라 배포 반영이 늦어질 걱정 없음
 *  - 라이브러리(vendor)·아이콘: 캐시 우선(내용 불변)
 *  - 제품 사진(product.mujikorea.co.kr): 캐시 우선 + 최대 900장 제한(초과 시 오래된 것부터 삭제)
 *  - Firebase(교육자료)는 건드리지 않음(온라인 전용)
 */
const VER = "v3";  // v3: 신형 스캐너(zxing-wasm) 파일 사전 캐시 추가. v2: API 응답 전용 캐시 분리
const SHELL = "muji-shell-" + VER;
const IMGS = "muji-imgs-" + VER;
const API = "muji-api-" + VER;
const IMG_LIMIT = 900;
const API_LIMIT = 200;                  // 제품 상세·재고 응답 최대 개수
const API_MAX_AGE = 24 * 60 * 60 * 1000;  // 재고 숫자는 금방 낡으므로 24시간 지나면 오프라인에도 안 씀

const PRECACHE = ["./", "./index.html", "./vendor/zxing.min.js",
  "./vendor/zxing-wasm-reader.js", "./vendor/zxing_reader.wasm", "./manifest.webmanifest",
  "./data/products.json", "./data/extra.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // 하나 실패해도 나머지는 캐시되도록 개별 처리
    await Promise.all(PRECACHE.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== IMGS && k !== API) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// API 응답 전용: 네트워크 우선 + 저장 시각 헤더를 붙여 보관, 오프라인 폴백 시 24시간 넘은 것은 버림.
// put 전에 delete로 항목을 맨 뒤로 보내 trimCache(오래된 것부터 삭제)가 LRU처럼 동작하게 한다.
async function apiNetworkFirst(req) {
  const c = await caches.open(API);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const body = await res.clone().blob();
      const headers = new Headers(res.headers);
      headers.set("sw-cached-at", String(Date.now()));
      await c.delete(req);
      await c.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
      trimCache(c, API_LIMIT); // 기다리지 않음
    }
    return res;
  } catch (err) {
    const hit = await c.match(req);
    if (hit) {
      const t = Number(hit.headers.get("sw-cached-at") || 0);
      if (t && Date.now() - t < API_MAX_AGE) return hit;
      c.delete(req); // 너무 낡은 응답은 스테일 재고 표시 방지를 위해 폐기
    }
    throw err;
  }
}

async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: false });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName, limit) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) {
    await c.put(req, res.clone());
    if (limit) trimCache(c, limit); // 기다리지 않음
  }
  return res;
}

async function trimCache(c, limit) {
  try {
    const keys = await c.keys();
    for (let i = 0; i < keys.length - limit; i++) await c.delete(keys[i]);
  } catch (e) {}
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 제품 사진: 캐시 우선(불변) + 개수 제한
  if (url.hostname === "product.mujikorea.co.kr") {
    e.respondWith(cacheFirst(req, IMGS, IMG_LIMIT));
    return;
  }
  // 무인양품 API(상세 사진 목록·재고): 네트워크 우선, 오프라인이면 24시간 내 응답만 폴백
  if (url.hostname === "api.mujikorea.co.kr") {
    e.respondWith(apiNetworkFirst(req));
    return;
  }
  // 같은 오리진(앱 셸·데이터)
  if (url.origin === self.location.origin) {
    if (url.pathname.includes("/vendor/") || url.pathname.endsWith(".png")) {
      e.respondWith(cacheFirst(req, SHELL));
    } else if (req.mode === "navigate") {
      // 주소로 진입: 네트워크 우선, 오프라인이면 캐시된 index.html
      e.respondWith((async () => {
        try {
          return await networkFirst(req, SHELL);
        } catch (err) {
          const c = await caches.open(SHELL);
          return (await c.match("./index.html")) || (await c.match("./")) || Response.error();
        }
      })());
    } else {
      e.respondWith(networkFirst(req, SHELL));
    }
    return;
  }
  // 그 외(Firebase 등)는 기본 네트워크 동작
});
