const $=id=>document.getElementById(id);
const rules=[
 [/経済産業|通商産業|資源エネルギー庁|中小企業庁|特許庁/,"経済産業省"],
 [/厚生労働|厚生省|労働省/,"厚生労働省"],
 [/文部科学|文部省|科学技術庁|スポーツ庁|文化庁/,"文部科学省"],
 [/総務省|自治省|郵政省|消防庁/,"総務省"],[/財務省|財務大臣|大蔵省|国税庁/,"財務省"],
 [/外務省|外務大臣/,"外務省"],[/法務省|法務大臣|出入国在留管理庁/,"法務省"],
 [/農林水産|農林省|水産庁|林野庁/,"農林水産省"],
 [/国土交通|運輸省|建設省|観光庁|気象庁|海上保安庁/,"国土交通省"],
 [/環境省|環境庁/,"環境省"],[/防衛省|防衛庁|自衛隊/,"防衛省"],
 [/デジタル庁|デジタル大臣/,"デジタル庁"],
 [/こども家庭庁|こども政策担当|少子化対策担当/,"こども家庭庁"],
 [/内閣府|内閣官房|国家公安委員会|警察庁|消費者庁|公正取引委員会/,"内閣府・内閣官房等"]
];
const stop=new Set(["について","として","ため","政府","どのよう","どう","こと","もの","これ","それ","何","どこ","また","さらに","及び","並びに","より","から","ある","する","いる","れる","政策","対応","質問","現在","今後","我が国","日本","促進","推進","進める","検討","べき","では","ない","強化","必要"]);
const segmenter=new Intl.Segmenter("ja",{granularity:"word"});
function policyPhrases(input){
 const chunks=[];let run=[];
 const flush=()=>{if(run.length)chunks.push(run.join(""));run=[]};
 for(const part of segmenter.segment(input)){
  const word=part.segment.trim();
  if(!part.isWordLike||word.length<2||stop.has(word)||/^[0-9０-９]+$/.test(word)){flush();continue}
  run.push(word);
 }
 flush();
 const distinctive=chunks.filter(x=>x.length>=3);
 return [...new Set(distinctive)].sort((a,b)=>b.length-a.length).slice(0,3);
}
function ministry(s){for(const [pattern,name] of rules)if(pattern.test(s.speakerPosition||""))return name;return null}
function excerpt(value,phrases,limit){const text=String(value||"").replace(/\s+/g," ").trim();const hits=phrases.map(p=>text.indexOf(p)).filter(n=>n>=0);const start=hits.length?Math.max(0,Math.min(...hits)-90):0;return (start?"…":"")+text.slice(start,start+limit)+(start+limit<text.length?"…":"")}
function escape(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function analyze(input){
 const phrases=policyPhrases(input);if(!phrases.length)throw new Error("検索に使える政策名・制度名が見つかりません。質問を具体化してください。");
 const searched=[phrases[0]];
 const params=new URLSearchParams({any:phrases[0],from:"2020-01-01",maximumRecords:"30",recordPacking:"json"});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
 let data;
 try{const response=await fetch("https://kokkai-pages-api.haru620328.chatgpt.site/api/speech?"+params,{signal:controller.signal});if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.error||"国会会議録APIが応答しませんでした。")}data=await response.json()}
 finally{clearTimeout(timer)}
 const evidence=[],seen=new Set(),weights=new Map();
 for(const s of data.speechRecord||[]){
  const label=ministry(s),answer=s.speech||"";
  if(!label||!answer.includes(phrases[0])||!s.speechURL)continue;
  const key=s.speechID||s.speechURL;if(seen.has(key))continue;seen.add(key);
  const extra=phrases.slice(1).filter(p=>answer.includes(p)).length;
  const weight=1+Math.min(extra,2)*0.7;
  const v=weights.get(label)||{weight:0,count:0};v.weight+=weight;v.count++;weights.set(label,v);
  evidence.push({ministry:label,answer:excerpt(answer,phrases,260),speaker:s.speaker||"答弁者",position:s.speakerPosition||"",date:s.date||"",meeting:s.nameOfMeeting||"",url:s.speechURL,score:weight});
 }
 const total=[...weights.values()].reduce((n,v)=>n+v.weight,0);
 const shares=[...weights].map(([ministry,v])=>({ministry,percent:Math.round(v.weight/total*100),count:v.count})).sort((a,b)=>b.percent-a.percent);
 if(shares.length)shares[0].percent+=100-shares.reduce((n,v)=>n+v.percent,0);
 evidence.sort((a,b)=>b.score-a.score);
 return {shares,evidence:evidence.slice(0,8),searched,pairs:evidence.length};
}
function render(r){$("results").hidden=false;$("results").innerHTML='<div class="heading"><div><p class="eyebrow">分析結果</p><h2>答弁担当の推定割合</h2></div><span>'+r.pairs+'件の答弁発言から算出</span></div>'+(r.shares.length?'<div class="shares">'+r.shares.map((s,i)=>'<div class="share"><div class="shareline"><strong><em>'+String(i+1).padStart(2,"0")+'</em>'+escape(s.ministry)+'</strong><b>'+s.percent+'%</b></div><div class="track"><div style="width:'+s.percent+'%"></div></div><small>根拠 '+s.count+'件</small></div>').join("")+'</div><p class="caveat">割合は取得した答弁発言の担当省庁の内訳です。質問文中の追加の政策語にも一致する発言に重みを付けています。正式な所管や将来の答弁担当が確定する確率ではありません。少数事例では参考値として扱ってください。</p>':'<p class="caveat">答弁者の肩書きから省庁を特定できる発言が見つかりませんでした。質問案に固有の政策名を加えて再検索してください。</p>')+(r.evidence.length?'<div class="examples"><h3>判断に使った答弁</h3>'+r.evidence.map(x=>'<article><div class="meta"><strong>'+escape(x.ministry)+'</strong><span>'+escape(x.date)+' · '+escape(x.meeting)+'</span></div><p><b>答弁</b>'+escape(x.answer)+'</p><footer><span>'+escape(x.speaker)+'（'+escape(x.position)+'）</span>'+(x.url.startsWith("https://kokkai.ndl.go.jp/")?'<a href="'+escape(x.url)+'" target="_blank" rel="noopener noreferrer">会議録の発言を見る ↗</a>':"")+'</footer></article>').join("")+'</div>':"")+'<p class="caveat footnote">検索語：'+r.searched.map(escape).join("、")+'。会議録の収録状況、発言順、役職表記により抽出漏れが生じます。実務での割り振りは担当部局が最終確認してください。</p>'}
$("question").addEventListener("input",e=>$("length").textContent=e.target.value.length+" / 1200字");
$("form").addEventListener("submit",async e=>{e.preventDefault();const input=$("question").value.trim();if(input.length<12){$("message").textContent="質問案をもう少し具体的に入力してください。";$("message").className="error";$("message").hidden=false;return}$("submit").disabled=true;$("submit").textContent="会議録を調べています…";$("results").hidden=true;$("message").className="";$("message").hidden=false;$("message").textContent="関連する答弁発言と答弁者の肩書きを調べています。";try{render(await analyze(input));$("message").hidden=true}catch(err){$("message").className="error";$("message").textContent="会議録を取得できませんでした。中継APIまたは通信状況を確認して再試行してください。詳細："+(err?.message||"不明なエラー")}finally{$("submit").disabled=false;$("submit").textContent="担当候補を調べる"}});
