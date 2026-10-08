"use client";
import { useState } from "react";
type Example = {question:string;answer:string;ministry:string;speaker:string;position:string;date:string;meeting:string;url:string};
type Result = {shares:{ministry:string;percent:number;count:number}[];evidence:Example[];searched:string[];pairs:number;error?:string};
export default function Home(){
 const [question,setQuestion]=useState(""); const [result,setResult]=useState<Result|null>(null); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
 async function submit(e:React.FormEvent){e.preventDefault();if(question.trim().length<12){setError("質問案をもう少し具体的に入力してください。");return}setBusy(true);setError("");setResult(null);
 try{const res=await fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question})});const data:Result=await res.json();if(!res.ok)throw new Error(data.error||"検索に失敗しました。");setResult(data)}catch(err){setError(err instanceof Error?err.message:"検索に失敗しました。")}finally{setBusy(false)}}
 return <main><header><div className="brand"><span className="mark">国</span>国会答弁・所管省庁ナビ</div><span className="source">国立国会図書館の会議録を参照</span></header><div className="content">
 <div className="intro"><p className="eyebrow">質問案の担当を推定</p><h1>この質問は、どの省庁が答えたか。</h1><p>過去の国会質疑から、質問の後に答えた政府側の発言者を調べます。似た質疑の答弁担当を割合と根拠で示します。</p></div>
 <form onSubmit={submit} className="query"><label htmlFor="question">質問案</label><textarea id="question" value={question} onChange={e=>setQuestion(e.target.value)} maxLength={1200} placeholder="例：医療機器の国内開発を促進するため、研究開発支援と薬事承認の迅速化を政府としてどう進めるのか。" /><div className="actions"><span>{question.length} / 1200字</span><button disabled={busy}>{busy?"会議録を調べています…":"担当候補を調べる"}</button></div></form>
 {error&&<p className="error" role="alert">{error}</p>}{busy&&<p className="notice" role="status">関連する会議録を取得し、質問と答弁を対応づけています。数十秒かかることがあります。</p>}
 {result&&<section className="results" aria-live="polite"><div className="heading"><div><p className="eyebrow">分析結果</p><h2>答弁担当の推定割合</h2></div><span>{result.pairs}件の類似質疑から算出</span></div>
 {result.shares.length?<><div className="shares">{result.shares.map((s,i)=><div className="share" key={s.ministry}><div className="shareline"><strong><em>{String(i+1).padStart(2,"0")}</em>{s.ministry}</strong><b>{s.percent}%</b></div><div className="track"><div style={{width:`${s.percent}%`}} /></div><small>根拠 {s.count}件</small></div>)}</div><p className="caveat">割合は取得した類似質疑の答弁担当を質問との類似度で重みづけしたものです。正式な所管や将来の答弁担当が確定する確率ではありません。少数事例では参考値として扱ってください。</p></>:<p className="notice">答弁者の肩書きから省庁を特定できる類似質疑が見つかりませんでした。質問案に固有の政策名を加えて再検索してください。</p>}
 {!!result.evidence.length&&<div className="examples"><h3>判断に使った質疑</h3>{result.evidence.map((x,i)=><article key={i}><div className="meta"><strong>{x.ministry}</strong><span>{x.date} · {x.meeting}</span></div><p><b>質問</b>{x.question}</p><p><b>答弁</b>{x.answer}</p><footer><span>{x.speaker}（{x.position}）</span><a href={x.url} target="_blank" rel="noopener noreferrer">会議録の発言を見る ↗</a></footer></article>)}</div>}
 <p className="caveat footnote">検索語：{result.searched.join("、")}。会議録の収録状況、発言順、役職表記により抽出漏れが生じます。実務での割り振りは担当部局が最終確認してください。</p></section>}
 </div></main>
}
