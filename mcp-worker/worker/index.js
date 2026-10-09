import { makePlan, normalize as cleaned, retrieveAssignments } from './routing-core.mjs';
const protocolVersion = "2026-07-28";
const legacyProtocolVersion = "2025-11-25";
const toolDefinition = {
  name: "search_answer_assignments",
  title: "国会答弁から所管省庁を調べる",
  description: "国会会議録から議員質問と後続の政府答弁を取得し、答弁者の肩書きと原文URLを返します。review_candidates は未判定の実際の質疑です。質問の対象・求める政策措置・国内外などの条件と、答弁が扱う内容を自然言語の文脈で照合してください。単語が一致するだけの別論点は除き、言い換えでも同じ論点なら採用してください。採用した質疑の case_id ごとに答弁担当省庁を数え、複数省庁は均等配分してください。shares は文字一致による暫定内訳であり判定結果や担当確率ではありません。",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "省庁に割り振りたい質問案。8〜1200字。" },
      search_terms: {
        type: "array",
        items: { type: "string" },
        description: "候補取得用の核心概念を1〜3語。質問案の対象・論点は全文から別に評価するため、検索語を変えても質問案を変えない。意味の一致は結果を読んで確認する。",
      },
      since: { type: "string", description: "検索開始日 YYYY-MM-DD。省略時は2020-01-01。" },
    },
    required: ["question", "search_terms"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

const home = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>国会会議録エージェント接続先</title></head><body style="font:16px/1.7 system-ui;max-width:640px;margin:10vh auto;padding:24px"><h1>国会会議録エージェントの接続先</h1><p>ここは会議録を検索するエージェントの接続先です。</p><p>公開サイトは <a href="https://yagiharuka.github.io/kokkai-ministry-router/">GitHub Pages</a> でご覧ください。</p></body></html>`;

let requestQueue = Promise.resolve();
let lastRequestAt = 0;

async function fetchNdl(path, parameters) {
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const previous = requestQueue;
  requestQueue = next;
  await previous;
  try {
    const pause = Math.max(0, 3000 - (Date.now() - lastRequestAt));
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    const url = new URL(`https://kokkai.ndl.go.jp/api/${path}`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    url.searchParams.set("recordPacking", "json");
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`国会会議録API: HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`国会会議録API: ${data.error}`);
    return data;
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
    .map(term => cleaned(term).slice(0, 80)).filter(Boolean))].slice(0, 3);
  if (!terms.length) throw new Error("検索語を1つ以上指定してください。");
  const since = args.since === undefined ? "2020-01-01" : args.since;
  if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error("sinceはYYYY-MM-DD形式で指定してください。");
  }
  const plan = makePlan(question, terms);
  const result = await retrieveAssignments(plan, fetchNdl, since);
  return {
    ...result,
    searched_terms: terms, focused_query: plan.queries[0],
    interpretation: "candidates は文字一致の厳密候補、review_candidates は未判定の質疑と実際の答弁です。shares と relevance と retrieval_score は意味の一致も担当確率も表しません。まず双方の候補について質問の対象・求める措置・範囲と答弁の意味を読み、別の施策や外国の事例紹介などを除外してください。言い換えでも同じ政策課題への答弁なら採用してください。採用した case_id のみを重複なく数え、一質疑に複数省庁なら均等に分けた構成比を示してください。判断できない候補は除外し、採用した根拠URLと少数事例・過去事例の限界を添えてください。",
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
