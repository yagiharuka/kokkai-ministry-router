"""MCP tools for finding likely ministry respondents in Diet proceedings.

The model chooses search phrases from the user's question. This server queries
the NDL Diet Proceedings API sequentially, extracts nearby government replies,
and reports the distribution of ministry labels found in speaker titles.
"""

from __future__ import annotations

import os
import re
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP


API_URL = "https://kokkai.ndl.go.jp/api/meeting"
DEFAULT_SINCE = "2020-01-01"
MAX_SEARCH_TERMS = 2
MAX_MEETINGS_PER_TERM = 10
MAX_CANDIDATES = 30
REQUEST_PAUSE_SECONDS = 3
_API_LOCK = threading.Lock()
_LAST_REQUEST_AT = 0.0

MINISTRY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"経済産業|通商産業|資源エネルギー庁|中小企業庁|特許庁"), "経済産業省"),
    (re.compile(r"厚生労働|厚生省|労働省|医薬品医療機器総合機構"), "厚生労働省"),
    (re.compile(r"文部科学|文部省|科学技術庁|スポーツ庁|文化庁"), "文部科学省"),
    (re.compile(r"総務省|自治省|郵政省|消防庁"), "総務省"),
    (re.compile(r"財務省|大蔵省|国税庁"), "財務省"),
    (re.compile(r"外務省|外務大臣"), "外務省"),
    (re.compile(r"法務省|法務大臣|出入国在留管理庁"), "法務省"),
    (re.compile(r"農林水産|農林省|水産庁|林野庁"), "農林水産省"),
    (re.compile(r"国土交通|運輸省|建設省|観光庁|気象庁|海上保安庁"), "国土交通省"),
    (re.compile(r"環境省|環境庁"), "環境省"),
    (re.compile(r"防衛省|防衛庁|自衛隊"), "防衛省"),
    (re.compile(r"デジタル庁|デジタル大臣"), "デジタル庁"),
    (re.compile(r"こども家庭庁|こども政策担当|少子化対策担当"), "こども家庭庁"),
    (re.compile(r"内閣府|内閣官房|内閣総理大臣|官房長官|国家公安委員会|警察庁|消費者庁|公正取引委員会"), "内閣府・内閣官房等"),
]

TOKEN_RE = re.compile(r"[一-龥ぁ-んァ-ヶA-Za-z0-9０-９]{2,}")
STOPWORDS = {
    "について", "として", "ため", "政府", "どのよう", "どう", "こと", "もの",
    "これ", "それ", "また", "さらに", "及び", "並びに", "より", "から",
    "ある", "する", "いる", "れる", "政策", "対応", "質問", "現在", "今後",
    "我が国", "日本", "促進", "必要", "考え", "ください", "でしょう",
}
GOVERNMENT_RE = re.compile(r"大臣|副大臣|政務官|政府参考人|政府特別補佐人|長官|局長|審議官|統括官")
CHAIR_RE = re.compile(r"委員長|議長|副委員長|理事")


def _tokens(text: str) -> set[str]:
    return {word for word in TOKEN_RE.findall(text or "") if word not in STOPWORDS}


def _ministry_from_title(position: str) -> str | None:
    for pattern, ministry in MINISTRY_PATTERNS:
        if pattern.search(position or ""):
            return ministry
    return None


def _is_lawmaker(speech: dict[str, Any]) -> bool:
    role = f"{speech.get('speakerRole') or ''} {speech.get('speakerPosition') or ''}"
    return bool(speech.get("speakerGroup")) and not (CHAIR_RE.search(role) or GOVERNMENT_RE.search(role))


def _relevance(search_terms: list[str], speech_text: str) -> float:
    terms = [term for term in search_terms if term]
    if not terms or not speech_text:
        return 0.0
    matched = sum(1 for term in terms if term in speech_text)
    return matched / len(terms)


def _nearby(text: str, terms: list[str], max_gap: int = 180) -> tuple[int, int] | None:
    core = terms[:2]
    if not core or not all(term in text for term in core):
        return None
    positions: list[list[int]] = []
    for term in core:
        found = []
        at = -1
        while len(found) < 80:
            at = text.find(term, at + 1)
            if at < 0:
                break
            found.append(at)
        positions.append(found)
    if len(core) == 1:
        return positions[0][0], positions[0][0] + len(core[0])
    pairs = []
    for a in positions[0]:
        for b in positions[1]:
            gap = max(0, max(a, b) - min(a + len(core[0]), b + len(core[1])))
            if gap <= max_gap:
                pairs.append((min(a, b), max(a + len(core[0]), b + len(core[1]))))
    return min(pairs, key=lambda pair: pair[1] - pair[0]) if pairs else None


def _excerpt(text: str, span: tuple[int, int] | None) -> str:
    start = max(0, (span[0] - 140) if span else 0)
    return ("…" if start else "") + text[start:start + 400] + ("…" if start + 400 < len(text) else "")


def _fetch_meetings(term: str, since: str) -> list[dict[str, Any]]:
    global _LAST_REQUEST_AT
    params = urlencode({
        "any": term,
        "from": since,
        "maximumRecords": str(MAX_MEETINGS_PER_TERM),
        "recordPacking": "json",
    })
    request = Request(
        f"{API_URL}?{params}",
        headers={"Accept": "application/json", "User-Agent": "kokkai-ministry-router/0.3"},
    )
    # Serialize all requests across concurrent MCP calls, not only within one search.
    with _API_LOCK:
        wait = REQUEST_PAUSE_SECONDS - (time.monotonic() - _LAST_REQUEST_AT)
        if wait > 0:
            time.sleep(wait)
        try:
            with urlopen(request, timeout=30) as response:
                payload = response.read(12_000_000).decode("utf-8")
        except HTTPError as exc:
            raise RuntimeError(f"NDL API returned HTTP {exc.code} for search term: {term}") from exc
        except (TimeoutError, URLError) as exc:
            raise RuntimeError(f"NDL API connection failed for search term: {term}: {exc}") from exc
        finally:
            _LAST_REQUEST_AT = time.monotonic()
    try:
        import json
        data = json.loads(payload)
    except ValueError as exc:
        raise RuntimeError("NDL API did not return valid JSON; it may be busy. Retry later.") from exc
    return data.get("meetingRecord") or []


def _extract_assignments(meetings: list[dict[str, Any]], search_terms: list[str]) -> list[dict[str, Any]]:
    assignments: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for meeting in meetings:
        speeches = sorted(
            meeting.get("speechRecord") or [],
            key=lambda item: int(item.get("speechOrder") or 0),
        )
        for index, ask in enumerate(speeches):
            ask_text = " ".join((ask.get("speech") or "").split())
            if not _is_lawmaker(ask) or len(ask_text) < 20:
                continue
            for reply in speeches[index + 1:]:
                if _is_lawmaker(reply):
                    break
                reply_text = " ".join((reply.get("speech") or "").split())
                if not reply_text:
                    continue
                title = reply.get("speakerPosition") or ""
                ministry = _ministry_from_title(title)
                if not ministry:
                    continue
                ask_span = _nearby(ask_text, search_terms)
                reply_span = _nearby(reply_text, search_terms)
                if not ask_span and not reply_span:
                    continue
                if len(ask_text) > 1000 and not reply_span:
                    continue
                relevance = max(
                    _relevance(search_terms, ask_text),
                    _relevance(search_terms, reply_text),
                )
                key = (meeting.get("issueID") or "", reply.get("speechID") or "", ministry)
                if key in seen:
                    continue
                seen.add(key)
                assignments.append({
                    "case_id": f"{meeting.get('issueID') or meeting.get('date') or ''}:{ask.get('speechID') or ask.get('speechOrder') or index}",
                    "question": _excerpt(ask_text, ask_span),
                    "answer": _excerpt(reply_text, reply_span),
                    "ministry": ministry,
                    "speaker": reply.get("speaker") or "答弁者",
                    "speaker_title": title,
                    "date": meeting.get("date") or "",
                    "meeting": meeting.get("nameOfMeeting") or "",
                    "url": reply.get("speechURL") or "",
                    "relevance": round(relevance, 3),
                    "context_match": "answer" if reply_span else "question",
                })
    return sorted(assignments, key=lambda item: item["relevance"], reverse=True)


mcp = FastMCP(
    "国会会議録・省庁担当判定",
    instructions=(
        "質問案に関係する国会会議録を検索し、答弁者の肩書きを根拠に担当省庁候補を示します。"
        "質問案の異なる核心概念を最初の2語に置き、search_answer_assignmentsを呼び出してください。関連例がない場合は意味を保つ言い換えで再検索してください。"
        "返された候補は機械的な検索一致だけでは関連性が確定しないため、質問案と質疑内容を読んで関連性を判定してください。"
        "関連事例だけを使って省庁別の構成比を計算し、根拠発言と会議録URLを提示してください。"
        "該当記録が取れない場合は割合を作らないでください。"
    ),
)


@mcp.tool()
def search_answer_assignments(
    question: str,
    search_terms: list[str],
    since: str = DEFAULT_SINCE,
) -> dict[str, Any]:
    """Search NDL proceedings and return candidate question/reply pairs.

    Args:
        question: The proposed question to route.
        search_terms: Two distinct core concepts selected from the question.
            Use two distinct core concepts first; the NDL API ANDs the first two in one search. Rephrase them and retry when evidence is sparse.
        since: Earliest meeting date in YYYY-MM-DD format (defaults to 2020-01-01).
    """
    question = " ".join((question or "").split())
    if len(question) < 8 or len(question) > 1200:
        return {"error": "質問案は8〜1200字で指定してください。", "shares": [], "evidence": []}
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", since):
        return {"error": "sinceはYYYY-MM-DD形式で指定してください。", "shares": [], "evidence": []}
    terms: list[str] = []
    for raw in search_terms:
        term = " ".join(str(raw).split())[:80]
        if term and term not in terms:
            terms.append(term)
    if not terms:
        return {"error": "検索語を1つ以上指定してください。", "shares": [], "evidence": []}
    terms = terms[:MAX_SEARCH_TERMS]

    meetings_by_id: dict[str, dict[str, Any]] = {}
    searched: list[str] = []
    errors: list[str] = []
    focused_query = " ".join(terms[:2])
    for term in [focused_query]:
        searched.append(term)
        try:
            for meeting in _fetch_meetings(term, since):
                issue_id = meeting.get("issueID") or repr(meeting)
                meetings_by_id.setdefault(issue_id, meeting)
        except RuntimeError as exc:
            errors.append(str(exc))

    if not meetings_by_id and len(terms) > 1 and not errors:
        for term in terms[:2]:
            searched.append(term)
            try:
                for meeting in _fetch_meetings(term, since):
                    issue_id = meeting.get("issueID") or repr(meeting)
                    meetings_by_id.setdefault(issue_id, meeting)
            except RuntimeError as exc:
                errors.append(str(exc))

    assignments = _extract_assignments(list(meetings_by_id.values()), terms)
    if not assignments and errors and len(errors) == len(searched):
        return {"error": "会議録APIから取得できませんでした。", "details": errors, "searched_terms": searched, "candidates": []}

    return {
        "searched_terms": searched,
        "focused_query": focused_query,
        "meetings_searched": len(meetings_by_id),
        "candidate_count": len(assignments),
        "candidates": assignments[:MAX_CANDIDATES],
        "errors": errors,
        "retrieval_note": "候補は検索語と会議録本文の機械的一致で抽出しています。最終的な関連性は質問案との意味上の近さを読んで判断してください。",
    }


if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport == "streamable-http":
        mcp.settings.host = os.environ.get("MCP_HOST", "0.0.0.0")
        mcp.settings.port = int(os.environ.get("PORT", "8000"))
    mcp.run(transport=transport)
