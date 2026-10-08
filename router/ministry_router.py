from __future__ import annotations

import argparse
import csv
import json
import math
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://kokkai.ndl.go.jp/api/meeting"

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

STOPWORDS = {
    "について", "として", "ため", "政府", "どのよう", "どう", "こと", "もの", "これ", "それ",
    "また", "さらに", "及び", "並びに", "より", "から", "ある", "する", "いる", "れる",
    "政策", "対応", "質問", "現在", "今後", "我が国", "日本", "促進", "必要", "考え",
}

TOKEN_RE = re.compile(r"[一-龥ぁ-んァ-ヶA-Za-z0-9０-９]{2,}")
QUESTION_RE = re.compile(r"伺い|お聞き|質問|どう|なぜ|見解|お答え|いかが|でしょうか|ですか|か。")
GOVERNMENT_RE = re.compile(r"大臣|副大臣|政務官|政府参考人|政府特別補佐人|長官|局長|審議官|統括官")
CHAIR_RE = re.compile(r"委員長|議長|副委員長|理事")


@dataclass(frozen=True)
class LabeledPair:
    question: str
    answer: str
    ministry: str
    speaker: str
    position: str
    date: str
    meeting: str
    url: str


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def tokenize(text: str) -> list[str]:
    normalized = normalize_text(text)
    words = [w for w in TOKEN_RE.findall(normalized) if w not in STOPWORDS and not re.fullmatch(r"[0-9０-９]+", w)]
    compact = re.sub(r"\s+", "", normalized)
    grams = [compact[i : i + n] for n in (2, 3) for i in range(max(len(compact) - n + 1, 0))]
    return words + [g for g in grams if g not in STOPWORDS and not re.fullmatch(r"[0-9０-９]+", g)]


def ministry_from_position(position: str) -> str | None:
    for pattern, ministry in MINISTRY_PATTERNS:
        if pattern.search(position or ""):
            return ministry
    return None


def is_legislator(speech: dict) -> bool:
    role = f"{speech.get('speakerRole') or ''} {speech.get('speakerPosition') or ''}"
    return bool(speech.get("speakerGroup")) and not CHAIR_RE.search(role) and not GOVERNMENT_RE.search(role)


def is_question_like(speech: dict) -> bool:
    text = normalize_text(speech.get("speech") or "")
    return len(text) >= 35 and bool(QUESTION_RE.search(text))


def fetch_meetings(keyword: str, *, start: str, end: str | None, limit: int) -> list[dict]:
    params = {
        "any": keyword,
        "from": start,
        "maximumRecords": str(limit),
        "recordPacking": "json",
    }
    if end:
        params["until"] = end
    request = Request(f"{API_URL}?{urlencode(params)}", headers={"User-Agent": "kokkai-ministry-router/0.2"})
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload.get("meetingRecord") or []


def extract_pairs(meetings: Iterable[dict], *, lookahead: int = 6) -> list[LabeledPair]:
    pairs: list[LabeledPair] = []
    for meeting in meetings:
        speeches = sorted(meeting.get("speechRecord") or [], key=lambda s: int(s.get("speechOrder") or 0))
        for idx, question in enumerate(speeches):
            if not is_legislator(question) or not is_question_like(question):
                continue
            found = 0
            for answer in speeches[idx + 1 : idx + 1 + lookahead]:
                if is_legislator(answer):
                    break
                ministry = ministry_from_position(answer.get("speakerPosition") or "")
                if not ministry:
                    continue
                pairs.append(
                    LabeledPair(
                        question=normalize_text(question.get("speech") or ""),
                        answer=normalize_text(answer.get("speech") or ""),
                        ministry=ministry,
                        speaker=answer.get("speaker") or "",
                        position=answer.get("speakerPosition") or "",
                        date=meeting.get("date") or "",
                        meeting=meeting.get("nameOfMeeting") or "",
                        url=answer.get("speechURL") or "",
                    )
                )
                found += 1
                if found >= 3:
                    break
    return pairs


def write_jsonl(path: Path, rows: Iterable[LabeledPair]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row.__dict__, ensure_ascii=False) + "\n")
            count += 1
    return count


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def collect_dataset(keywords: list[str], out: Path, *, start: str, end: str | None, limit: int, sleep: float) -> int:
    rows: list[LabeledPair] = []
    seen: set[tuple[str, str, str, str]] = set()
    for i, keyword in enumerate(keywords, 1):
        meetings = fetch_meetings(keyword, start=start, end=end, limit=limit)
        for pair in extract_pairs(meetings):
            key = (pair.question[:120], pair.ministry, pair.date, pair.speaker)
            if key not in seen:
                rows.append(pair)
                seen.add(key)
        print(f"{i}/{len(keywords)} {keyword}: meetings={len(meetings)} pairs={len(rows)}", flush=True)
        if i != len(keywords):
            time.sleep(sleep)
    return write_jsonl(out, rows)


def split_dataset(rows: list[dict], ratio: float = 0.8) -> tuple[list[dict], list[dict]]:
    train, test = [], []
    for i, row in enumerate(rows):
        (train if i % 10 < int(ratio * 10) else test).append(row)
    return train, test


def train_centroids(rows: Iterable[dict]) -> dict[str, Counter[str]]:
    model: dict[str, Counter[str]] = defaultdict(Counter)
    for row in rows:
        model[row["ministry"]].update(tokenize(row["question"]))
    return dict(model)


def predict_ministries(question: str, model: dict[str, Counter[str]], *, topn: int = 5) -> list[dict]:
    q = Counter(tokenize(question))
    scores: dict[str, float] = {}
    for ministry, centroid in model.items():
        dot = sum(q[token] * centroid[token] for token in q)
        q_norm = math.sqrt(sum(v * v for v in q.values()))
        c_norm = math.sqrt(sum(v * v for v in centroid.values()))
        score = dot / (q_norm * c_norm) if q_norm and c_norm else 0.0
        if score > 0:
            scores[ministry] = score
    total = sum(scores.values())
    if not total:
        return []
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)[:topn]
    shares = [{"ministry": m, "percent": round(s / total * 100, 1), "score": round(s, 4)} for m, s in ranked]
    correction = round(100 - sum(item["percent"] for item in shares), 1)
    if shares:
        shares[0]["percent"] = round(shares[0]["percent"] + correction, 1)
    return shares


def evaluate(rows: list[dict]) -> dict:
    train, test = split_dataset(rows)
    model = train_centroids(train)
    correct = 0
    covered = 0
    confusion: Counter[tuple[str, str]] = Counter()
    for row in test:
        pred = predict_ministries(row["question"], model, topn=1)
        if not pred:
            continue
        covered += 1
        guess = pred[0]["ministry"]
        correct += int(guess == row["ministry"])
        confusion[(row["ministry"], guess)] += 1
    return {
        "rows": len(rows),
        "train": len(train),
        "test": len(test),
        "covered": covered,
        "accuracy": round(correct / covered, 4) if covered else None,
        "top_confusions": [
            {"actual": a, "predicted": p, "count": c}
            for (a, p), c in confusion.most_common(12)
            if a != p
        ],
    }


def export_csv(jsonl: Path, csv_path: Path) -> int:
    rows = read_jsonl(jsonl)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["ministry", "date", "meeting", "speaker", "position", "question", "answer", "url"]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build and evaluate ministry labels from NDL Diet transcripts.")
    sub = parser.add_subparsers(dest="command", required=True)

    collect = sub.add_parser("collect")
    collect.add_argument("--keyword", action="append", required=True)
    collect.add_argument("--out", default="data/labeled_pairs.jsonl")
    collect.add_argument("--from", dest="start", default="2020-01-01")
    collect.add_argument("--until", dest="end")
    collect.add_argument("--limit", type=int, default=20)
    collect.add_argument("--sleep", type=float, default=3.0)

    predict = sub.add_parser("predict")
    predict.add_argument("--data", default="data/labeled_pairs.jsonl")
    predict.add_argument("question")

    ev = sub.add_parser("evaluate")
    ev.add_argument("--data", default="data/labeled_pairs.jsonl")

    csv_cmd = sub.add_parser("csv")
    csv_cmd.add_argument("--data", default="data/labeled_pairs.jsonl")
    csv_cmd.add_argument("--out", default="data/labeled_pairs.csv")

    args = parser.parse_args()
    if args.command == "collect":
        count = collect_dataset(args.keyword, Path(args.out), start=args.start, end=args.end, limit=args.limit, sleep=args.sleep)
        print(json.dumps({"written": count, "out": args.out}, ensure_ascii=False))
    elif args.command == "predict":
        rows = read_jsonl(Path(args.data))
        print(json.dumps(predict_ministries(args.question, train_centroids(rows)), ensure_ascii=False, indent=2))
    elif args.command == "evaluate":
        print(json.dumps(evaluate(read_jsonl(Path(args.data))), ensure_ascii=False, indent=2))
    elif args.command == "csv":
        count = export_csv(Path(args.data), Path(args.out))
        print(json.dumps({"written": count, "out": args.out}, ensure_ascii=False))


if __name__ == "__main__":
    main()

