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
const stop=new Set(["について","として","ため","政府","どのよう","どう","こと","もの","これ","それ","何","どこ","また","さらに","及び","並びに","より","から","ある","する","いる","れる","政策","対応","質問","現在","今後","我が国","日本","促進","推進","進める","検討","べき","では","ない","強化","必要","拡大","見直し"]);
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
function relatedSpan(value,phrases,maxGap=180){
 const text=String(value||"").replace(/\s+/g," ").trim();
 const hits=phrases.map(term=>{const found=[];let at=-1;while(found.length<80&&(at=text.indexOf(term,at+1))>=0)found.push(at);return found});
 if(hits.some(list=>!list.length))return null;
 if(hits.length===1)return {start:hits[0][0],end:hits[0][0]+phrases[0].length};
 let best=null;
 for(const a of hits[0])for(const b of hits[1]){
  const start=Math.min(a,b),end=Math.max(a+phrases[0].length,b+phrases[1].length);
  const gap=Math.max(0,Math.max(a,b)-Math.min(a+phrases[0].length,b+phrases[1].length));
  if(gap<=maxGap&&(!best||end-start<best.end-best.start))best={start,end};
 }
 return best;
}
function excerpt(value,phrases,limit){const text=String(value||"").replace(/\s+/g," ").trim();const span=relatedSpan(text,phrases);const start=span?Math.max(0,span.start-90):0;return (start?"…":"")+text.slice(start,start+limit)+(start+limit<text.length?"…":"")}
function escape(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
const api="https://kokkai-pages-api.haru620328.chatgpt.site/api/";
async function getJson(url){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
 try{const response=await fetch(url,{signal:controller.signal});if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.error||"検索APIが応答しませんでした。")}return await response.json()}
 finally{clearTimeout(timer)}
}
function lawSearchTerm(primary){
 const parts=[...segmenter.segment(primary)].filter(x=>x.isWordLike&&x.segment.length>=3&&!stop.has(x.segment)).map(x=>x.segment);
 return /^[ァ-ヶー・]+$/.test(primary)?primary:(parts[0]||primary);
}
async function analyze(input){
 const phrases=policyPhrases(input);if(!phrases.length)throw new Error("検索に使える政策名・制度名が見つかりません。質問を具体化してください。");
 const query=phrases.slice(0,2).join(" ");
 const lawTerm=lawSearchTerm(phrases[0]);
 const lawRequest=getJson(api+"jurisdiction?"+new URLSearchParams({term:lawTerm})).catch(()=>({matches:[],error:true}));
 let searched=[query],data=await getJson(api+"speech?"+new URLSearchParams({any:query,from:"2020-01-01",maximumRecords:"30",recordPacking:"json"}));
 if(phrases.length>1&&(data.speechRecord||[]).length<3){
  searched=[phrases[0]];
  data=await getJson(api+"speech?"+new URLSearchParams({any:phrases[0],from:"2020-01-01",maximumRecords:"30",recordPacking:"json"}));
 }
 const evidence=[],seen=new Set(),seenContext=new Set(),weights=new Map();
 for(const s of data.speechRecord||[]){
  const label=ministry(s),answer=s.speech||"";
  const required=phrases.slice(0,2);const span=relatedSpan(answer,required);
  if(!label||!span||!s.speechURL)continue;
  const normalized=answer.replace(/\s+/g," ").trim();const signature=normalized.slice(Math.max(0,span.start-45),span.end+45).replace(/\s+/g,"");
  if(seenContext.has(signature))continue;seenContext.add(signature);
  const key=s.speechID||s.speechURL;if(seen.has(key))continue;seen.add(key);
  const extra=phrases.slice(1).filter(p=>answer.includes(p)).length;
  const weight=1+Math.min(extra,2)*0.7;
  const v=weights.get(label)||{weight:0,count:0};v.weight+=weight;v.count++;weights.set(label,v);
  evidence.push({ministry:label,answer:excerpt(answer,required,360),speaker:s.speaker||"答弁者",position:s.speakerPosition||"",date:s.date||"",meeting:s.nameOfMeeting||"",url:s.speechURL,score:weight});
 }
 const total=[...weights.values()].reduce((n,v)=>n+v.weight,0);
 const shares=[...weights].map(([ministry,v])=>({ministry,percent:Math.round(v.weight/total*100),count:v.count})).sort((a,b)=>b.percent-a.percent);
 if(shares.length)shares[0].percent+=100-shares.reduce((n,v)=>n+v.percent,0);
 evidence.sort((a,b)=>b.score-a.score);
 const lawData=await lawRequest;
 return {shares,evidence:evidence.slice(0,8),searched,pairs:evidence.length,laws:shares.length?(lawData.matches||[]):[],lawTerm,lawTruncated:!!lawData.truncated,lawError:!!lawData.error,lawSkipped:!shares.length};
}
function render(r){$("results").hidden=false;$("results").innerHTML='<div class="heading"><div><p class="eyebrow">分析結果</p><h2>答弁担当の推定割合</h2></div><span>'+(r.pairs?r.pairs+'件の答弁発言から算出':'関連答弁なし')+'</span></div>'+(r.shares.length?'<div class="shares">'+r.shares.map((s,i)=>'<div class="share"><div class="shareline"><strong><em>'+String(i+1).padStart(2,"0")+'</em>'+escape(s.ministry)+'</strong><b>'+s.percent+'%</b></div><div class="track"><div style="width:'+s.percent+'%"></div></div><small>根拠 '+s.count+'件</small></div>').join("")+'</div><p class="caveat">割合は質問中の政策語を同じ発言に含む答弁者の内訳です。政策語が近い箇所に現れる発言だけを集計します。それでも別の論点の発言が混ざる場合があります。正式な所管や将来の答弁担当が確定する確率ではありません。少数事例では参考値として扱ってください。</p>':'<p class="caveat">政策語が近い箇所に現れる政府答弁を確認できませんでした。別の話題を無理に集計しないため、割合を表示していません。具体的な政策名や言い換えを加えて再検索してください。</p>')+(r.evidence.length?'<div class="examples"><h3>判断に使った答弁</h3>'+r.evidence.map(x=>'<article><div class="meta"><strong>'+escape(x.ministry)+'</strong><span>'+escape(x.date)+' · '+escape(x.meeting)+'</span></div><p><b>答弁</b>'+escape(x.answer)+'</p><footer><span>'+escape(x.speaker)+'（'+escape(x.position)+'）</span>'+(x.url.startsWith("https://kokkai.ndl.go.jp/")?'<a href="'+escape(x.url)+'" target="_blank" rel="noopener noreferrer">会議録の発言を見る ↗</a>':"")+'</footer></article>').join("")+'</div>':"")+(r.laws.length?'<div class="examples"><h3>法令上の所掌（e-Gov法令検索）</h3><p class="caveat">政策語「'+escape(r.lawTerm)+'」を含む所掌事務の条文です。個別事業の担当を確定する根拠ではありません。</p>'+r.laws.map(x=>'<article><div class="meta"><strong>'+escape(x.ministry)+'</strong><span>'+escape(x.title)+'</span></div><p>'+escape(x.snippet)+'</p><footer><a href="'+escape(x.url)+'" target="_blank" rel="noopener noreferrer">e-Govの法令を見る ↗</a></footer></article>').join('')+'</div>' :r.lawSkipped?'<p class="caveat">法令中の単語一致だけでは担当を判断しません。関連する答弁が見つからなかったため、法令の参考結果も表示していません。</p>':r.lawError?'<p class="caveat">法令の取得に失敗しました。法令上の所掌は確認できていません。</p>':'<p class="caveat">照合対象の設置法・組織令・組織規則に政策語「'+escape(r.lawTerm)+'」の直接の記載は見つかりませんでした。個別事業名は条文に載らない場合があります。</p>')+'<p class="caveat footnote">検索語：'+r.searched.map(escape).join("、")+'。複数語は同じ発言へのAND検索に加え、近い箇所にある場合だけ採用します。'+(r.lawTruncated?'法令検索の結果が多く、一部を照合できていません。':'')+'会議録の収録状況、発言順、役職表記により抽出漏れが生じます。実務での割り振りは担当部局が最終確認してください。</p>'}
$("question").addEventListener("input",e=>$("length").textContent=e.target.value.length+" / 1200字");
$("form").addEventListener("submit",async e=>{e.preventDefault();const input=$("question").value.trim();if(input.length<12){$("message").textContent="質問案をもう少し具体的に入力してください。";$("message").className="error";$("message").hidden=false;return}$("submit").disabled=true;$("submit").textContent="会議録を調べています…";$("results").hidden=true;$("message").className="";$("message").hidden=false;$("message").textContent="関連する答弁発言と答弁者の肩書きを調べています。";try{render(await analyze(input));$("message").hidden=true}catch(err){$("message").className="error";$("message").textContent="会議録を取得できませんでした。中継APIまたは通信状況を確認して再試行してください。詳細："+(err?.message||"不明なエラー")}finally{$("submit").disabled=false;$("submit").textContent="担当候補を調べる"}});

