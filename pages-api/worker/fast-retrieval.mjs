import { rankRecallQuestions, reviewCandidates, routingVersion } from './routing-core.mjs';

// Reuse complete speeches only within uninterrupted runs. A missing speech
// might be a new question; never attach a later reply across that gap.
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
      run.speechRecord.push(speech); previous = order;
    }
  }
  return runs;
}

export async function retrieveFastAssignments(plan, fetchNdl, since = '2001-01-01', options = {}) {
  const year = new Date().getUTCFullYear(), recentSince = `${year - 2}-01-01`;
  const requestLimit = Math.max(0, Math.min(3, options.maxRequests ?? 3));
  const excluded = new Set(options.excludeMeetings || []);
  const pool = new Map(), full = new Map(), searched = [], searchedQueries = [], errors = [];
  let requests = 0, searchLimited = false, queryUsed = '', hitCount = 0;
  const queryTerms = [...new Set(plan.queries)].slice(0, 2);
  // The first request already includes full speech bodies from many meetings.
  // Keep rare/older named programmes eligible; the API returns newest first.
  for (const query of queryTerms) {
    if (requests >= requestLimit) break;
    try {
      requests++;
      const data = await fetchNdl('speech', { any: query, from: since, until: `${year}-12-31`, maximumRecords: '100' });
      searched.push(`${query}（${since.slice(0, 4)}–${year}）`); searchedQueries.push(query);
      hitCount += Number(data.numberOfRecords || data.speechRecord?.length || 0);
      searchLimited ||= Boolean(data.nextRecordPosition);
      for (const speech of data.speechRecord || []) if (!excluded.has(speech.issueID)) pool.set(speech.speechID, speech);
      if (pool.size) { queryUsed = query; break; }
    } catch (error) { errors.push(error instanceof Error ? error.message : '会議録APIを取得できませんでした。'); }
  }
  const sourceRows = [...pool.values()], sparse = contiguousMeetings(sourceRows);
  const sparseReview = reviewCandidates(sparse, plan, 96);
  const sparseCases = new Set(sparseReview.map(row => row.case_id));
  const sparseMeetings = new Set(sparseReview.map(row => row.case_id.split(':')[0]));
  // Expand only when the existing complete, adjacent turns are a thin sample.
  // One meeting with repeated replies cannot satisfy this condition.
  if (queryUsed && requests < requestLimit && (sparseCases.size < 12 || sparseMeetings.size < 3)) {
    const ranked = rankRecallQuestions(sourceRows, plan, 20);
    const byId = new Map(sourceRows.map(s => [s.issueID, s]));
    const committees = [...new Set(ranked.map(([id]) => byId.get(id)?.nameOfMeeting).filter(name => name && name !== '本会議'))].slice(0, 3);
    const dates = sourceRows.map(s => s.date).filter(Boolean).sort();
    // Meeting output is ordered by house/committee, not globally by date.
    // Use the dates and committees observed in speech search so old plenary
    // reports do not occupy this batch before current question/answer turns.
    const from = dates[0] && dates[0] > since ? dates[0] : since;
    try {
      requests++;
      const data = await fetchNdl('meeting', { any: queryUsed, from, until: `${year}-12-31`, maximumRecords: '6',
        ...(committees.length ? { nameOfMeeting: committees.join(' ') } : {}) });
      searchLimited ||= Boolean(data.nextRecordPosition);
      for (const meeting of data.meetingRecord || []) if (!excluded.has(meeting.issueID)) full.set(meeting.issueID, meeting);
    } catch (error) { errors.push(error instanceof Error ? error.message : '会議録APIを取得できませんでした。'); }
  }
  const records = [...sparse.filter(m => !full.has(m.issueID)), ...full.values()];
  const review = reviewCandidates(records, plan, 96);
  const meetingIds = [...new Set(records.map(m => m.issueID))];
  return { shares: [], pairs: 0, evidence: [], candidates: [], review_candidates: review,
    searched, searched_queries: searchedQueries, requests_used: requests,
    retrieved_meetings: [...full.keys()], meetings_searched: meetingIds.length,
    full_meetings: full.size, speech_hits: hitCount, retrieved_candidates: review.length,
    retrieved_cases: new Set(review.map(row => row.case_id)).size,
    errors, partial: errors.length > 0,
    historical_only: review.length > 0 && review.every(r => r.date && r.date < recentSince),
    recent_since: recentSince, search_limited: searchLimited,
    routing_version: routingVersion, retrieval_strategy: 'speech_first_batched_meetings',
    query_concepts: plan.groups.map(g => g.text) };
}
