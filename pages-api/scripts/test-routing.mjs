import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Load private helpers without adding diagnostic endpoints or production exports.
const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const core = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { ministryOf, questionMatch, extractCases, selectQuestions, routeCases, relatedWord };').toString('base64'));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
const speech = (id, order, text, position = '', group = '') => ({
  speechID: id, speechOrder: order, speech: text, speakerPosition: position, speakerGroup: group,
  speechURL: 'https://kokkai.ndl.go.jp/txt/fixture/' + id,
});
const meeting = (id, date, question, answers) => ({ issueID: id, date, nameOfMeeting: '委員会',
  speechRecord: [speech(id + '_q', 1, question, '', '会派'), ...answers.map(([text, position], i) => speech(id + '_a' + i, i + 2, text, position))] });
const taxTitle = '財務大臣・内閣府特命担当大臣（金融）';
check('兼務大臣の税制答弁を金融庁へ自動で振らない', () => assert.equal(core.ministryOf(taxTitle, '研究開発税制を見直します。'), '財務省'));
check('金融庁としての自己言及を優先', () => assert.equal(core.ministryOf(taxTitle, '金融庁として女性起業家を支えます。'), '金融庁'));
check('他省庁との連携への言及だけでは所属を変えない', () => assert.equal(core.ministryOf(taxTitle, '金融庁と連携します。租税の制度を見直します。'), '財務省'));
check('内閣府副大臣の金融庁答弁を判別', () => assert.equal(core.ministryOf('内閣府副大臣', '金融庁として地域金融力を強化します。'), '金融庁'));
check('全角英字と英数半角を照合', () => assert.ok(core.questionMatch(speech('q', 1, '生成ＡＩによる個人情報保護の課題について伺います。', '', '会派'), ['生成AI', '個人情報保護'])));
check('３つ目の目的を省略しない', () => assert.equal(core.questionMatch(speech('q', 1, '医療機器の承認審査の仕組みについて伺います。', '', '会派'), ['医療機器', '承認'], '迅速化'), null));
check('迅速化の語幹でも質問の目的を照合', () => assert.ok(core.questionMatch(speech('q', 1, '医療機器の承認を迅速に進める方策について伺います。', '', '会派'), ['医療機器', '承認'], '迅速化')));
check('水道だけの答弁を耐震化の答弁として採らない', () => assert.equal(core.extractCases([meeting('water', '2025-01-01', '水道の耐震化にどのような対策を講じるのか伺います。', [['水道サービスのため都市の立地を誘導します。', '国土交通大臣']])], ['水道', '耐震化'], '水道 耐震化').length, 0));
check('拡充を強化と言い換えた答弁を落とさない', () => assert.equal(core.extractCases([meeting('tax', '2025-01-01', '研究開発税制の拡充について、制度をどう進めるのか伺います。', [['研究開発税制についてインセンティブを強化します。', taxTitle]])], ['研究開発税制', '拡充'], '研究開発税制 拡充')[0].ministry, '財務省'));
check('次の論点へ移った質問を除外', () => assert.equal(core.questionMatch(speech('q', 1, '外国人労働者の受入れに課題があります。次に、避難所の対策について伺います。', '', '会派'), ['外国人労働者', '受入れ']), null));
check('助動詞を関連政策語にしない', () => assert.equal(core.relatedWord('水道水に含まれる水質基準', '水道水', '水質'), null));
check('法律名の一部だけで別製品の承認を拾わない', () => assert.equal(core.questionMatch(speech('q', 1, 'ワクチンの承認は医薬品医療機器等法の特例で短縮されたと思いますが、いかがでしょうか。', '', '会派'), ['医療機器', '承認']), null));
check('組織名の一部だけで別製品の承認を拾わない', () => assert.equal(core.questionMatch(speech('q', 1, '医薬品の承認審査を行う医薬品医療機器総合機構について簡単に説明していただけますか。', '', '会派'), ['医療機器', '承認']), null));
check('同一会議の別の関連質問も候補に残す', () => {
  const q = { ...speech('q1', 1, '水道の耐震化について、その対策を伺います。', '', '会派'), issueID: 'same', nameOfMeeting: '委員会' };
  assert.deepEqual(core.selectQuestions([q, { ...q, speechID: 'q2' }], ['水道', '耐震化'])[0][1].speechIDs, ['q1', 'q2']);
});

const frontend = await readFile(new URL('../../dist/app.js', import.meta.url), 'utf8');
const parse = new Function(frontend.slice(frontend.indexOf('const stop='), frontend.indexOf('function ministry(')) + ';return policyPhrases;')();
check('カタカナの長音を保持', () => assert.deepEqual(parse('カスタマーハラスメント対策を強化すべきではないか'), ['カスタマーハラスメント対策']));
check('否定・汎用動詞ではなく３つの核心概念を保持', () => assert.deepEqual(parse('医療機器の承認を迅速化すべきではないか'), ['医療機器', '承認', '迅速化']));

const recent = meeting('recent', '2025-01-01', '水道の耐震化を進める対策について、政府に伺います。', [['水道の耐震化を支援します。', '国土交通大臣']]);
const old = meeting('old', '2023-01-01', recent.speechRecord[0].speech, [['水道の耐震化を支援します。', '厚生労働大臣']]);
const calls = [];
globalThis.fetch = async input => {
  const u = new URL(input); calls.push(u);
  if (u.pathname === '/api/speech') {
    const record = u.searchParams.get('from') >= '2024-01-01' ? recent : old;
    if (!u.searchParams.get('any').includes('水道')) return Response.json({ speechRecord: [] });
    return Response.json({ speechRecord: record.speechRecord.map(x => ({ ...x, issueID: record.issueID, nameOfMeeting: record.nameOfMeeting, date: record.date })) });
  }
  return Response.json({ meetingRecord: [u.searchParams.get('issueID') === 'recent' ? recent : old] });
};
const recentResult = await core.routeCases('水道', '耐震化');
check('最近の答弁に移管前の所属を合算しない', () => { assert.deepEqual(recentResult.shares.map(x => x.ministry), ['国土交通省']); assert.equal(recentResult.historical_only, false); assert.ok(!calls.some(u => u.searchParams.get('until') === '2023-12-31')); });
const empty = await core.routeCases('存在しない政策', '検証');
check('前の検索結果を引き継がない', () => { assert.equal(empty.pairs, 0); assert.deepEqual(empty.shares, []); });
console.log(`${passed} regression checks passed (synthetic fixtures, not an accuracy benchmark).`);
