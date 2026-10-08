import { NextRequest, NextResponse } from "next/server";

type Speech = { speechID?:string; speaker?:string; speakerGroup?:string; speakerPosition?:string; speakerRole?:string; speech?:string; speechURL?:string; speechOrder?:number };
type Meeting = { issueID?:string; date?:string; nameOfMeeting?:string; speechRecord?:Speech[] };
type Pair = { question:string; answer:string; ministry:string; speaker:string; position:string; date:string; meeting:string; url:string; score:number };
const ministryPatterns:[RegExp,string][]=[
 [/経済産業|通商産業|資源エネルギー庁|中小企業庁|特許庁/,"経済産業省"],
 [/厚生労働|厚生省|労働省|医薬品医療機器総合機構/,"厚生労働省"],
 [/文部科学|文部省|科学技術庁|スポーツ庁|文化庁/,"文部科学省"],
 [/総務省|自治省|郵政省|消防庁/,"総務省"],
 [/財務省|大蔵省|国税庁/,"財務省"],
 [/外務省|外務大臣/,"外務省"],
 [/法務省|法務大臣|出入国在留管理庁/,"法務省"],
 [/農林水産|農林省|水産庁|林野庁/,"農林水産省"],
 [/国土交通|運輸省|建設省|観光庁|気象庁|海上保安庁/,"国土交通省"],
 [/環境省|環境庁/,"環境省"],
 [/防衛省|防衛庁|自衛隊/,"防衛省"],
 [/デジタル庁|デジタル大臣/,"デジタル庁"],
 [/こども家庭庁|こども政策担当|少子化対策担当/,"こども家庭庁"],
 [/内閣府|内閣官房|内閣総理大臣|官房長官|国家公安委員会|警察庁|消費者庁|公正取引委員会/,"内閣府・内閣官房等"]
];
const stop = new Set(["について","として","ため","政府","どのよう","どう","こと","もの","これ","それ","何","どこ","また","さらに","及び","並びに","より","から","ある","する","いる","れる","政策","対応","質問","現在","今後","我が国","日本","促進"]);
function terms(s:string):string[]{
 const words=Array.from(new Intl.Segmenter("ja",{granularity:"word"}).segment(s)).filter(x=>x.isWordLike).map(x=>x.segment.trim());
 return [...new Set(words.filter(w=>w.length>=2&&!stop.has(w)&&!/^[0-9０-９]+$/.test(w)))];
}
function ministry(s:Speech):string|null{
 const position=s.speakerPosition||"";
 // An actual title is evidence; names and the answer text must never assign a ministry.
 for(const [pattern,name] of ministryPatterns) if(pattern.test(position)) return name;
 return null;
}
function legislator(s:Speech):boolean{
 const role=(s.speakerRole||"")+" "+(s.speakerPosition||"");
 return !!s.speakerGroup && !/委員長|議長|副委員長|理事|大臣|副大臣|政務官|政府参考人/.test(role);
}
function isQuestion(s:Speech):boolean{
 const txt=s.speech||"";
 return txt.length>=35 && /伺い|お聞き|質問|どう|なぜ|見解|お答え|いかが|でしょうか|ですか|か。/.test(txt);
}
function score(input:Set<string>,candidate:string):number{
 const t=new Set(terms(candidate));
 let hit=0;for(const word of input)if(t.has(word)||candidate.includes(word))hit++;
 return hit/Math.sqrt(Math.max(input.size,1)*Math.max(t.size,1));
}
async function getMeetings(keyword:string):Promise<Meeting[]>{
 const url=new URL("https://kokkai.ndl.go.jp/api/meeting");
 url.searchParams.set("any",keyword);url.searchParams.set("from","2020-01-01");
 url.searchParams.set("maximumRecords","6");url.searchParams.set("recordPacking","json");
 const res=await fetch(url,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(18000),cache:"no-store"});
 if(!res.ok)throw new Error("国会会議録APIが応答しませんでした。時間をおいて再試行してください。");
 const data=await res.json() as {meetingRecord?:Meeting[]};
 return Array.isArray(data.meetingRecord)?data.meetingRecord:[];
}
function extract(meetings:Meeting[],query:Set<string>):Pair[]{
 const pairs:Pair[]=[];
 for(const m of meetings){
  const speeches=[...(m.speechRecord||[])].sort((a,b)=>Number(a.speechOrder||0)-Number(b.speechOrder||0));
  for(let i=0;i<speeches.length;i++){
   const q=speeches[i];if(!legislator(q)||!isQuestion(q))continue;
   const similarity=score(query,q.speech||"");if(similarity<0.055)continue;
   // A chair's procedural intervention may occur before the first answer.
   let found=0;
   for(let j=i+1;j<Math.min(i+7,speeches.length);j++){
    const a=speeches[j];if(legislator(a))break;
    const label=ministry(a);if(!label||!(a.speech||"").trim())continue;
    pairs.push({question:(q.speech||"").slice(0,260),answer:(a.speech||"").slice(0,220),ministry:label,speaker:a.speaker||"答弁者",position:a.speakerPosition||"",date:m.date||"",meeting:m.nameOfMeeting||"",url:a.speechURL||"",score:similarity});
    if(++found>=3)break;
   }
  }
 }
 return pairs.sort((a,b)=>b.score-a.score).slice(0,25);
}
export async function POST(request:NextRequest){
 try{
  const body=await request.json() as {question?:string};const question=String(body.question||"").trim();
  if(question.length<12||question.length>1200)return NextResponse.json({error:"質問案を12〜1200字で入力してください。"},{status:400});
  const tokens=terms(question);if(!tokens.length)return NextResponse.json({error:"検索に使える語が見つかりません。質問を具体化してください。"},{status:400});
  const query=new Set(tokens);
  // Start with a distinctive phrase; one fallback request only. NDL asks for sequential, spaced access.
  const sorted=[...tokens].sort((a,b)=>b.length-a.length);
  const searched:string[]=[];let meetings:Meeting[]=[];
  for(const keyword of sorted.slice(0,2)){searched.push(keyword);meetings=await getMeetings(keyword);if(meetings.length)break;await new Promise(resolve=>setTimeout(resolve,3000))}
  const pairs=extract(meetings,query);
  const weights=new Map<string,{weight:number;count:number}>();
  // One question with several departmental answers contributes fractionally per ministry.
  const groups=new Map<string,Pair[]>();for(const p of pairs){const key=p.date+"|"+p.meeting+"|"+p.question;groups.set(key,[...(groups.get(key)||[]),p])}
  for(const group of groups.values()){const unique=[...new Set(group.map(p=>p.ministry))];for(const label of unique){const v=weights.get(label)||{weight:0,count:0};v.weight+=Math.max(group[0].score,.05)/unique.length;v.count++;weights.set(label,v)}}
  const total=[...weights.values()].reduce((n,v)=>n+v.weight,0);
  const shares=[...weights].map(([ministry,v])=>({ministry,percent:Math.round(v.weight/total*100),count:v.count})).sort((a,b)=>b.percent-a.percent);
  if(shares.length)shares[0].percent+=100-shares.reduce((n,x)=>n+x.percent,0);
  return NextResponse.json({shares,evidence:pairs.slice(0,8),searched,pairs:groups.size},{headers:{"Cache-Control":"no-store"}});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"会議録の取得に失敗しました。"},{status:502})}
}
