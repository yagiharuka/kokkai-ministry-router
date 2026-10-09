import { routingVersion } from './routing-core.mjs';
import { retrieveFastAssignments } from './fast-retrieval.mjs';
import { prepareSemanticPlan, reviewAssignments, semanticConfiguration } from './semantic-review.mjs';
const frontendOrigin = "https://yagiharuka.github.io";
const publicRoutingVersion = '20261009-26';
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
  const pending = requestNdl(path, parameters);
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
  const hints = [first, second, focus].filter(Boolean);
  const fullQuestion = question || hints.join("の") + "について伺います。";
  const prepared = await prepareSemanticPlan(fullQuestion, env);
  const plan = prepared.plan;
  if (prepared.status !== 'ready') {
    const empty = { candidates: [], review_candidates: [], searched: [], searched_queries: [], errors: [], requests_used: 0, meetings_searched: 0, retrieved_meetings: [] };
    return { ...await reviewAssignments(fullQuestion, empty, env, fetch, prepared.status),
      assessment_error: prepared.error_code, retrieval_rounds: 0 };
  }
  if (!plan.groups.length) throw new Error("質問案に具体的な対象や制度を含めてください。");
  const result = await retrieveFastAssignments(plan, fetchNdl);
  if (result.errors.length && !result.searched.length) throw new Error(result.errors[0]);
  const assessed = await reviewAssignments(fullQuestion, result, env, fetch, prepared.status);
  // Rejection is evidence about these candidates, not evidence that no relevant
  // debate exists. Try unused natural-language searches and older records once.
  if (prepared.status !== 'ready' || !['reviewed', 'no_candidates'].includes(assessed.assessment_status) || assessed.pairs) return { ...assessed, retrieval_rounds: 1 };
  const refined = await prepareSemanticPlan(fullQuestion, env, fetch, {
    searched_queries: result.searched_queries,
    rejected_reasons: assessed.search_feedback || [],
    result: assessed.assessment_status === 'no_candidates' ? '質問と答弁の候補が見つからなかった' : '候補を読んだが、質問案の対象と措置に対応する答弁を確認できなかった',
  });
  if (refined.status !== 'ready') return { ...assessed, retrieval_rounds: 1, expansion_status: 'failed', assessment_status: 'failed', assessment_error: refined.error_code };
  const more = await retrieveFastAssignments(refined.plan, fetchNdl, '2020-01-01', {
    maxRequests: 8 - result.requests_used, excludeMeetings: result.retrieved_meetings, includeOlder: true,
  });
  const reviewed = await reviewAssignments(fullQuestion, more, env, fetch, prepared.status);
  return { ...reviewed, retrieval_rounds: 2, initial_reviewed_candidates: assessed.reviewed_candidates,
    assessment_status: reviewed.assessment_status === 'no_candidates' && assessed.assessment_status === 'reviewed' ? 'reviewed' : reviewed.assessment_status,
    reviewed_candidates: assessed.reviewed_candidates + reviewed.reviewed_candidates,
    rejected_candidates: assessed.rejected_candidates + reviewed.rejected_candidates,
    uncertain_candidates: assessed.uncertain_candidates + reviewed.uncertain_candidates,
    review_candidates: [...assessed.review_candidates.map(row => ({ ...row, review_round: 1 })), ...reviewed.review_candidates.map(row => ({ ...row, review_round: 2 }))],
    searched: [...result.searched, ...more.searched], searched_queries: [...new Set([...result.searched_queries, ...more.searched_queries])],
    requests_used: result.requests_used + more.requests_used,
    retrieved_meetings: [...result.retrieved_meetings, ...more.retrieved_meetings],
    meetings_searched: result.meetings_searched + more.meetings_searched,
    errors: [...result.errors, ...more.errors], partial: result.partial || more.partial,
    search_limited: result.search_limited || more.search_limited };
}

const routeCache = new Map(), routesInFlight = new Map();
async function cachedRoute(first, second, focus, question, env) {
  const config = semanticConfiguration(env);
  const key = JSON.stringify([first, second, focus, question, config.ready, config.model]);
  const cached = routeCache.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  if (routesInFlight.has(key)) return routesInFlight.get(key);
  if (routesInFlight.size >= 2) return null;
  const pending = routeCases(first, second, focus, question, env).then(result => ({ ...result, routing_version: publicRoutingVersion }));
  routesInFlight.set(key, pending);
  try {
    const result = await pending;
    if (routeCache.size >= 32) routeCache.delete(routeCache.keys().next().value);
    routeCache.set(key, { result, until: Date.now() + (result.assessment_status === 'failed' ? 30000 : 600000) });
    return result;
  } finally { routesInFlight.delete(key); }
}

export default {
  async fetch(request, env = {}) {
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
        const result = await cachedRoute(first, second, focus, question, env);
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
