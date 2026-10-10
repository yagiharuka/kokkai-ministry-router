const $=id=>document.getElementById(id);
const stop=new Set(["について","として","ため","政府","どのよう","どう","こと","もの","これ","それ","何","どこ","また","さらに","及び","並びに","より","から","ある","する","いる","れる","政策","対応","質問","現在","今後","我が国","日本","促進","推進","進める","検討","べき","では","ない","すべ","強化","必要","見直し"]);
const segmenter=new Intl.Segmenter("ja",{granularity:"word"});
function policyPhrases(input){
 const chunks=[];let run=[],pending="";
 const flush=()=>{if(run.length)chunks.push(run.join(""));run=[];pending=""};
 for(const part of segmenter.segment(input.normalize("NFKC"))){
  const word=part.segment.trim();
  if(word==="ー"&&run.length){run.push(word);continue}
  if(part.isWordLike&&word.length===1&&/^\p{Script=Han}$/u.test(word)){
   if(word==="界"){flush();continue}
   if(run.length)run.push(word);else pending=word;
   continue;
  }
  if(!part.isWordLike||word.length<2||stop.has(word)||/^[0-9０-９]+$/.test(word)){flush();continue}
  run.push(pending+word);pending="";
 }
 flush();
 return [...new Set(chunks.filter(x=>x.length>=2))].slice(0,3);
}
function escape(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
const api="https://kokkai-ministry-router.haru620328.workers.dev/api/";
async function getJson(url,timeout=70000){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{const response=await fetch(url,{signal:controller.signal});if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.error||"検索APIが応答しませんでした。")}return await response.json()}
 finally{clearTimeout(timer)}
}
function lawSearchTerm(primary){
 const parts=[...segmenter.segment(primary)].filter(x=>x.isWordLike&&x.segment.length>=3&&!stop.has(x.segment)).map(x=>x.segment);
 return /^[ァ-ヶー・]+$/.test(primary)?primary:(parts[0]||primary);
}
async function analyze(input){
 const started=Date.now();
 const phrases=policyPhrases(input);
 const lawTerm=phrases.length?lawSearchTerm(phrases[0]):'';
 const lawRequest=lawTerm?getJson(api+"jurisdiction?"+new URLSearchParams({term:lawTerm})).catch(()=>({matches:[],error:true})):Promise.resolve({matches:[]});
 const params={question:input,v:"20261010-34"};
 const cases=await getJson(api+"cases?"+new URLSearchParams(params),65000);
 // Supplementary laws must not delay the actual ministry result.
 return {...cases,elapsedSeconds:Math.round((Date.now()-started)/1000),question:input,unit:"質疑",laws:[],lawTerm,lawTask:lawRequest,lawSkipped:!cases.shares.length};
}
function evidenceCard(x){
 const q=x.question_evidence||x.question,a=x.answer_evidence||x.answer;
 const full=q!==x.question||a!==x.answer?'<details><summary>質疑の前後を読む</summary><p><b>質問</b>'+escape(x.question)+'</p><p><b>答弁</b>'+escape(x.answer)+'</p></details>':'';
 return '<article><div class="meta"><strong>'+escape(x.ministry)+'</strong><span>'+escape(x.date)+' · '+escape(x.meeting)+'</span></div><p><b>質問</b>'+escape(q)+'</p><p><b>答弁</b>'+escape(a)+'</p>'+(x.review_reason?'<p><b>理由</b>'+escape(x.review_reason)+'</p>':'')+full+'<footer><span>'+escape(x.speaker)+'（'+escape(x.position)+'）</span>'+(/^https:\/\/kokkai\.ndl\.go\.jp\//.test(x.url||'')?'<a href="'+escape(x.url)+'" target="_blank" rel="noopener noreferrer">会議録の発言を見る ↗</a>':'')+'</footer></article>';
}

function lawSection(r){
 const laws=r.assessment_status==='reviewed'&&r.shares?.length?r.laws||[]:[];
 return laws.length?'<div class="examples"><h3>法令上の所掌（e-Gov法令検索）</h3><p class="caveat">政策語「'+escape(r.lawTerm)+'」を含む設置法・組織令・組織規則の条文です。個別事業の担当を確定する根拠ではありません。</p>'+laws.map(x=>'<article><div class="meta"><strong>'+escape(x.ministry)+'</strong><span>'+escape(x.title)+'</span></div><p>'+escape(x.snippet)+'</p><footer><a href="'+escape(x.url)+'" target="_blank" rel="noopener noreferrer">e-Govの法令を見る ↗</a></footer></article>').join('')+'</div>':'';
}
function render(r){
 const reviewed=r.assessment_status==='reviewed';
 const shares=reviewed?r.shares||[]:[];
 const evidence=shares.length?r.evidence||[]:[];
 const pending=r.review_candidates||[];
 let title='関連質疑での答弁割合',note='',count='';
 if(shares.length){
  count=r.pairs+'件の質疑から算出';
  note='割合は、質問案と同じ政策課題への答弁として採用した質疑の省庁別内訳です。一質疑に複数省庁が答えた場合は均等に分けます。正式な所管や、将来の答弁担当になる確率ではありません。少数事例では参考値として扱ってください。';
  if(r.historical_only)note+='今回採用したのは '+escape(r.recent_since)+' より前の過去事例のみです。現在の担当を示すものとして扱わないでください。';
 }else if(r.assessment_status==='external_review'||r.assessment_status==='not_configured'||!r.assessment_status){
  title='自動判定の接続を準備しています';
  note='サイト側のAI判定がまだ接続されていません。国会図書館の会議録APIの残高不足ではありません。利用する方の支払いや設定は不要です。';
  count=pending.length?'未判定の候補 '+pending.length+'件':'';
 }else if(r.assessment_status==='failed'){
  title=r.assessment_error==='quota_exhausted'?'AI判定の本日の無料枠を使い切りました':r.assessment_error==='model_busy'?'AI判定が混み合っています':'文脈判定を完了できませんでした';
  note=r.assessment_error==='quota_exhausted'?'国会図書館のAPIではなく、AI判定サービスの無料枠による停止です。日本時間の午前9時に枠がリセットされます。有料サービスへ自動で切り替えることはありません。':'AIによる関連性の確認が完了していません。少し時間を置いて再試行してください。';
  count=pending.length?'未判定の候補 '+pending.length+'件':'';
 }else if(reviewed){
  title='採用できる答弁を確認できませんでした';
  note=pending.length?'関連性を判断するには文脈が不足する候補が残っています。今回の結果だけで担当省庁を確定できません。':'取得した候補から、質問案と同じ政策課題への答弁を確認できませんでした。質問を言い換えて再検索すると、別の候補が見つかる場合があります。';
  count=r.reviewed_candidates+'件の候補を確認';
 }else{
  title='今回の検索では候補を確認できませんでした';
  note='検索範囲と取得件数に上限があります。関連する会議録が存在しないことを示す結果ではありません。質問を言い換えて再検索してください。';
 }
 const stats=reviewed?'<p class="caveat">候補 '+Number(r.reviewed_candidates||0)+'件を確認 · '+Number(r.pairs||0)+'件を採用'+(typeof r.elapsedSeconds==='number'?' · '+r.elapsedSeconds+'秒':'')+'</p>':'';
 const shareHtml=shares.length?'<div class="shares">'+shares.map((s,i)=>'<div class="share"><div class="shareline"><strong><em>'+String(i+1).padStart(2,'0')+'</em>'+escape(s.ministry)+'</strong><b>'+s.percent+'%</b></div><div class="track"><div style="width:'+s.percent+'%"></div></div><small>根拠 '+s.count+'件</small></div>').join('')+'</div>':'';
 const acceptedHtml=evidence.length?'<div class="examples"><h3>採用した質疑</h3>'+evidence.map(evidenceCard).join('')+'</div>':'';
 const pendingHtml=pending.length?'<div class="examples"><h3>確認が必要な質疑の候補</h3><p class="caveat">関連性が未判定、または判断に文脈が足りない候補です。表示された所属は実際の答弁者の所属で、担当を確定した結果ではありません。</p>'+pending.slice(0,24).map(evidenceCard).join('')+'</div>':'';
 $('results').hidden=false;
 $('results').innerHTML='<div class="heading"><div><p class="eyebrow">分析結果</p><h2>'+title+'</h2></div><span>'+count+'</span></div>'+shareHtml+stats+'<p class="caveat">'+note+'</p>'+acceptedHtml+pendingHtml+'<div id="law-results">'+lawSection(r)+'</div>'+(r.search_limited?'<p class="caveat">取得件数の上限に達しました。確認できた一部の事例です。</p>':'')+(r.assessment_partial?'<p class="caveat">一部の候補は判定を完了できませんでした。確認できた質疑から算出しています。</p>':'')+(r.unreviewed_candidates?'<p class="caveat">ほかに未判定の候補が '+Number(r.unreviewed_candidates)+'件あります。</p>':'')+(r.partial?'<p class="caveat">一部の会議録を取得できませんでした。</p>':'');

}
$("question").addEventListener("input",e=>$("length").textContent=e.target.value.length+" / 1200字");
let latestRequest=0;
$("form").addEventListener("submit",async e=>{
 e.preventDefault();const input=$("question").value.trim();
 if(input.length<12){$("message").textContent="質問案をもう少し具体的に入力してください。";$("message").className="error";$("message").hidden=false;return}
 const requestId=++latestRequest;
 $("submit").disabled=true;$("submit").textContent="会議録を調べています…";$("results").hidden=true;$("message").className="";$("message").hidden=false;$("message").textContent="関連する会議録を検索し、質問と答弁の文脈を確認しています。";
 try{
  const result=await analyze(input);render(result);$("message").hidden=true;
  result.lawTask.then(data=>{
   if(requestId!==latestRequest)return;
   const target=$("law-results");
   if(target)target.innerHTML=lawSection({...result,laws:data.matches||[],lawTruncated:!!data.truncated,lawError:!!data.error});
  });
 }catch(err){$("message").className="error";$("message").textContent="会議録を取得できませんでした。中継APIまたは通信状況を確認して再試行してください。詳細："+(err?.message||"不明なエラー")}
 finally{$("submit").disabled=false;$("submit").textContent="担当候補を調べる"}
});
