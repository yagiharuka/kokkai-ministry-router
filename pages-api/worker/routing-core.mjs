// Shared, policy-independent retrieval and turn alignment. No policy -> ministry rules.
export const routingVersion = '20261009-18';
const words = new Intl.Segmenter('ja', { granularity: 'word' });
const filler = new Set(['について','における','による','に関する','として','ため','政府','どのよう','どう','こと','もの','これ','それ','何','どこ','また','さらに','及び','並びに','より','から','ある','する','いる','れる','政策','対応','質問','現在','今後','我が国','日本','促進','推進','進める','検討','べき','では','ない','すべ','強化','必要','見直し','拡大','拡充','支援','改善','整備','充実','進め','いかが','でしょう','ます','ください','お願い','伺い','お伺い','お尋ね','対策','活躍']);
export const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const distinctive = word => word.length >= 2 && !filler.has(word) && !/^\d+$/.test(word);
export function concepts(value) {
  const groups = []; let run = [], prefix = '';
  const flush = () => { if (run.length) { const text = run.join(''); groups.push({ text, parts: /^[\p{Script=Katakana}ー]+$/u.test(text) ? [text] : [...new Set(run.filter(distinctive))] }); } run = []; prefix = ''; };
  for (const part of words.segment(normalize(value))) {
    const word = part.segment.trim();
    if ((word === 'ー' || /^\p{Script=Katakana}$/u.test(word)) && run.length) { run[run.length - 1] += word; continue; }
    if (part.isWordLike && /^\p{Script=Han}$/u.test(word)) {
      if (word === '界') { flush(); continue; }
      if (run.length) run[run.length - 1] += word; else prefix = word;
      continue;
    }
    if (!part.isWordLike || !distinctive(word)) { flush(); continue; }
    run.push(prefix + word); prefix = '';
  }
  flush();
  return [...new Map(groups.filter(g => g.parts.length && g.text.length <= 80).map(g => [g.text, g])).values()].slice(0, 12);
}
function occurrences(text, term) {
  const found = []; let at = -1;
  while (found.length < 80 && (at = text.indexOf(term, at + 1)) >= 0) {
    const prefix = text.slice(Math.max(0, at - 30), at).match(/[\p{Script=Han}]+$/u)?.[0] || '';
    const suffix = text.slice(at + term.length, at + term.length + 30);
    // A product mentioned only inside another entity's name is not its own topic.
    if (prefix.length >= 2 && /^(?:[\p{Script=Han}等]{0,16})?(?:法|令|規則|機構|省|庁|委員会|審議会|部会|協会)(?=[^\p{Script=Han}]|$)/u.test(suffix)) continue;
    found.push(at);
  }
  return found;
}
function stems(part) {
  return [...new Set([part, ...(part.endsWith('化') && part.length > 2 ? [part.slice(0, -1)] : [])])];
}
function groupHit(text, group) {
  const exact = occurrences(text, group.text);
  if (exact.length) return { coverage: 1, start: exact[0], end: exact[0] + group.text.length };
  const parts = group.parts.map(part => stems(part).flatMap(stem => occurrences(text, stem).map(at => ({ at, length: stem.length }))));
  const hits = parts.filter(list => list.length).map(list => list[0]);
  if (!hits.length) return { coverage: 0 };
  return { coverage: hits.length / parts.length, start: Math.min(...hits.map(h => h.at)), end: Math.max(...hits.map(h => h.at + h.length)) };
}
export function makePlan(question, hints = []) {
  // Keep the requested change as a separate constraint, rather than treating
  // background discussion of the same topic as an answer to the proposal.
  let requestedAction = '';
  const relevanceText = normalize(question).replace(/を([\p{Script=Han}]{2,4})(?:する|す)?べき/gu,
    (whole, predicate) => {
      if (!/^(?:検討|議論|考慮|実施)$/.test(predicate)) requestedAction = predicate;
      return 'を進めるべき';
    });
  const groups = concepts(relevanceText);
  if (requestedAction && !groups.some(g => g.text === requestedAction)) groups.push({ text: requestedAction, parts: [requestedAction], role: 'requested_change' });
  // Hints change recall only. Full question concepts remain the relevance gate.
  const supplied = hints.map(normalize).filter(t => t.length >= 2 && t.length <= 80);
  if (!groups.length) for (const term of supplied) groups.push({ text: term, parts: [term] });
  const anchors = groups.map((g, i) => i === 0 || /^[\p{Script=Katakana}ー]+$/u.test(g.text) ? g.text : g.parts.reduce((a, b) => a.length >= b.length ? a : b, ''));
  const plans = [];
  const add = terms => { const query = [...new Set(terms.filter(Boolean))].join(' '); if (query && !plans.includes(query)) plans.push(query); };
  if (supplied.length) add(supplied);
  add(groups.slice(0, 3).map(g => g.text));
  add(anchors.slice(0, 3));
  // Widen the API request without dropping context from subsequent scoring.
  if (groups.length > 1) add(anchors.slice(0, 2));
  if (groups.length > 1) add([groups[1].text]);
  add([anchors[0]]);
  return { question: normalize(question), groups, queries: plans.length > 5 ? [...plans.slice(0, 4), plans.at(-1)] : plans };
}
export function isChair(speech) { return /委員長|議長|副委員長/.test(`${speech.speakerRole || ''} ${speech.speakerPosition || ''}`); }
export function isQuestioner(speech) {
  return Boolean(speech.speakerGroup) && !isChair(speech) &&
    !/大臣|副大臣|政務官|政府参考人|長官|局長|審議官|統括官/.test(`${speech.speakerRole || ''} ${speech.speakerPosition || ''}`);
}
export function passages(value) {
  const text = normalize(value), sentences = []; let start = 0;
  for (const match of text.matchAll(/[。！？?]|(?:次に|続いて|それでは)[、，]/g)) {
    const end = match.index + match[0].length;
    if (end > start) sentences.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  if (start < text.length) sentences.push({ start, end: text.length, text: text.slice(start) });
  const windows = [];
  for (let i = 0; i < sentences.length; i++) {
    for (let size = 1; size <= 5 && i + size <= sentences.length; size++) {
      const parts = sentences.slice(i, i + size);
      if (size > 1 && parts.slice(1).some(p => /^(?:次に|続いて|それでは)[、，]/.test(p.text.trim()))) break;
      const end = parts.at(-1).end;
      if (end - parts[0].start <= 800) windows.push({ start: parts[0].start, end, text: text.slice(parts[0].start, end) });
    }
  }
  return windows;
}
export function makeWeights(plan, documents = []) {
  return plan.groups.map(g => {
    const df = documents.filter(text => groupHit(normalize(text), g).coverage >= .5).length;
    return 1 + Math.log(1 + (documents.length + 1) / (df + 1));
  });
}
export function scorePassage(value, plan, weights = makeWeights(plan)) {
  const text = normalize(value), hits = plan.groups.map(g => groupHit(text, g));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const coverage = hits.reduce((sum, h, i) => sum + h.coverage * weights[i], 0) / total;
  // Every subject/target in the user's question has to have lexical support.
  // Generic request verbs were removed uniformly, independently of the policy.
  const supported = hits.length > 0 && hits.every(h => h.coverage >= .66);
  return { score: coverage, supported, hits };
}
export function matchQuestion(speech, plan, weights) {
  if (!isQuestioner(speech) || normalize(speech.speech).length < 8) return null;
  const windows = passages(speech.speech);
  let best = null;
  for (const window of windows) {
    const explicitQuestion = /[?？]|伺|お尋ね|いかが|どう|所見|べき|問う|質問|教示|答え/.test(window.text);
    if (/質問しません|質問ではありません/.test(window.text) && !/[?？]|伺|お尋ね/.test(window.text)) continue;
    const match = scorePassage(window.text, plan, weights);
    if (!match.supported) continue;
    const score = match.score + (explicitQuestion ? .02 : 0) - window.text.length / 5000;
    if (!best || score > best.score) best = { ...window, score, coverage: match.score };
  }
  return best;
}
const titleRules = [
  [/経済産業|通商産業|資源エネルギー庁|中小企業庁|特許庁/, '経済産業省'],
  [/厚生労働|厚生省|労働省/, '厚生労働省'],
  [/文部科学|文部省|科学技術庁|スポーツ庁|文化庁/, '文部科学省'],
  [/総務省|総務大臣|自治省|郵政省|消防庁/, '総務省'],
  [/財務省|財務大臣|大蔵省|国税庁/, '財務省'],
  [/金融庁|金融担当|特命担当大臣[（(]金融[）)]/, '金融庁'],
  [/外務省|外務大臣/, '外務省'], [/法務省|法務大臣|出入国在留管理庁/, '法務省'],
  [/農林水産|農林省|水産庁|林野庁/, '農林水産省'],
  [/国土交通|運輸省|建設省|観光庁|気象庁|海上保安庁/, '国土交通省'],
  [/環境省|環境庁|環境大臣/, '環境省'], [/防衛省|防衛庁|自衛隊/, '防衛省'],
  [/デジタル庁|デジタル大臣/, 'デジタル庁'], [/こども家庭庁|こども政策担当|少子化対策担当/, 'こども家庭庁'],
  [/個人情報保護委員会/, '個人情報保護委員会'],
  [/内閣府|内閣官房|内閣総理大臣|官房長官|国家公安委員会|警察庁|消費者庁|公正取引委員会/, '内閣府・内閣官房等'],
];
export function answeringMinistry(title, answer = '', previousAnswer = '') {
  const normalized = normalize(title);
  const candidates = titleRules.map(([pattern, name]) => ({ name, at: normalized.search(pattern) })).filter(r => r.at >= 0).sort((a, b) => a.at - b.at).map(r => r.name);
  const explicit = (name, source = answer) => {
    const pattern = new RegExp(`${name}(?:として|では|において|からは|といたしましては)`, 'g');
    const text = normalize(source);
    for (const m of text.slice(0, 900).matchAll(pattern)) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (/(?:所管の|担当の|関係する|連携する|対して|による|ですが、)\s*$/.test(before)) continue;
      if (/(?:私ども|我々|当省|当庁)\s*$/.test(before) || m.index === 0 || /[。 ]$/.test(before)) return true;
    }
    return false;
  };
  const named = candidates.filter(name => explicit(name));
  if (named.length === 1) return named[0];
  if (candidates.length > 1 && previousAnswer) {
    const previous = candidates.filter(name => explicit(name, previousAnswer));
    if (previous.length === 1) return previous[0];
  }
  if (candidates.length === 1 && candidates[0] === '内閣府・内閣官房等') {
    const direct = titleRules.map(([, name]) => name).filter(name => name !== candidates[0] && explicit(name));
    if (direct.length === 1) return direct[0];
  }
  const specific = candidates.filter(name => name !== '内閣府・内閣官房等');
  // A concurrent appointment is not evidence of which capacity the speaker used.
  // If the answer and nearby same-topic answer do not resolve it, abstain.
  if (specific.length > 1) return null;
  return specific[0] || candidates[0] || null;
}
export function rankQuestions(speeches, plan, limit = 4) {
  const weights = makeWeights(plan, speeches.filter(isQuestioner).map(s => s.speech));
  const byMeeting = new Map();
  for (const speech of speeches) {
    const match = matchQuestion(speech, plan, weights);
    if (!match || !speech.issueID || !speech.speechID) continue;
    const current = byMeeting.get(speech.issueID) || [];
    if (!current.some(r => r.speechID === speech.speechID)) current.push({ speechID: speech.speechID, score: match.score });
    byMeeting.set(speech.issueID, current.sort((a, b) => b.score - a.score).slice(0, 4));
  }
  return [...byMeeting].map(([id, items]) => [id, { score: items[0].score, speechIDs: items.map(r => r.speechID) }]).sort((a, b) => b[1].score - a[1].score).slice(0, limit);
}
function alignAnswer(answer, question, plan) {
  const matches = passages(answer).map(p => ({ ...p, ...scorePassage(p.text, plan) })).filter(p => p.supported);
  if (matches.length) return matches.sort((a, b) => b.score - a.score || a.text.length - b.text.length)[0];
  // Link an answer's paraphrase through the selected question's local vocabulary.
  // Contrast with the other passages in the same turn to avoid topic leakage.
  const local = concepts(question.text).flatMap(g => g.parts);
  const others = passages(question.fullText).filter(p => p.end <= question.start || p.start >= question.end).map(p => concepts(p.text).flatMap(g => g.parts));
  const overlap = text => [...new Set(local)].filter(part => occurrences(text, part).length).length;
  const queryParts = new Set(plan.groups.flatMap(g => g.parts));
  const bridgeParts = [...new Set(local)].filter(part => !queryParts.has(part) && !/^(説明|確認|内容|制度|取組|考え|認識|指摘|御指摘|所見)$/.test(part));
  const otherQuestions = (question.fullText.match(/[?？]|伺|お尋ね|教示/g) || []).length;
  const direct = passages(answer).map(p => ({ ...p, shared: overlap(p.text), bridge: bridgeParts.filter(part => occurrences(p.text, part).length).length })).filter(p => p.shared >= (otherQuestions > 1 ? 3 : 2) && p.bridge >= (otherQuestions > 1 ? 2 : 1));
  for (const p of direct.sort((a, b) => b.shared - a.shared || a.text.length - b.text.length)) {
    const conflicting = others.some(tokens => [...new Set(tokens)].filter(part => occurrences(p.text, part).length).length >= p.shared);
    const subjectRetained = groupHit(p.text, plan.groups[0]).coverage >= .66;
    if (!conflicting && subjectRetained) return { ...p, score: .75, bridged: true };
  }
  // Elliptical short replies can inherit the topic only for a single-topic turn.
  // A different substantive topic must never inherit a previous topic's ministry.
  const substantive = concepts(answer).filter(g => !/^(お答え|御指摘|指摘|承知|認識|考え|取組|取り組み|実施|実行|内容|制度|委員|提案|所存)/.test(g.text));
  const subjectHits = plan.groups.map(g => groupHit(answer, g).coverage);
  if (answer.length <= 250 && substantive.length <= 1 && otherQuestions <= 1 &&
      (subjectHits.some(x => x >= .5) || /御指摘|おっしゃ|その点|その取組|本件/.test(answer))) {
    return { text: answer, score: .5, inherited: true };
  }
  return null;
}
export function pairAnswers(meetings, plan, allowedQuestions = null) {
  const rows = new Map();
  for (const meeting of meetings) {
    const speeches = [...(meeting.speechRecord || [])].sort((a, b) => Number(a.speechOrder || 0) - Number(b.speechOrder || 0));
    for (let i = 0; i < speeches.length; i++) {
      const ask = speeches[i];
      if (allowedQuestions && !allowedQuestions.has(ask.speechID)) continue;
      const match = matchQuestion(ask, plan);
      if (!match) continue;
      const question = { ...match, fullText: normalize(ask.speech) };
      for (let j = i + 1; j < speeches.length; j++) {
        const reply = speeches[j];
        if (isQuestioner(reply)) break;
        if (isChair(reply)) continue;
        const previous = speeches.slice(Math.max(0, i - 5), i).reverse().find(s =>
          !isQuestioner(s) && !isChair(s) && s.speaker === reply.speaker &&
          s.speakerPosition === reply.speakerPosition &&
          groupHit(normalize(s.speech), plan.groups[0]).coverage >= .66);
        const answer = normalize(reply.speech), ministry = answeringMinistry(reply.speakerPosition, answer, previous?.speech || '');
        if (!ministry || !reply.speechURL) continue;
        const aligned = alignAnswer(answer, question, plan);
        if (!aligned) continue;
        const caseId = `${meeting.issueID || meeting.date}:${ask.speechID || ask.speechOrder || i}`;
        const key = `${caseId}:${ministry}`;
        const row = { case_id: caseId, ministry, question: match.text, answer: aligned.text, speaker: reply.speaker || '答弁者', position: reply.speakerPosition || '', speaker_title: reply.speakerPosition || '', date: meeting.date || '', meeting: meeting.nameOfMeeting || '', url: reply.speechURL, question_url: ask.speechURL || '', context: aligned.inherited ? 'turn' : aligned.bridged ? 'question_vocabulary' : 'answer', relevance: Math.round((match.coverage + aligned.score) / 2 * 1000) / 1000 };
        if (!rows.has(key) || row.relevance > rows.get(key).relevance) rows.set(key, row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.relevance - a.relevance || b.date.localeCompare(a.date));
}
export function summarize(rows) {
  const byCase = new Map();
  for (const row of rows) { if (!byCase.has(row.case_id)) byCase.set(row.case_id, new Set()); byCase.get(row.case_id).add(row.ministry); }
  const weights = new Map();
  for (const ministries of byCase.values()) for (const ministry of ministries) weights.set(ministry, (weights.get(ministry) || 0) + 1 / ministries.size);
  const shares = [...weights].map(([ministry, weight]) => ({ ministry, percent: Math.round(weight / byCase.size * 100), count: rows.filter(r => r.ministry === ministry).length })).sort((a, b) => b.percent - a.percent || a.ministry.localeCompare(b.ministry));
  if (shares.length) shares[0].percent += 100 - shares.reduce((sum, row) => sum + row.percent, 0);
  return { shares, pairs: byCase.size };
}
export async function retrieveAssignments(plan, fetchNdl, since = '2020-01-01') {
  const year = new Date().getUTCFullYear(), recentSince = `${year - 2}-01-01`;
  // The API returns newest records first, capped at 100 per request. Search each
  // recent year separately so a busy current year cannot hide older debates.
  const periods = [];
  for (let y = year; y >= year - 2; y--) {
    const from = `${y}-01-01`;
    if (since <= `${y}-12-31`) periods.push([since > from ? since : from, `${y}-12-31`]);
  }
  if (since < recentSince) periods.push([since, `${year - 3}-12-31`]);
  const searched = [], errors = [], meetings = new Map(); let requests = 0, searchLimited = false;
  for (const [from, until] of periods) {
    const pool = new Map(), fetched = new Set(); let rows = [];
    for (const query of plan.queries) {
      if (requests >= 14) { searchLimited = true; break; }
      try {
        requests++;
        const data = await fetchNdl('speech', { any: query, from, until, maximumRecords: '100' });
        searchLimited ||= Boolean(data.nextRecordPosition);
        searched.push(`${query}（${from.slice(0, 4)}–${until.slice(0, 4)}）`);
        for (const speech of data.speechRecord || []) pool.set(speech.speechID, speech);
        const selected = rankQuestions([...pool.values()], plan, 4);
        for (const [issueID, item] of selected) {
          if (!fetched.has(issueID)) {
            if (fetched.size >= 4 || requests >= 14) { searchLimited = true; continue; }
            requests++;
            const result = await fetchNdl('meeting', { issueID, maximumRecords: '1' });
            meetings.set(issueID, result.meetingRecord || []); fetched.add(issueID);
          }
        }
        const allowed = new Set(selected.flatMap(([, item]) => item.speechIDs));
        rows = pairAnswers([...fetched].flatMap(id => meetings.get(id)), plan, allowed);
        if (new Set(rows.map(r => r.case_id)).size >= 4) break;
      } catch (error) { errors.push(error instanceof Error ? error.message : '会議録APIを取得できませんでした。'); }
    }
    if (rows.length) return { ...summarize(rows), evidence: rows.slice(0, 8), candidates: rows.slice(0, 24), searched, meetings_searched: meetings.size, errors, partial: errors.length > 0, historical_only: from < recentSince, recent_since: recentSince, search_limited: searchLimited, routing_version: routingVersion, query_concepts: plan.groups.map(g => g.text) };
  }
  return { shares: [], pairs: 0, evidence: [], candidates: [], searched, meetings_searched: meetings.size, errors, partial: errors.length > 0, historical_only: false, recent_since: recentSince, search_limited: searchLimited, routing_version: routingVersion, query_concepts: plan.groups.map(g => g.text) };
}
