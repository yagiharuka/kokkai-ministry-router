import { makePlan, retrieveAssignments } from './routing-core.mjs';
const frontendOrigin = "https://yagiharuka.github.io";
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

async function fetchNdl(path, parameters) {
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

async function routeCases(first, second, focus = "", question = "") {
  const hints = [first, second, focus].filter(Boolean);
  const plan = makePlan(question || hints.join("の"), question ? [] : hints);
  if (!plan.groups.length) throw new Error("質問案に具体的な対象や制度を含めてください。");
  const result = await retrieveAssignments(plan, fetchNdl);
  if (result.errors.length && !result.searched.length) throw new Error(result.errors[0]);
  return result;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
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
        const result = await routeCases(first, second, focus, question);
        return withCors(Response.json(result, { headers: { "cache-control": "public, max-age=600" } }));
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
