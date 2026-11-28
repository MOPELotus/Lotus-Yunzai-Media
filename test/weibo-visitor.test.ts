import { expect, test } from "bun:test";
import { withWeiboVisitorRecovery } from "../services/subscriptions/weibo/visitor.ts";
import { createWeiboProvider } from "../services/subscriptions/weibo/index.ts";
const feed = new URL("https://m.weibo.cn/api/container/getIndex?containerid=10760342");
const seeded = (cookie = "SUB=visitor-only; Domain=.weibo.cn; Path=/; Max-Age=600") => new Response(null, { status: 302, headers: { "Set-Cookie": cookie } });
const generated = () => new Response('window.gen_callback && gen_callback({"retcode":20000000,"data":{"tid":"visitor+fixture/=="}});');

test("anonymous 432 obtains a bounded visitor session once and reuses it without overwriting accounts", async () => {
  const requests: { url: URL; cookie: string | null; method?: string }[] = [];
  const request = withWeiboVisitorRecovery(async (url, options = {}) => {
    const cookie = new Headers(options.headers).get("cookie");
    requests.push({ url, cookie, method: options.method });
    if (url.pathname === "/visitor/genvisitor") {
      expect(options.redirect).toBe("error");
      expect(cookie).toBeNull();
      return generated();
    }
    if (url.pathname === "/visitor/visitor") {
      expect(options.redirect).toBe("manual");
      expect(url.searchParams.get("t")).toBe("visitor+fixture/==");
      return seeded();
    }
    return new Response("feed", { status: cookie ? 200 : 432 });
  });
  expect((await request(feed)).status).toBe(200);
  expect((await request(feed)).status).toBe(200);
  expect(requests.map(row => row.url.pathname)).toEqual([
    feed.pathname, "/visitor/genvisitor", "/visitor/visitor", feed.pathname, feed.pathname,
  ]);
  expect(requests.slice(-2).map(row => row.cookie)).toEqual(["SUB=visitor-only", "SUB=visitor-only"]);
  expect((await request(feed, { headers: { Cookie: "SUB=authenticated-account" } })).status).toBe(200);
  expect(requests.at(-1)?.cookie).toBe("SUB=authenticated-account");
  await request(new URL("https://unrelated.example/api/container/getIndex"));
  expect(requests.at(-1)?.cookie).toBeNull();
});

test("logged-in 432 never replaces a real account with an anonymous session", async () => {
  let count = 0;
  const request = withWeiboVisitorRecovery(async (url, options) => {
    count++;
    expect(url.origin).toBe(feed.origin);
    expect(new Headers(options?.headers).get("Cookie")).toBe("SUB=account");
    return new Response(null, { status: 432 });
  });
  expect((await request(feed, { headers: { Cookie: "SUB=account" } })).status).toBe(432);
  expect(count).toBe(1);
});

test.each([
  "SUB=deleted; Domain=.weibo.cn; Path=/",
  "SUB=visitor; Domain=.attacker.invalid; Path=/",
  "SUB=visitor; Domain=.weibo.cn; Path=/; Max-Age=0",
  "SUB=visitor; Domain=.weibo.cn; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
])("invalid or expired visitor proof cannot replay: %s", async cookie => {
  let feeds = 0, bootstraps = 0;
  const request = withWeiboVisitorRecovery(async url => {
    if (url.pathname === "/visitor/genvisitor") { bootstraps++; return generated(); }
    if (url.pathname === "/visitor/visitor") return seeded(cookie);
    feeds++;
    return new Response(null, { status: 432 });
  });
  expect((await request(feed)).status).toBe(432);
  expect((await request(feed)).status).toBe(432);
  expect(feeds).toBe(2);
  expect(bootstraps).toBe(1);
});

test("concurrent anonymous 432 shares bootstrap, and a cancelled caller does not replay", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let bootstraps = 0, replays = 0;
  const request = withWeiboVisitorRecovery(async (url, options) => {
    if (url.pathname === "/visitor/genvisitor") { bootstraps++; return generated(); }
    if (url.pathname === "/visitor/visitor") { entered.resolve(); await release.promise; return seeded(); }
    if (new Headers(options?.headers).has("Cookie")) { replays++; return new Response("ok"); }
    return new Response(null, { status: 432 });
  });
  const cancelled = request(feed, { signal: controller.signal });
  const captured = cancelled.catch(error => error);
  const second = request(feed);
  await entered.promise;
  controller.abort();
  release.resolve();
  expect((await captured).name).toBe("AbortError");
  expect((await second).status).toBe(200);
  expect(bootstraps).toBe(1);
  expect(replays).toBe(1);
});

test("a repeated 432 stops after the one visitor replay", async () => {
  let feeds = 0;
  const request = withWeiboVisitorRecovery(async url => {
    if (url.pathname === "/visitor/genvisitor") return generated();
    if (url.pathname === "/visitor/visitor") return seeded();
    feeds++;
    return new Response(null, { status: 432 });
  });
  expect((await request(feed)).status).toBe(432);
  expect(feeds).toBe(2);
});

test("the public subscription provider decodes the feed recovered from visitor 432", async () => {
  let calls = 0;
  const provider = createWeiboProvider({ async fetch(url, options) {
    if (url.pathname === "/visitor/genvisitor") return generated();
    if (url.pathname === "/visitor/visitor") return seeded();
    calls++;
    if (!new Headers(options?.headers).get("Cookie")) return new Response(null, { status: 432 });
    return Response.json({ ok: 1, data: { cards: [{ card_type: 9, mblog: {
      mid: "80", created_at: "Thu Nov 19 09:20:00 +0800 2026", text: "fixture",
      user: { idstr: "42", screen_name: "fixture" },
    } }] } });
  } });
  expect((await provider.fetchPosts("42")).map(post => post.id)).toEqual(["80"]);
  expect(calls).toBe(2);
});
