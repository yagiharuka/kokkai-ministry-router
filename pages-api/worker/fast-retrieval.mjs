import { rankRecallQuestions, reviewCandidates, routingVersion } from './routing-core.mjs';

// Speech search already returns complete speeches. Reuse only uninterrupted
// runs: a missing speech may be a new question, so never link across a gap.
export function contiguousMeetings(speeches) {
  const groups = new Map(), runs = [];
  for (const speech of speeches) {
    if (!speech.issueID || !speech.speechID || speech.speechOrder == null || speech.speechOrder === '' || !Number.isInteger(Number(speech.speechOrder))) continue;
    if (!groups.has(speech.issueID)) groups.set(speech.issueID, new Map());
    groups.get(speech.issueID).set(speech.speechID, speech);
  }
  for (const [issueID, group] of groups) {
    let run, previous = -2;
    for (const speech of [...group.values()].sort((a, b) => Number(a.speechOrder) - Number(b.speechOrder))) {
      const order = Number(speech.speechOrder);
      if (order !== previous + 1) {
        run = { issueID, date: speech.date || '', nameOfMeeting: speech.nameOfMeeting || '', speechRecord: [] };
        runs.push(run);
      }
      run.speechRecord.push(speech);
      previous = order;
    }
  }
  return runs;
}

export async function retrieveFastAssignments(plan, fetchNdl, since = '2020-01-01', options = {}) {
  const year = new Date().getUTCFullYear(), recentSince = `${year - 2}-01-01`;
  const from = options.includeOlder ? since : since > recentSince ? since : recentSince;
  const requestLimit = Math.max(0, Math.min(4, options.maxRequests ?? 4));
  const excluded = new Set(options.excludeMeetings || []);
  const pool = new Map(), full = new Map(), searched = [], searchedQueries = [], errors = [];
  let requests = 0, searchLimited = false;
  const queryTerms = [...new Set(plan.queries)].slice(0, 2);
  for (const query of queryTerms) {
    if (requests >= requestLimit) { searchLimited = true; break; }
    try {
      requests++;
      const data = await fetchNdl('speech', { any: query, from, until: `${year}-12-31`, maximumRecords: '100' });
      searched.push(`${query}（${from.slice(0, 4)}–${year}）`);
      searchedQueries.push(query);
      searchLimited ||= Boolean(data.nextRecordPosition);
      for (const speech of data.speechRecord || []) if (!excluded.has(speech.issueID)) pool.set(speech.speechID, speech);
    } catch (error) { errors.push(error instanceof Error ? error.message : '会議録APIを取得できませんでした。'); }
  }
  const sourceRows = [...pool.values()];
  const sparse = contiguousMeetings(sourceRows);
  const records = () => [...sparse.filter(m => !full.has(m.issueID)), ...full.values()];
  // Always expand the most relevant meeting, including replies that did not
  // repeat the search words. Expand a second only when the sample is still thin.
  const ranked = rankRecallQuestions(sourceRows, plan, 4);
  for (const [issueID] of ranked.slice(0, 2)) {
    if (requests >= requestLimit) { searchLimited = true; break; }
    if (full.size) {
      const rows = reviewCandidates(records(), plan);
      if (new Set(rows.map(r => r.case_id)).size >= 4) break;
    }
    try {
      requests++;
      const data = await fetchNdl('meeting', { issueID, maximumRecords: '1' });
      for (const meeting of data.meetingRecord || []) if (meeting.issueID === issueID) full.set(issueID, meeting);
    } catch (error) { errors.push(error instanceof Error ? error.message : '会議録APIを取得できませんでした。'); }
  }
  const review = reviewCandidates(records(), plan);
  const meetingIds = [...new Set(records().map(m => m.issueID))];
  // These are recall candidates, not accepted ministry labels. Only the
  // semantic reviewer can populate shares/evidence for the public site.
  return { shares: [], pairs: 0, evidence: [], candidates: [], review_candidates: review,
    searched, searched_queries: searchedQueries, requests_used: requests,
    retrieved_meetings: [...full.keys()], meetings_searched: meetingIds.length,
    full_meetings: full.size, errors, partial: errors.length > 0,
    historical_only: review.length > 0 && review.every(r => r.date && r.date < recentSince),
    recent_since: recentSince, search_limited: searchLimited || ranked.length > full.size,
    routing_version: routingVersion, retrieval_strategy: 'contiguous_speeches',
    query_concepts: plan.groups.map(g => g.text) };
}
