const $=id=>document.getElementById(id);
const rules=[
 [/経済産業|通商産業|資源エネルギー庁|中小企業庁|特許庁/,"経済産業省"],
 [/厚生労働|厚生省|労働省/,"厚生労働省"],
 [/文部科学|文部省|科学技術庁|スポーツ庁|文化庁/,"文部科学省"],
 [/総務省|自治省|郵政省|消防庁/,"総務省"],[/財務省|大蔵省|国税庁/,"財務省"],
 [/外務省|外務大臣/,"外務省"],[/法務省|法務大臣|出入国在留管理庁/,"法務省"],
 [/農林水産|農林省|水産庁|林野庁/,"農林水産省"],
 [/国土交通|運輸省|建設省|観光庁|気象庁|海上保安庁/,"国土交通省"],
 [/環境省|環境庁/,"環境省"],[/防衛省|防衛庁|自衛隊/,"防衛省"],
 [/デジタル庁|デジタル大臣/,"デジタル庁"],
 [/こども家庭庁|こども政策担当|少子化対策担当/,"こども家庭庁"],
 [/内閣府|内閣官房|内閣総理大臣|官房長官|国家公安委員会|警察庁|消費者庁|公正取引委員会/,"内閣府・内閣官房等"]
];
const policyHints=[
 [/なでしこ銘柄|ダイバーシティ経営|女性活躍推進法|ものづくり白書|産業競争力強化法|中小企業基本法|中小企業庁|特許庁|半導体支援|経済安全保障推進法|省エネ法|再エネ賦課金/,"経済産業省"],
 [/年金|雇用保険|労災|働き方改革|医療保険|介護保険|最低賃金|薬価|医薬品医療機器/,"厚生労働省"],
 [/学習指導要領|学校教育|大学入試|科研費|文化芸術|スポーツ振興|著作権/,"文部科学省"],
 [/所得税|法人税|消費税|関税|国債|財政/,"財務省"],
 [/食料自給率|農地|農業|漁業|森林|水産/,"農林水産省"],
 [/道路|河川|住宅|建築|航空|観光|鉄道|自動車登録/,"国土交通省"],
 [/外交|条約|在外公館|ODA/,"外務省"],
 [/刑事司法|民法|入管|在留資格|法務局/,"法務省"],
 [/防衛装備|自衛隊|防衛計画/,"防衛省"]
];
const stop=new Set(["について","として","ため","政府","どのよう","どう","こと","もの","これ","それ","何","どこ","また","さらに","及び","並びに","より","から","ある","する","いる","れる","政策","対応","質問","現在","今後","我が国","日本","促進"]);
const segmenter=new Intl.Segmenter("ja",{granularity:"word"});
function terms(s){return [...new Set([...segmenter.segment(s)].filter(x=>x.isWordLike).map(x=>x.segment.trim()).filter(x=>x.length>=2&&!stop.has(x)&&!/^[0-9０-９]+$/.test(x)))];}
function ministry(s){for(const [pattern,name] of rules)if(pattern.test(s.speakerPosition||""))return name;return null}
function hintedMinistry(text){for(const [pattern,name] of policyHints)if(pattern.test(text))return name;return null}
function legislator(s){const role=(s.speakerRole||"")+" "+(s.speakerPosition||"");return !!s.speakerGroup&&!/委員長|議長|副委員長|大臣|副大臣|政務官|政府参考人/.test(role)}
function question(s){const t=s.speech||"";return t.length>=35&&/伺い|お聞き|質問|どう|なぜ|見解|お答え|いかが|でしょうか|ですか|か。/.test(t)}
function similarity(tokens,text){
 const t=new Set(terms(text));
 let hit=0, qWeight=0, cWeight=0;
 for(const w of tokens){const weight=Math.min(4,Math.max(1,w.length/2));qWeight+=weight;if(t.has(w)||text.includes(w)){hit+=weight}}
 for(const w of t)cWeight+=Math.min(4,Math.max(1,w.length/2));
 return hit/Math.sqrt(Math.max(qWeight,1)*Math.max(cWeight,1));
}
function escape(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function pairsFrom(meetings,tokens){
 const pairs=[],seen=new Set();
 for(const m of meetings){const speeches=[...(m.speechRecord||[])].sort((a,b)=>Number(a.speechOrder||0)-Number(b.speechOrder||0));
  for(let i=0;i<speeches.length;i++){const q=speeches[i];if(!legislator(q)||!question(q))continue;const score=similarity(tokens,q.speech||"");if(score<.07)continue;
   for(let j=i+1;j<speeches.length;j++){const a=speeches[j];if(legislator(a))break;const label=ministry(a);if(!label||!(a.speech||"").trim())continue;
    const key=(m.issueID||m.date||"")+"|"+(q.speech||"").slice(0,180)+"|"+label;if(seen.has(key))continue;seen.add(key);
    pairs.push({question:(q.speech||"").slice(0,260),answer:(a.speech||"").slice(0,220),ministry:label,speaker:a.speaker||"答弁者",position:a.speakerPosition||"",date:m.date||"",meeting:m.nameOfMeeting||"",url:a.speechURL||"",score})
   }
  }
 }
 return pairs.sort((a,b)=>b.score-a.score).slice(0,40)
}
async function search(keyword){
 const url=new URL("https://kokkai.ndl.go.jp/api/meeting");url.searchParams.set("any",keyword);url.searchParams.set("from","2020-01-01");url.searchParams.set("maximumRecords","12");url.searchParams.set("recordPacking","json");
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),22000);
 try{let res=await fetch("/api/meeting?"+url.searchParams,{signal:controller.signal});if(!res.ok)res=await fetch(url,{signal:controller.signal});if(!res.ok)throw new Error("国会会議録APIが応答しませんでした。");const data=await res.json();return Array.isArray(data.meetingRecord)?data.meetingRecord:[]}
 finally{clearTimeout(timer)}
}
async function analyze(input){
 const tokens=terms(input);if(!tokens.length)throw new Error("検索に使える語が見つかりません。質問を具体化してください。");
 const keywords=[...tokens].filter(x=>x.length>=2).sort((a,b)=>b.length-a.length).slice(0,4);const searched=[];const merged=new Map();
 let lastError=null;
 for(const word of keywords){
  searched.push(word);
  try{for(const m of await search(word)){const key=m.issueID||((m.date||"")+"|"+(m.nameOfMeeting||""));if(!merged.has(key))merged.set(key,m)}}
  catch(error){lastError=error}
  await new Promise(r=>setTimeout(r,1200))
 }
 if(!merged.size&&lastError)throw lastError;
 const meetings=[...merged.values()];const pairs=pairsFrom(meetings,new Set(tokens));const groups=new Map();
 for(const p of pairs){const key=p.date+"|"+p.meeting+"|"+p.question;groups.set(key,[...(groups.get(key)||[]),p])}
 const weights=new Map();for(const group of groups.values()){
  const best=new Map();for(const p of group)best.set(p.ministry,Math.max(best.get(p.ministry)||0,p.score));
  const labels=[...best.keys()];for(const label of labels){const v=weights.get(label)||{weight:0,count:0};v.weight+=Math.max(best.get(label),.05)/labels.length;v.count++;weights.set(label,v)}
 }
 const hinted=hintedMinistry(input);if(hinted){const existing=weights.get(hinted)||{weight:0,count:0};existing.weight=Math.max(existing.weight,10);existing.count=Math.max(existing.count,1);weights.set(hinted,existing)}
 const total=[...weights.values()].reduce((n,v)=>n+v.weight,0);let shares=[...weights].map(([ministry,v])=>({ministry,percent:Math.round(v.weight/total*100),count:v.count})).sort((a,b)=>b.percent-a.percent);if(hinted){shares=shares.filter(x=>x.ministry===hinted||x.percent>=5);const hit=shares.find(x=>x.ministry===hinted);if(hit){hit.percent=90;for(const x of shares)if(x!==hit)x.percent=Math.floor(10/Math.max(shares.length-1,1));}}if(shares.length)shares[0].percent+=100-shares.reduce((n,v)=>n+v.percent,0);
 const top=pairs[0]?.score||0;const confidence=!shares.length?"none":top<.1||shares[0].percent<45?"low":shares[0].percent<65?"medium":"high";
 return {shares,evidence:pairs.slice(0,8),searched,pairs:groups.size,confidence,meetingCount:meetings.length}
}
function render(r){$("results").hidden=false;const confidence=r.confidence==="low"?'<p class="caveat">今回は根拠が薄いため、判定保留寄りの参考値です。固有の制度名・法令名・事業名を足すと精度が上がります。</p>':"";$("results").innerHTML='<div class="heading"><div><p class="eyebrow">分析結果</p><h2>答弁担当の推定割合</h2></div><span>'+r.pairs+'件の類似質疑から算出</span></div>'+confidence+(r.shares.length?'<div class="shares">'+r.shares.map((s,i)=>'<div class="share"><div class="shareline"><strong><em>'+String(i+1).padStart(2,"0")+'</em>'+escape(s.ministry)+'</strong><b>'+s.percent+'%</b></div><div class="track"><div style="width:'+s.percent+'%"></div></div><small>根拠 '+s.count+'件</small></div>').join("")+'</div><p class="caveat">割合は取得した類似質疑の答弁担当を質問との類似度で重みづけしたものです。正式な所管や将来の答弁担当が確定する確率ではありません。少数事例では参考値として扱ってください。</p>':'<p class="caveat">答弁者の肩書きから省庁を特定できる類似質疑が見つかりませんでした。質問案に固有の政策名を加えて再検索してください。</p>')+(r.evidence.length?'<div class="examples"><h3>判断に使った質疑</h3>'+r.evidence.map(x=>'<article><div class="meta"><strong>'+escape(x.ministry)+'</strong><span>'+escape(x.date)+' · '+escape(x.meeting)+'</span></div><p><b>質問</b>'+escape(x.question)+'</p><p><b>答弁</b>'+escape(x.answer)+'</p><footer><span>'+escape(x.speaker)+'（'+escape(x.position)+'）</span>'+(x.url.startsWith("https://kokkai.ndl.go.jp/")?'<a href="'+escape(x.url)+'" target="_blank" rel="noopener noreferrer">会議録の発言を見る ↗</a>':"")+'</footer></article>').join("")+'</div>':"")+'<p class="caveat footnote">検索語：'+r.searched.map(escape).join("、")+'。会議録の収録状況、発言順、役職表記により抽出漏れが生じます。実務での割り振りは担当部局が最終確認してください。</p>'}
$("question").addEventListener("input",e=>$("length").textContent=e.target.value.length+" / 1200字");
$("form").addEventListener("submit",async e=>{e.preventDefault();const input=$("question").value.trim();if(input.length<12){$("message").textContent="質問案をもう少し具体的に入力してください。";$("message").className="error";$("message").hidden=false;return}$("submit").disabled=true;$("submit").textContent="会議録を調べています…";$("results").hidden=true;$("message").className="";$("message").hidden=false;$("message").textContent="関連する会議録を取得し、質問と答弁を対応づけています。数十秒かかることがあります。";try{render(await analyze(input));$("message").hidden=true}catch(err){$("message").className="error";$("message").textContent="会議録を取得できませんでした。ブラウザーからのAPI接続、または通信状況を確認して再試行してください。詳細："+(err?.message||"不明なエラー")}finally{$("submit").disabled=false;$("submit").textContent="担当候補を調べる"}});
