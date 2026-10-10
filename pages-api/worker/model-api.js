import { routingVersion, makePlan } from './routing-core.mjs';
import { retrieveFastAssignments } from './fast-retrieval.mjs';
import { prepareSemanticPlan, reviewCompactAssignments, semanticConfiguration } from './semantic-review.mjs';
const frontendOrigin = "https://yagiharuka.github.io";
const publicRoutingVersion = '20261010-39';
const rootPage = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="robots" content="noindex"><title>国会会議録API中継</title><p>検索画面は <a href="https://yagiharuka.github.io/kokkai-ministry-router/">GitHub Pages</a> です。</p></html>`;
const departments = ["経済産業省", "厚生労働省", "文部科学省", "総務省", "財務省", "金融庁", "外務省", "法務省", "農林水産省", "国土交通省", "環境省", "防衛省", "デジタル庁", "こども家庭庁", "個人情報保護委員会"];
const lawTitles = new Map([
  ...departments.flatMap(name => ["設置法", "組織令", "組織規則"].map(suffix => [`${name}${suffix}`, name])),
  ["内閣府設置法", "内閣府・内閣官房等"],
  ["内閣府本府組織令", "内閣府・内閣官房等"],
  ["内閣府本府組織規則", "内閣府・内閣官房等"],
]);

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", frontendOrigin);
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

let requestQueue = Promise.resolve();
let lastNdlRequest = 0;

async function requestNdl(path, parameters) {
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const prior = requestQueue;
  requestQueue = next;
  await prior;
  try {
    const pause = Math.max(0, 3000 - (Date.now() - lastNdlRequest));
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    const source = new URL(`https://kokkai.ndl.go.jp/api/${path}`);
    for (const [key, value] of Object.entries(parameters)) source.searchParams.set(key, value);
    source.searchParams.set("recordPacking", "json");
    const response = await fetch(source, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`国会会議録API HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`国会会議録API: ${data.error}`);
    return data;
  } finally {
    lastNdlRequest = Date.now();
    release();
  }
}

// Cache public source responses only. Reuse never transfers another user's
// question, interpretation, or ministry judgment into this request.
const ndlCache = new Map(), ndlInFlight = new Map();
let ndlCacheBytes = 0;
async function fetchNdl(path, parameters) {
  const key = JSON.stringify([path, Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))]);
  const cached = ndlCache.get(key);
  if (cached && cached.until > Date.now()) return cached.data;
  if (cached) { ndlCache.delete(key); ndlCacheBytes -= cached.bytes; }
  if (ndlInFlight.has(key)) return ndlInFlight.get(key);
  const pending = (async () => {
    // Cache API survives isolate restarts. Cache only public NDL source data,
    // with the complete search conditions as its key, not a topic label.
    const edge = typeof caches !== 'undefined' ? caches.default : null;
    const hash = edge ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, '0')).join('') : '';
    const edgeKey = hash ? `https://kokkai-ministry-router.haru620328.workers.dev/__source_cache/${hash}` : '';
    try {
      const hit = edge && await edge.match(edgeKey);
      if (hit) return await hit.json();
    } catch { /* Cache faults must not prevent source retrieval. */ }
    const data = await requestNdl(path, parameters);
    if (edge && JSON.stringify(data).length < 2 * 1024 * 1024) {
      try { await edge.put(edgeKey, Response.json(data, { headers: { 'cache-control': 'public, max-age=3600' } })); } catch { /* best effort */ }
    }
    return data;
  })();
  ndlInFlight.set(key, pending);
  try {
    const data = await pending, bytes = JSON.stringify(data).length * 2;
    if (bytes <= 2 * 1024 * 1024) {
      while (ndlCache.size && (ndlCacheBytes + bytes > 12 * 1024 * 1024 || ndlCache.size >= 32)) {
        const oldest = ndlCache.keys().next().value;
        ndlCacheBytes -= ndlCache.get(oldest).bytes; ndlCache.delete(oldest);
      }
      ndlCache.set(key, { data, bytes, until: Date.now() + 3600000 });
      ndlCacheBytes += bytes;
    }
    return data;
  } finally { ndlInFlight.delete(key); }
}

async function routeCases(first, second, focus = "", question = "", env = {}) {
  const started = Date.now(), hints = [first, second, focus].filter(Boolean);
  const fullQuestion = question || hints.join("の") + "について伺います。";
  const directPlan = makePlan(fullQuestion);
  if (!semanticConfiguration(env).ready) {
    const empty = { candidates: [], review_candidates: [], searched: [], searched_queries: [], errors: [], requests_used: 0, meetings_searched: 0, retrieved_meetings: [] };
    return { ...await reviewCompactAssignments(fullQuestion, empty, env), retrieval_rounds: 0 };
  }
  if (!directPlan.groups.length) throw new Error("質問案に具体的な対象や制度を含めてください。");
  let result = await retrieveFastAssignments(directPlan, fetchNdl), planStatus = 'direct', rounds = 1;
  if (result.errors.length && !result.searched.length) throw new Error(result.errors[0]);
  // Search does not wait for an AI plan. Use a semantic rewrite only when the
  // original wording could not produce any actual question/answer candidates.
  if (!result.review_candidates.length) {
    const prepared = await prepareSemanticPlan(fullQuestion, env, fetch, { searched_queries: result.searched_queries,
      result: '質問案の語では、対応づけられる質問と政府答弁の候補が見つからなかった' });
    planStatus = prepared.status;
    if (prepared.status === 'ready') {
      const more = await retrieveFastAssignments(prepared.plan, fetchNdl, '2001-01-01');
      result = { ...more, searched: [...result.searched, ...more.searched],
        searched_queries: [...new Set([...result.searched_queries, ...more.searched_queries])],
        requests_used: result.requests_used + more.requests_used,
        errors: [...result.errors, ...more.errors], partial: result.partial || more.partial };
      rounds = 2;
    } else if (prepared.status === 'failed') {
      return { ...await reviewCompactAssignments(fullQuestion, result, env), assessment_status: 'failed',
        assessment_error: prepared.error_code, search_plan_status: planStatus, retrieval_rounds: rounds,
        timing: { total_ms: Date.now() - started } };
    }
  }
  const retrieved = Date.now();
  const assessed = await reviewCompactAssignments(fullQuestion, result, env);
  return { ...assessed, search_plan_status: planStatus, retrieval_rounds: rounds,
    timing: { retrieval_ms: retrieved - started, review_ms: Date.now() - retrieved, total_ms: Date.now() - started } };
}

const routeCache = new Map(), routesInFlight = new Map();
async function cachedRoute(first, second, focus, question, env, ctx = {}) {
  const started = Date.now();
  const config = semanticConfiguration(env);
  const key = JSON.stringify([publicRoutingVersion, first, second, focus, question, config.ready, config.model]);
  const cacheHit = result => ({ ...result, analysis_cache_hit: true, timing: { total_ms: Date.now() - started, cached: true } });
  const cached = routeCache.get(key);
  if (cached && cached.until > Date.now()) return cacheHit(cached.result);
  if (routesInFlight.has(key)) return routesInFlight.get(key);
  // Exact-question results survive isolate restarts. Include the deployed
  // routing version and model configuration so old decisions cannot leak in.
  const edge = config.ready && typeof caches !== 'undefined' ? caches.default : null;
  let edgeKey = '';
  try {
    if (edge) {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, '0')).join('');
      edgeKey = `https://kokkai-ministry-router.haru620328.workers.dev/__analysis_cache/${hash}`;
      const hit = await edge.match(edgeKey);
      if (hit) return cacheHit(await hit.json());
    }
  } catch { /* Cache faults must not prevent a fresh review. */ }
  // Another request may have started while the asynchronous cache lookup ran.
  if (routesInFlight.has(key)) return routesInFlight.get(key);
  const refreshed = routeCache.get(key);
  if (refreshed && refreshed.until > Date.now()) return cacheHit(refreshed.result);
  if (routesInFlight.size >= 2) return null;
  const pending = routeCases(first, second, focus, question, env).then(result => ({ ...result, routing_version: publicRoutingVersion }));
  routesInFlight.set(key, pending);
  try {
    const result = await pending;
    if (routeCache.size >= 32) routeCache.delete(routeCache.keys().next().value);
    routeCache.set(key, { result, until: Date.now() + (result.assessment_status === 'failed' ? 30000 : 600000) });
    if (edgeKey && result.assessment_status === 'reviewed' && !result.assessment_partial && !result.partial) {
      const save = edge.put(edgeKey, Response.json(result, { headers: { 'cache-control': 'public, max-age=600' } })).catch(() => {});
      if (typeof ctx.waitUntil === 'function') ctx.waitUntil(save); else await save;
    }
    return result;
  } finally { routesInFlight.delete(key); }
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/status") {
      return withCors(Response.json({ routing_version: publicRoutingVersion, assessment_method: 'semantic',
        model_provider: 'cloudflare', model_ready: semanticConfiguration(env).ready,
        paid_fallback: false }, { headers: { 'cache-control': 'no-store' } }));
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(rootPage, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "GET" && url.pathname === "/api/cases") {
      const question = (url.searchParams.get("question") || "").normalize("NFKC").trim();
      const first = (url.searchParams.get("first") || "").normalize("NFKC").trim();
      const second = (url.searchParams.get("second") || "").normalize("NFKC").trim();
      const focus = (url.searchParams.get("focus") || "").normalize("NFKC").trim();
      const valid = value => value.length >= 2 && value.length <= 30 && /^[\p{L}\p{N}々ー・]+$/u.test(value);
      if (question ? question.length < 8 || question.length > 1200 : !valid(first) || (second && (!valid(second) || first === second)) || (focus && !valid(focus))) {
        return withCors(Response.json({ error: "政策語を確認してください。" }, { status: 400 }));
      }
      try {
        const result = await cachedRoute(first, second, focus, question, env, ctx);
        if (!result) return withCors(Response.json({ error: "ほかの検索を処理中です。少し時間を置いて再試行してください。" }, { status: 429, headers: { 'Retry-After': '30' } }));
        return withCors(Response.json(result, { headers: { "cache-control": result.assessment_status === 'reviewed' ? "public, max-age=600" : "no-store" } }));
      } catch (error) {
        return withCors(Response.json({ error: error instanceof Error ? error.message : "会議録を取得できませんでした。" }, { status: 502 }));
      }
    }
    if (request.method === "GET" && url.pathname === "/api/jurisdiction") {
      const term = (url.searchParams.get("term") || "").trim();
      if (term.length < 2 || term.length > 30 || !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ー・]+$/u.test(term)) {
        return withCors(Response.json({ error: "照合語を確認してください。" }, { status: 400 }));
      }
      const source = new URL("https://laws.e-gov.go.jp/api/2/keyword");
      source.searchParams.set("keyword", term);
      source.searchParams.set("law_type", "Act,CabinetOrder,MinisterialOrdinance");
      source.searchParams.set("limit", "1000");
      try {
        const response = await fetch(source, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
        if (!response.ok) throw new Error(`e-Gov法令API HTTP ${response.status}`);
        const data = await response.json();
        const matches = (data.items || []).flatMap(item => {
          const title = item.revision_info?.law_title || "";
          const ministry = lawTitles.get(title);
          if (!ministry) return [];
          const sentences = (item.sentences || []).map(sentence => String(sentence.text || "").replace(/<[^>]*>/g, "").trim());
          const snippet = (sentences.find(text => text.includes("に関すること")) || sentences[0] || "").slice(0,260);
          return [{ ministry, title, snippet, url: `https://laws.e-gov.go.jp/law/${item.law_info.law_id}` }];
        });
        return withCors(Response.json({ term, matches, truncated: Boolean(data.next_offset) }, { headers: { "cache-control": "public, max-age=600" } }));
      } catch (error) {
        return withCors(Response.json({ error: error instanceof Error ? error.message : "法令を取得できませんでした。" }, { status: 502 }));
      }
    }
    if (!["/api/meeting", "/api/speech"].includes(url.pathname) || request.method !== "GET") {
      return new Response("Not found", { status: 404 });
    }
    const term = (url.searchParams.get("any") || "").trim();
    const meetingName = (url.searchParams.get("nameOfMeeting") || "").trim();
    const from = url.searchParams.get("from") || "2020-01-01";
    const maximum = Number(url.searchParams.get("maximumRecords") || 5);
    const limit = url.pathname === "/api/speech" ? 30 : 10;
    if (term.length < 2 || term.length > 80 || meetingName.length > 30 ||
        (meetingName && !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々・]+$/u.test(meetingName)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
        !Number.isInteger(maximum) || maximum < 1 || maximum > limit) {
      return withCors(Response.json({ error: "検索条件を確認してください。" }, { status: 400 }));
    }
    const source = new URL(`https://kokkai.ndl.go.jp${url.pathname}`);
    source.searchParams.set("any", term);
    if (meetingName) source.searchParams.set("nameOfMeeting", meetingName);
    source.searchParams.set("from", from);
    source.searchParams.set("maximumRecords", String(maximum));
    source.searchParams.set("recordPacking", "json");
    try {
      const result = await fetch(source, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
      if (!result.ok) throw new Error(`国会会議録API HTTP ${result.status}`);
      const body = await result.text();
      JSON.parse(body);
      return withCors(new Response(body, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=600" },
      }));
    } catch (error) {
      return withCors(Response.json({ error: error instanceof Error ? error.message : "会議録を取得できませんでした。" }, { status: 502 }));
    }
  },
};
