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

const ministryPatterns = [
  [/経済産業|通商産業|資源エネルギー庁|中小企業庁|特許庁/, "経済産業省"],
  [/厚生労働|厚生省|労働省/, "厚生労働省"],
  [/文部科学|文部省|科学技術庁|スポーツ庁|文化庁/, "文部科学省"],
  [/総務省|自治省|郵政省|消防庁/, "総務省"],
  [/金融庁|金融担当|特命担当大臣[（(]金融[）)]/, "金融庁"],
  [/財務省|財務大臣|大蔵省|国税庁/, "財務省"],
  [/外務省|外務大臣/, "外務省"],
  [/法務省|法務大臣|出入国在留管理庁/, "法務省"],
  [/農林水産|農林省|水産庁|林野庁/, "農林水産省"],
  [/国土交通|運輸省|建設省|観光庁|気象庁|海上保安庁/, "国土交通省"],
  [/環境省|環境庁|環境大臣/, "環境省"],
  [/防衛省|防衛庁|自衛隊/, "防衛省"],
  [/デジタル庁|デジタル大臣/, "デジタル庁"],
  [/こども家庭庁|こども政策担当|少子化対策担当/, "こども家庭庁"],
  [/個人情報保護委員会/, "個人情報保護委員会"],
  [/内閣府|内閣官房|内閣総理大臣|官房長官|国家公安委員会|警察庁|消費者庁|公正取引委員会/, "内閣府・内閣官房等"],
];
const wordSegmenter = new Intl.Segmenter("ja", { granularity: "word" });
let requestQueue = Promise.resolve();
let lastNdlRequest = 0;

function cleaned(value) { return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim(); }
function ministryOf(value, answer = "") {
  const title = cleaned(value);
  const candidates = ministryPatterns.map(([pattern, name]) => ({ name, at: title.search(pattern) }))
    .filter(row => row.at >= 0).sort((a, b) => a.at - b.at).map(row => row.name);
  const selfReference = name => new RegExp(`${name}(?:として|では|において|からは|といたしましては)`).test(answer.slice(0, 900));
  if (candidates.length === 1 && candidates[0] === "内閣府・内閣官房等") {
    const named = departments.filter(selfReference);
    if (named.length === 1) return named[0];
  }
  if (candidates.length > 1) {
    const explicit = candidates.find(selfReference);
    if (explicit) return explicit;
  }
  return candidates[0] || null;
}
function lawmaker(speech) {
  const role = `${speech.speakerRole || ""} ${speech.speakerPosition || ""}`;
  return Boolean(speech.speakerGroup) && !/委員長|議長|副委員長|理事|大臣|副大臣|政務官|政府参考人|長官|局長|審議官|統括官/.test(role);
}
function nearby(text, terms, maxGap = 180) {
  const hits = terms.map(term => {
    const found = []; let at = -1;
    while (found.length < 80 && (at = text.indexOf(term, at + 1)) >= 0) found.push(at);
    return found;
  });
  if (hits.some(list => !list.length)) return null;
  if (hits.length === 1) return { start: hits[0][0], end: hits[0][0] + terms[0].length };
  let best = null;
  for (const a of hits[0]) for (const b of hits[1]) {
    const start = Math.min(a, b), end = Math.max(a + terms[0].length, b + terms[1].length);
    const gap = Math.max(0, Math.max(a, b) - Math.min(a + terms[0].length, b + terms[1].length));
    if (gap <= maxGap && (!best || end - start < best.end - best.start)) best = { start, end };
  }
  return best;
}
function around(text, span, limit = 320) {
  const start = Math.max(0, (span?.start || 0) - 90);
  return (start ? "…" : "") + text.slice(start, start + limit) + (start + limit < text.length ? "…" : "");
}
function reducedWord(phrase) {
  const parts = [...wordSegmenter.segment(phrase)].filter(part => part.isWordLike && part.segment.length >= 2);
  return parts[0]?.segment || phrase;
}
function relatedWord(question, first, second) {
  const span = nearby(question, [first, second]);
  if (!span) return null;
  const passage = question.slice(span.start, span.end);
  const a = passage.indexOf(first), b = passage.indexOf(second);
  const between = a < b ? passage.slice(a + first.length, b) : passage.slice(b + second.length, a);
  const words = [...wordSegmenter.segment(between)]
    .filter(part => part.isWordLike && part.segment.length >= 2 && !/^(について|として|ため|こと|もの|それ|これ|から|まで|など|支援|推進|活躍)$/.test(part.segment));
  if (!words.length) return null;
  const next = [...wordSegmenter.segment(between)].find(part => part.index === words[0].index + words[0].segment.length);
  return words[0].segment + (next?.isWordLike && /^[\p{Script=Han}]$/u.test(next.segment) ? next.segment : "");
}

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
    return data;
  } finally {
    lastNdlRequest = Date.now();
    release();
  }
}

function questionMatch(speech, terms, focus = "") {
  const question = cleaned(speech.speech);
  if (!lawmaker(speech) || question.length < 20) return null;
  const span = nearby(question, terms, 90);
  if (!span) return null;
  if (focus && !question.slice(Math.max(0, span.start - 140), span.end + 240).includes(reducedWord(focus))) return null;
  if (/^(拡大|拡充|推進|促進|支援|強化|改善|整備|見直し|充実)$/.test(terms[1])) {
    if (!question.startsWith(terms[0], span.start)) return null;
    const between = question.slice(span.start + terms[0].length, span.end - terms[1].length);
    if (between.length > 25 || /[。、！？]/.test(between)) return null;
  }
  const context = question.slice(Math.max(0, span.start - 80), Math.min(question.length, span.end + 170));
  if (!/[？?]|伺|お尋ね|いかが|どう|所見|べき|問う|質問/.test(context)) return null;
  if (/次に[、，]/.test(question.slice(span.end, span.end + 160))) return null;
  if (/質問しません|質問ではありません/.test(context) && !/[？?]|伺|お尋ね|いかが|べき/.test(context)) return null;
  return span;
}
function selectQuestions(speeches, terms, limit = 4, focus = "") {
  const selected = new Map();
  for (const speech of speeches) {
    if (speech.nameOfMeeting === "本会議") continue;
    const span = questionMatch(speech, terms, focus);
    if (!span || !speech.issueID || !speech.speechID) continue;
    const question = cleaned(speech.speech);
    const score = 500 - (span.end - span.start) - Math.min(question.length, 2200) / 20 +
      (/予算委員会|決算委員会/.test(speech.nameOfMeeting || "") ? 0 : 30);
    const current = selected.get(speech.issueID);
    if (!current || current.score < score) selected.set(speech.issueID, { score, speechID: speech.speechID });
  }
  return [...selected].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
}
function extractCases(meetings, terms, query, allowedQuestions = null, focus = "") {
  const cases = new Map();
  for (const meeting of meetings) {
    const speeches = [...(meeting.speechRecord || [])].sort((a, b) => Number(a.speechOrder || 0) - Number(b.speechOrder || 0));
    for (let i = 0; i < speeches.length; i++) {
      const ask = speeches[i], question = cleaned(ask.speech);
      if (allowedQuestions && !allowedQuestions.has(ask.speechID)) continue;
      const questionSpan = questionMatch(ask, terms, focus);
      if (!questionSpan) continue;
      for (let j = i + 1; j < speeches.length; j++) {
        const reply = speeches[j];
        if (lawmaker(reply)) break;
        const answer = cleaned(reply.speech), ministry = ministryOf(reply.speakerPosition, answer);
        if (!ministry || !answer || !reply.speechURL) continue;
        const answerSpan = nearby(answer, terms);
        const genericAction = /^(拡大|拡充|推進|促進|支援|強化|改善|整備|見直し|充実)$/.test(terms[1]);
        // An answer can reject or paraphrase the requested action. It must still
        // address the named policy, rather than repeat the verb verbatim.
        if (genericAction && !answer.slice(0, 1200).includes(terms[0])) continue;
        if (!genericAction && terms.length > 1 && !answerSpan && !answer.slice(0, 1200).includes(reducedWord(terms[1]))) {
          const related = relatedWord(question, terms[0], reducedWord(terms[1]));
          if (!related || !answer.slice(0, 1200).includes(related)) continue;
        }
        if (!answerSpan && question.length > 1000) continue;
        const caseId = `${meeting.issueID || meeting.date}:${ask.speechID || ask.speechOrder || i}`;
        const key = `${caseId}:${ministry}`;
        if (cases.has(key) && (cases.get(key).context === "answer" || !answerSpan)) continue;
        cases.set(key, {
          case_id: caseId, ministry, question: around(question, questionSpan),
          answer: around(answer, answerSpan), speaker: reply.speaker || "答弁者",
          position: reply.speakerPosition || "", date: meeting.date || "",
          meeting: meeting.nameOfMeeting || "", url: reply.speechURL,
          context: answerSpan ? "answer" : "question", query,
        });
      }
    }
  }
  return [...cases.values()];
}

async function routeCases(first, second, focus = "") {
  const year = new Date().getUTCFullYear();
  const cut = year - 2;
  const periods = [[`${cut}-01-01`, `${year}-12-31`], ["2020-01-01", `${cut - 1}-12-31`]];
  const relaxed = second ? reducedWord(second) : "";
  const cases = new Map(), searched = [];
  let meetingCount = 0, errors = 0;
  const fullQuery = terms => [...terms, ...(focus ? [reducedWord(focus)] : [])].join(" ");
  const addCase = row => {
    const key = `${row.case_id}:${row.ministry}`;
    if (!cases.has(key) || (cases.get(key).context !== "answer" && row.context === "answer")) cases.set(key, row);
  };
  async function search(terms) {
    const query = fullQuery(terms);
    let found = 0;
    for (const [from, until] of periods) {
      try {
        const data = await fetchNdl("speech", { any: query, from, until, maximumRecords: "100" });
        const candidates = selectQuestions(data.speechRecord || [], terms, 3, focus);
        for (const [issueID, item] of candidates) {
          const result = await fetchNdl("meeting", { issueID, maximumRecords: "1" });
          const meetings = result.meetingRecord || [];
          meetingCount += meetings.length;
          for (const row of extractCases(meetings, terms, query, new Set([item.speechID]), focus)) { addCase(row); found++; }
          if (found >= 4) break;
        }
      } catch { errors++; }
      searched.push(`${query}（${from.slice(0,4)}–${until.slice(0,4)}）`);
      // Do not merge older answering ministries into recent routing evidence.
      if (found > 0) break;
    }
  }
  await search(second ? [first, second] : [first]);
  const exactCount = cases.size;
  if (second && exactCount > 0 && exactCount < 3 && relaxed !== second) {
    const seed = [...cases.values()].find(row => row.query === fullQuery([first, second]));
    const alias = seed && relatedWord(seed.question, first, relaxed);
    if (alias && alias !== first && alias !== relaxed) {
      await search([first, relaxed + alias]);
    }
  }
  if (second && !cases.size && relaxed !== second && relaxed.length >= 2) await search([first, relaxed]);
  const genericAction = /^(拡大|拡充|推進|促進|支援|強化|改善|整備|見直し|充実)$/.test(second);
  if (!cases.size && genericAction && !focus && first.length >= 4) await search([first]);
  if (errors === searched.length) throw new Error("国会会議録APIが応答しませんでした。");
  const allRows = [...cases.values()];
  const recentRows = allRows.filter(row => row.date >= `${cut}-01-01`);
  const rows = (recentRows.length ? recentRows : allRows).slice(0, 24);
  const byCase = new Map();
  for (const row of rows) {
    if (!byCase.has(row.case_id)) byCase.set(row.case_id, new Set());
    byCase.get(row.case_id).add(row.ministry);
  }
  const weights = new Map();
  for (const ministries of byCase.values()) for (const ministry of ministries) weights.set(ministry, (weights.get(ministry) || 0) + 1 / ministries.size);
  const shares = [...weights].map(([ministry, weight]) => ({ ministry, percent: Math.round(weight / byCase.size * 100), count: rows.filter(row => row.ministry === ministry).length })).sort((a, b) => b.percent - a.percent);
  if (shares.length) shares[0].percent += 100 - shares.reduce((sum, row) => sum + row.percent, 0);
  return { shares, evidence: rows.slice(0, 8), pairs: byCase.size, searched, meetings_searched: meetingCount, partial: errors > 0,
    historical_only: rows.length > 0 && recentRows.length === 0, recent_since: `${cut}-01-01`,
    broadened: Boolean(second) && rows.some(row => row.query === first) };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(rootPage, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "GET" && url.pathname === "/api/cases") {
      const first = (url.searchParams.get("first") || "").normalize("NFKC").trim();
      const second = (url.searchParams.get("second") || "").normalize("NFKC").trim();
      const focus = (url.searchParams.get("focus") || "").normalize("NFKC").trim();
      const valid = value => value.length >= 2 && value.length <= 30 && /^[\p{L}\p{N}々ー・]+$/u.test(value);
      if (!valid(first) || (second && (!valid(second) || first === second)) || (focus && !valid(focus))) {
        return withCors(Response.json({ error: "政策語を確認してください。" }, { status: 400 }));
      }
      try {
        const result = await routeCases(first, second, focus);
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
