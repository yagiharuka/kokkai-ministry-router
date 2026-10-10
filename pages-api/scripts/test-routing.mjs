import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../worker/index.js';
import { concepts, makePlan, matchQuestion, answeringMinistry, pairAnswers, reviewCandidates, summarize, retrieveAssignments, passages, isChair, isQuestioner, rankRecallQuestions } from '../worker/routing-core.mjs';
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
const ask = (text, id = 'q', order = 1) => ({ speechID:id, speechOrder:order, speech:text, speakerGroup:'会派', speechURL:'https://kokkai.ndl.go.jp/txt/fixture/'+id });
const answer = (text, title, id = 'a', order = 2) => ({ speechID:id, speechOrder:order, speech:text, speakerPosition:title, speechURL:'https://kokkai.ndl.go.jp/txt/fixture/'+id });
const record = (question, replies, id = 'meeting', date = '2025-01-01') => ({ issueID:id, nameOfMeeting:'委員会', date, speechRecord:[ask(question),...replies.map(([text,title],i)=>answer(text,title,'a'+i,i+2))] });
const route = (prompt, question, replies) => pairAnswers([record(question,replies)],makePlan(prompt));
const taxTitle = '財務大臣・内閣府特命担当大臣（金融）';
check('複数の所属が判別できなければ推測で割り振らない',()=>assert.equal(answeringMinistry(taxTitle,'研究開発税制を強化します。'),null));
check('金融担当としての明示だけは兼務を分ける',()=>assert.equal(answeringMinistry(taxTitle,'金融庁として対応します。'),'金融庁'));
check('他省への連携では答弁者の所属を変えない',()=>assert.equal(answeringMinistry('財務大臣','金融庁と連携します。'),'財務省'));
check('所管の他省への言及でラベルを変えない',()=>assert.equal(answeringMinistry('内閣府特命担当大臣','したがいまして、所管の厚生労働省においては対応します。'),'内閣府・内閣官房等'));
check('対象省の大臣肩書きを一般に読む',()=>assert.equal(answeringMinistry('総務大臣'),'総務省'));
check('長音と前後の漢字を保持',()=>assert.equal(concepts('脱炭素化とカスタマーハラスメント').map(g=>g.text).join(' '),'脱炭素化 カスタマーハラスメント'));
check('検索語を粗くしても質問全文の対象を保持',()=>assert.equal(makePlan('スタートアップ界の女性活躍推進を進めるべきではないか',['女性']).groups[0].text,'スタートアップ'));
check('自然な質問文の文法語で同じ政策の検索を狭めない',()=>{
  const short=makePlan('スタートアップ界の女性活躍推進を進めるべきではないか');
  const long=makePlan('スタートアップ分野における女性活躍を推進するため、政府はどのような支援を行っているか。');
  assert.deepEqual(long.groups,short.groups);
  assert.equal(long.queries[0],'スタートアップ 女性');
  assert.ok(long.queries.slice(0,2).includes('スタートアップ'));
  assert.ok(long.question.includes('どのような支援を行っているか'));
});
check('単一の短い語へ制度名を破壊しない',()=>assert.ok(makePlan('研究開発税制の拡充を検討すべきではないか').queries.every(q=>q.includes('研究開発税制'))));
check('助詞を政策名につなげない',()=>assert.deepEqual(makePlan('生成AIによる個人情報保護を強化すべきではないか').groups.map(g=>g.text),['生成AI','個人情報保護','強化']));
check('複合語側からも会議録を検索する',()=>assert.ok(makePlan('教員の長時間労働を是正すべきではないか').queries.includes('長時間労働')));
check('提案した措置を独立した条件として保持',()=>assert.deepEqual(makePlan('農産物の輸出を拡大すべきではないか').groups.map(g=>g.text),['農産物','輸出','拡大']));
check('外国の輸出実績を国内向け拡大策と数えない',()=>assert.equal(route('農産物の輸出を拡大すべきではないか','オランダは農産物の輸出額で世界上位です。そこで、まずお伺いいたします。',[['オランダは農産物の輸出を戦略的に進めています。','農林水産大臣']]).length,0));
check('言い換えた教員答弁を判定前の候補として残す',()=>{const plan=makePlan('教員の長時間労働を是正すべきではないか');const m=record('教員の長時間労働への対処を伺います。',[['教師の時間外在校等時間を縮減します。','文部科学大臣']]);assert.equal(pairAnswers([m],plan).length,0);const candidate=reviewCandidates([m],plan)[0];assert.equal(candidate.ministry,'文部科学省');assert.equal(candidate.screening,'unverified');assert.ok(candidate.answer.includes('時間外在校等時間'));});
check('意味判定に質問と答弁の前後文脈を渡す',()=>{const plan=makePlan('教員の長時間労働を是正すべきではないか');const m=record('教員の長時間労働について質問します。教師の負担を減らすため、教職員定数を増やせますか。',[['現場の業務量が課題です。教師の時間外在校等時間を縮減します。支援員の配置も進めます。','文部科学大臣']]);const candidate=reviewCandidates([m],plan)[0];assert.ok(candidate.question.includes('教職員定数'));assert.ok(candidate.answer.includes('支援員の配置'));});
check('話題だけ近い外国事例は未検証のまま保持',()=>{const plan=makePlan('農産物の輸出を拡大すべきではないか');const m=record('オランダの農産物の輸出額について伺います。',[['オランダの農産物輸出額を説明します。','農林水産大臣']]);assert.equal(pairAnswers([m],plan).length,0);assert.equal(reviewCandidates([m],plan)[0].screening,'unverified');});
const startup = 'スタートアップ界の女性活躍推進を進めるべきではないか';
check('女性だけ一致する別分野の質疑を除外',()=>assert.equal(route(startup,'職場の女性活躍を進めるべきではないか伺います。',[['職場の女性活躍を進めます。','厚生労働大臣']]).length,0));
check('スタートアップの対象があれば保持',()=>assert.equal(route(startup,'スタートアップの女性起業家の活躍について伺います。',[['スタートアップの女性起業家の活躍を支えます。','経済産業大臣']])[0].ministry,'経済産業省'));
check('語順が変わっても同じ対象を保持',()=>assert.ok(matchQuestion(ask('女性起業家がスタートアップで活躍するための方策を伺います。'),makePlan(startup))));
check('３つ目以降の文脈を捨てない',()=>assert.equal(route('自治体のシステム標準化とガバメントクラウドの費用について伺います。','教育のシステム標準化の費用について伺います。',[['教育システム標準化の費用を支えます。','文部科学大臣']]).length,0));
check('医療機器と医療一般を区別',()=>assert.equal(route('医療機器の承認について伺います。','医療の承認制度について伺います。',[['医療の承認制度を改善します。','厚生労働大臣']]).length,0));
check('法律名に含まれる製品名を対象と誤認しない',()=>assert.equal(route('医療機器の承認について伺います。','ワクチンの承認は医薬品医療機器等法の特例ですがいかがでしょうか。',[['ワクチンの承認を進めます。','厚生労働大臣']]).length,0));
check('審議会名の一部を製品の承認と誤認しない',()=>assert.equal(route('医療機器の承認を迅速化すべきではないか','医薬品医療機器制度部会で、医薬品の承認と迅速な治験について伺います。',[['医薬品医療機器制度部会を踏まえ医薬品の承認資料を改善します。','厚生労働大臣']]).length,0));
check('運用経費の抑制という要求を保持',()=>assert.deepEqual(makePlan('自治体のシステム標準化とガバメントクラウドの運用経費を抑制すべきではないか').groups.map(g=>g.text),['自治体','システム標準化','ガバメントクラウド','運用経費','抑制']));
check('同じ発言内の論点移動を越えて語をつなげない',()=>assert.equal(route('外国人労働者の受入れについて伺います。','外国人労働者の状況があります。次に、農作物の受入れについて伺います。',[['農作物の受入れを改善します。','農林水産大臣']]).length,0));
check('複数論点でも該当する質問部分を切り出す',()=>assert.equal(route('水道の耐震化について伺います。','まず学校給食について伺います。次に、水道の耐震化について伺います。',[['学校給食の予算を確保します。','文部科学大臣'],['水道の耐震化を進めます。','国土交通大臣']])[0].ministry,'国土交通省'));
check('答弁内の遠く離れた論点をつなげない',()=>assert.equal(route('水道の耐震化について伺います。','水道の耐震化について伺います。',[['水道の利用料金を考えます。次に、橋の耐震化を進めます。','国土交通大臣']]).length,0));
check('承認への質問を開発支援の答弁に割り振らない',()=>assert.equal(route('医療機器の承認を迅速化すべきではないか','医療機器の承認を迅速化すべきではないか伺います。',[['医療機器の開発支援を進めます。','経済産業大臣']]).length,0));
check('委員長の手続発言は答弁に数えない',()=>assert.equal(route('水道の耐震化について伺います。','水道の耐震化について伺います。',[['水道の耐震化について大臣お願いします。','委員長'],['水道の耐震化を進めます。','国土交通大臣']]).length,1));
check('役職欄が空の委員長発言と大臣挨拶を質疑にしない',()=>{
  for(const header of ['○山下委員長 次に、国務大臣。','○委員長(山田太郎君) 次に、大臣。','○山田委員長代理 次に、大臣。']) {
    const chair=ask(header);assert.equal(isChair(chair),true);assert.equal(isQuestioner(chair),false);
    const meeting=record(header,[['女性起業家の支援を推進します。一言御挨拶を申し上げます。','経済産業大臣']]);
    assert.deepEqual(reviewCandidates([meeting],makePlan('女性起業家を支援すべきではないか')),[]);
  }
  assert.equal(isChair(ask('○山田委員 委員長にお取り計らいをお願いします。')),false);
});
check('総花的な大臣演説より実際の議員質問を先に調べる',()=>{
  const plan=makePlan('スタートアップの女性起業家を支援すべきではないか');
  const speeches=[{...answer('スタートアップの女性起業家を支援します。','経済産業大臣'),issueID:'speech'}, {...ask('女性起業家の支援について伺います。'),issueID:'question'}];
  assert.equal(rankRecallQuestions(speeches,plan,1)[0][0],'question');
});
check('一度触れただけの報告より複数の質疑答弁がある会議を先に調べる',()=>{
  const plan=makePlan('研究開発税制の推進について');
  const report={...ask('研究開発税制を含む法案を報告します。'),issueID:'report',speechID:'report_q'};
  const committee=[
    {...ask('研究開発税制の活用について伺います。'),issueID:'committee',speechID:'committee_q1'},
    {...answer('研究開発税制によって投資を後押しします。','経済産業大臣'),issueID:'committee',speechID:'committee_a1'},
    {...ask('研究開発税制の効果検証について伺います。'),issueID:'committee',speechID:'committee_q2'},
    {...answer('研究開発税制の効果を検証します。','経済産業省イノベーション・環境局長'),issueID:'committee',speechID:'committee_a2'},
  ];
  assert.equal(rankRecallQuestions([report,...committee],plan,1)[0][0],'committee');
});
check('後の議員質問で答弁の対応を打ち切る',()=>{ const m=record('水道の耐震化について伺います。',[['水道の耐震化を進めます。','国土交通大臣']]);m.speechRecord.splice(1,0,ask('別の質問について伺います。','q2',2));m.speechRecord[2].speechOrder=3; assert.equal(pairAnswers([m],makePlan('水道の耐震化について伺います。')).length,0);});
check('同じ省の反復答弁を一質疑として数える',()=>assert.equal(summarize(route('研究開発税制の拡充を進めるべきではないか','研究開発税制の拡充を進めるべきではないか伺います。',[['研究開発税制を強化します。','財務大臣'],['研究開発税制を検討します。','財務大臣']])).pairs,1));
check('複数省の割合は一質疑の重みを分ける',()=>assert.deepEqual(summarize(route('研究開発税制の拡充を進めるべきではないか','研究開発税制の拡充を進めるべきではないか伺います。',[['研究開発税制を強化します。','財務大臣'],['研究開発税制を拡充します。','経済産業大臣']])).shares.map(x=>x.percent),[50,50]));
check('同じ対象の直前の答弁で兼務を判別',()=>assert.equal(answeringMinistry(taxTitle,'スタートアップの環境を改善します。','金融庁としてスタートアップの課題に対応します。'),'金融庁'));
const examples = JSON.parse(await readFile(new URL('./real-excerpts.json', import.meta.url),'utf8'));
let realPassed=0;
for(const item of examples) {
  const rows=route(item.prompt,item.question,[[item.answer,item.title]]);
  assert.equal(rows[0]?.ministry || null,item.expected,item.url);
  realPassed++;
}
const recent=record('水道の耐震化について伺います。',[['水道の耐震化を進めます。','国土交通大臣']],'new','2025-01-01');
const oldMeeting={...recent,issueID:'old',date:'2023-01-01',speechRecord:[...recent.speechRecord.slice(0,1),answer('水道の耐震化を進めます。','厚生労働大臣')]};
const calls=[];
const fakeFetch=async (path,p)=>{calls.push({path,...p});if(path==='speech'){const m=p.from>='2024-01-01'?recent:oldMeeting;return {speechRecord:p.any.includes('水道')?m.speechRecord.map(s=>({...s,issueID:m.issueID})):[]};}return {meetingRecord:[p.issueID==='new'?recent:oldMeeting]};};
const result=await retrieveAssignments(makePlan('水道の耐震化について伺います。'),fakeFetch);
check('最近の例と移管前の例を合算しない',()=>{assert.equal(result.shares[0].ministry,'国土交通省');assert.ok(!calls.some(c=>c.until==='2023-12-31'));});
const yearlyCalls=[];
const yearlyFetch=async(path,p)=>{yearlyCalls.push({path,...p});if(path==='speech')return {speechRecord:p.from==='2025-01-01'&&p.any.includes('水道')?recent.speechRecord.map(s=>({...s,issueID:recent.issueID})):[],nextRecordPosition:p.from==='2026-01-01'?101:undefined};return {meetingRecord:[recent]};};
const yearlyResult=await retrieveAssignments(makePlan('水道の耐震化について伺います。'),yearlyFetch);
check('新しい年の上位百件で古い年の質疑を隠さない',()=>{assert.equal(yearlyResult.shares[0].ministry,'国土交通省');assert.ok(yearlyCalls.some(c=>c.path==='speech'&&c.from==='2025-01-01'&&c.until==='2025-12-31'));assert.equal(yearlyResult.historical_only,false);});
const empty=await retrieveAssignments(makePlan('存在しない制度の審査について伺います。'),fakeFetch);
check('次の検索へ前の結果を持ち込まない',()=>assert.equal(empty.pairs,0));
const invalid=await worker.fetch(new Request('https://example.invalid/api/cases?question=a'));
check('質問の長さをAPIで検証',()=>assert.equal(invalid.status,400));
console.log(`${passed} behavioral checks and ${realPassed} real-excerpt cases passed. This is not a representative accuracy benchmark.`);
