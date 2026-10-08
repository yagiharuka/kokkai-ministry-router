const frontendOrigin = "https://yagiharuka.github.io";
const rootPage = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="robots" content="noindex"><title>国会会議録API中継</title><p>検索画面は <a href="https://yagiharuka.github.io/kokkai-ministry-router/">GitHub Pages</a> です。</p></html>`;

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", frontendOrigin);
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(rootPage, { headers: { "content-type": "text/html; charset=utf-8" } });
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
