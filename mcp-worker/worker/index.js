const protocolVersion = "2026-07-28";
const legacyProtocolVersion = "2025-11-25";
const toolDefinition = {
  name: "search_answer_assignments",
  title: "国会答弁から所管省庁を調べる",
  description: "国会会議録を検索し、議員の発言に続く政府側答弁の候補と、答弁者の肩書きから読める省庁を返します。検索語の近接一致だけを候補として返します。質問案と質疑の意味上の関連性を読んで選別し、case_id単位で質疑を重複なく数えて省庁別の構成比を示してください。複数省庁の答弁はその質疑の重みを均等に分け、記録がない場合は割合を作らないでください。",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "省庁に割り振りたい質問案。8〜1200字。" },
      search_terms: {
        type: "array",
        items: { type: "string" },
        description: "最初の2語は質問案の異なる核心概念（例：スタートアップ／女性活躍）。近くに共起する質疑だけを候補にする。残りは追加検索語。検索語が見つからなければ言い換えて再実行。",
      },
      since: { type: "string", description: "検索開始日 YYYY-MM-DD。省略時は2020-01-01。" },
    },
    required: ["question", "search_terms"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

const ministryPatterns = [
  [/経済産業|通商産業|資源エネルギー庁|中小企業庁|特許庁/, "経済産業省"],
  [/厚生労働|厚生省|労働省|医薬品医療機器総合機構/, "厚生労働省"],
  [/文部科学|文部省|科学技術庁|スポーツ庁|文化庁/, "文部科学省"],
  [/総務省|自治省|郵政省|消防庁/, "総務省"],
  [/財務省|大蔵省|国税庁/, "財務省"],
  [/外務省|外務大臣/, "外務省"],
  [/法務省|法務大臣|出入国在留管理庁/, "法務省"],
  [/農林水産|農林省|水産庁|林野庁/, "農林水産省"],
  [/国土交通|運輸省|建設省|観光庁|気象庁|海上保安庁/, "国土交通省"],
  [/環境省|環境庁/, "環境省"],
  [/防衛省|防衛庁|自衛隊/, "防衛省"],
  [/デジタル庁|デジタル大臣/, "デジタル庁"],
  [/こども家庭庁|こども政策担当|少子化対策担当/, "こども家庭庁"],
  [/内閣府|内閣官房|内閣総理大臣|官房長官|国家公安委員会|警察庁|消費者庁|公正取引委員会/, "内閣府・内閣官房等"],
];

const home = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>国会会議録エージェント接続先</title></head><body style="font:16px/1.7 system-ui;max-width:640px;margin:10vh auto;padding:24px"><h1>国会会議録エージェントの接続先</h1><p>ここは会議録を検索するエージェントの接続先です。</p><p>公開サイトは <a href="https://yagiharuka.github.io/kokkai-ministry-router/">GitHub Pages</a> でご覧ください。</p></body></html>`;

function ministryFromTitle(title) {
  for (const [pattern, ministry] of ministryPatterns) {
    if (pattern.test(title || "")) return ministry;
  }
  return null;
}

function isLawmaker(speech) {
  const role = `${speech.speakerRole || ""} ${speech.speakerPosition || ""}`;
  return Boolean(speech.speakerGroup) &&
    !/委員長|議長|副委員長|理事|大臣|副大臣|政務官|政府参考人|長官|局長|審議官|統括官/.test(role);
}

function cleaned(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function retrievalMatch(terms, text) {
  return terms.filter(term => text.includes(term)).length / terms.length;
}

function relatedSpan(value, terms, maxGap = 180) {
  const text = cleaned(value);
  const pair = terms.slice(0, 2);
  const hits = pair.map(term => {
    const found = []; let at = -1;
    while (found.length < 80 && (at = text.indexOf(term, at + 1)) >= 0) found.push(at);
    return found;
  });
  if (hits.some(list => !list.length)) return null;
  if (hits.length === 1) return { start: hits[0][0], end: hits[0][0] + pair[0].length };
  let best = null;
  for (const a of hits[0]) for (const b of hits[1]) {
    const start = Math.min(a, b);
    const end = Math.max(a + pair[0].length, b + pair[1].length);
    const gap = Math.max(0, Math.max(a, b) - Math.min(a + pair[0].length, b + pair[1].length));
    if (gap <= maxGap && (!best || end - start < best.end - best.start)) best = { start, end };
  }
  return best;
}

function excerptAroundTerms(value, terms) {
  const valueText = cleaned(value);
  const span = relatedSpan(valueText, terms);
  if (!span) return valueText.slice(0, 400);
  const start = Math.max(0, span.start - 140);
  return `${start ? "…" : ""}${valueText.slice(start, start + 400)}${start + 400 < valueText.length ? "…" : ""}`;
}

function extractCandidates(meetings, terms) {
  const rows = [];
  const seen = new Set();
  for (const meeting of meetings) {
    const speeches = [...(meeting.speechRecord || [])]
      .sort((a, b) => Number(a.speechOrder || 0) - Number(b.speechOrder || 0));
    for (let i = 0; i < speeches.length; i++) {
      const question = speeches[i];
      const questionText = cleaned(question.speech);
      if (!isLawmaker(question) || questionText.length < 20) continue;
      for (let j = i + 1; j < speeches.length; j++) {
        const answer = speeches[j];
        if (isLawmaker(answer)) break;
        const answerText = cleaned(answer.speech);
        const title = answer.speakerPosition || "";
        const ministry = ministryFromTitle(title);
        if (!answerText || !ministry) continue;
        const questionMatch = retrievalMatch(terms, questionText);
        const answerMatch = retrievalMatch(terms, answerText);
        // Long plenary speeches often contain many separate questions. A reply to
        // another topic must not inherit a keyword mentioned elsewhere in them.
        const questionSpan = relatedSpan(questionText, terms);
        const answerSpan = relatedSpan(answerText, terms);
        if (!questionSpan && !answerSpan) continue;
        if (!answerSpan && questionText.length > 1000) continue;
        const key = `${meeting.issueID || ""}:${answer.speechID || j}:${ministry}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          case_id: `${meeting.issueID || meeting.date || ""}:${question.speechID || question.speechOrder || i}`,
          question: excerptAroundTerms(questionText, terms),
          answer: excerptAroundTerms(answerText, terms),
          ministry,
          speaker: answer.speaker || "答弁者",
          speaker_title: title,
          date: meeting.date || "",
          meeting: meeting.nameOfMeeting || "",
          url: answer.speechURL || "",
          retrieval_match: Math.max(questionMatch, answerMatch),
          answer_match: answerMatch,
          question_match: questionMatch,
          context_match: answerSpan ? "answer" : "question",
        });
      }
    }
  }
  return rows.sort((a, b) =>
    (2 * b.answer_match + b.question_match) - (2 * a.answer_match + a.question_match))
    .slice(0, 30);
}

let requestQueue = Promise.resolve();
let lastRequestAt = 0;

async function fetchMeetings(term, since) {
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const previous = requestQueue;
  requestQueue = next;
  await previous;
  try {
    const pause = Math.max(0, 3000 - (Date.now() - lastRequestAt));
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    const url = new URL("https://kokkai.ndl.go.jp/api/meeting");
    url.searchParams.set("any", term);
    url.searchParams.set("from", since);
    url.searchParams.set("maximumRecords", "5");
    url.searchParams.set("recordPacking", "json");
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`国会会議録API: HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`国会会議録API: ${data.error}`);
    return Array.isArray(data.meetingRecord) ? data.meetingRecord : [];
  } finally {
    lastRequestAt = Date.now();
    release();
  }
}

async function searchAssignments(args) {
  const question = args.question;
  if (typeof question !== "string" || question.trim().length < 8 || question.length > 1200) {
    throw new Error("質問案は8〜1200字で指定してください。");
  }
  if (!Array.isArray(args.search_terms)) throw new Error("検索語を指定してください。");
  const terms = [...new Set(args.search_terms.filter(term => typeof term === "string")
    .map(term => cleaned(term).slice(0, 80)).filter(Boolean))].slice(0, 4);
  if (!terms.length) throw new Error("検索語を1つ以上指定してください。");
  const since = args.since === undefined ? "2020-01-01" : args.since;
  if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error("sinceはYYYY-MM-DD形式で指定してください。");
  }
  const meetings = new Map();
  const errors = [];
  for (const term of terms) {
    try {
      for (const meeting of await fetchMeetings(term, since)) {
        meetings.set(meeting.issueID || `${meeting.date}:${meeting.nameOfMeeting}`, meeting);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "会議録APIから取得できませんでした。");
    }
  }
  return {
    searched_terms: terms,
    meetings_searched: meetings.size,
    candidates: extractCandidates([...meetings.values()], terms),
    errors,
    interpretation: "候補は最初の2語が近くにある質疑から抽出しました。近接一致は所管の証明ではありません。質問案との意味上の関連性を判断し、重複した質疑をまとめてから集計してください。",
  };
}

function jsonRpc(id, result, version = protocolVersion) {
  return Response.json({ jsonrpc: "2.0", id, result: version === protocolVersion
    ? { resultType: "complete", ...result }
    : result }, {
    headers: { "MCP-Protocol-Version": version },
  });
}

function rpcError(id, code, message, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

async function handleMcp(request) {
  let message;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Invalid JSON", 400);
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, -32600, "Invalid Request", 400);
  }
  const id = message.id ?? null;
  if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (message.method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: legacyProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "kokkai-ministry-router", version: "0.1.0" },
      instructions: "検索語を選んでツールを呼び、質問案との関連性を読んで省庁別の構成比を計算してください。根拠URLを示し、記録がない場合は割合を作らないでください。",
    }, legacyProtocolVersion);
  }
  if (message.method === "server/discover") {
    return jsonRpc(id, {
      supportedVersions: [protocolVersion, legacyProtocolVersion],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "kokkai-ministry-router", version: "0.1.1" } },
      instructions: "検索後に候補の関連性を読み、根拠付きで省庁別の構成比を示してください。",
      ttlMs: 300000,
      cacheScope: "public",
    });
  }
  const version = request.headers.get("MCP-Protocol-Version") === legacyProtocolVersion ||
    message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === legacyProtocolVersion
    ? legacyProtocolVersion : protocolVersion;
  if (message.method === "tools/list") return jsonRpc(id, { tools: [toolDefinition] }, version);
  if (message.method === "ping") return jsonRpc(id, {}, version);
  if (message.method !== "tools/call") return rpcError(id, -32601, "Method not found");
  if (!request.headers.get("oai-authenticated-user-id")) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (message.params?.name !== toolDefinition.name) return rpcError(id, -32602, "Unknown tool");
  const args = message.params?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return rpcError(id, -32602, "Invalid tool arguments");
  }
  try {
    const result = await searchAssignments(args);
    return jsonRpc(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: result.errors.length > 0 && result.meetings_searched === 0,
    }, version);
  } catch (error) {
    return jsonRpc(id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : "検索に失敗しました。" }],
      isError: true,
    }, version);
  }
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp" && request.method === "POST") return handleMcp(request);
    if (path === "/mcp") return new Response("Method not allowed", { status: 405 });
    if (path === "/" && request.method === "GET") {
      return new Response(home, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
