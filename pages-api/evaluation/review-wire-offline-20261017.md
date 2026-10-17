# 初回判定の出力削減と計測修正（PR #5・本番未反映）

## 変更範囲

ベースは `cf06bba11a51a0dba937b4a4ff5df63f534544db`（v79）。
不採用・保留の返却JSONで、使わない引用欄 `q` と `a` だけを省略する。ID、受益者、活動領域、対象との関係、比較理由、採否の6項目は必須。採用候補は8項目と原文番号・所有元の検証を維持する。

明示的な reject/uncertain の必須項目がそろった場合だけ、省略された未使用欄を空文字として扱う。比較理由や採用引用を補わず、不採用を採用に変えない。追加項目・数値型・nullも救済しない。
最大24候補、8件×3並列、モデル・推論設定・出力上限・追加確認・再試行方針・原文の長さは変更しない。キャッシュではなく初回出力の削減試験である。`omitted_unused_refs` は補完した行数のみを記録し、モデルの生応答を公開しない。

## 確認済みの結果

最初のオフライン形式テストは33チェックと元v79との比較1チェック、計34チェックが成功した。6件が未使用引用欄を省略する人工入力では、旧処理18/24件、修正後24/24件が形式チェックを通過し、採用4件・採用原文・構成比は変わらなかった。AIスタブは3回・最大3並列、再試行なし。6件分の返却JSONは84文字小さくなった。これは実機の秒数やトークンの削減率ではない。

2026年10月17日のGitHub Actionsでは、Node 22.16.0とNode 24の両環境で、その時点の `npm test` 全体、`npm run build`、生成されたWorkerの `node --check`、元v79との34チェック比較が成功した。
- 検証コミット: `72b9a6b91b89575e8fd81693e27b2a29170e67d7`
- 実行記録: https://github.com/yagiharuka/kokkai-ministry-router/actions/runs/39029654638
- `.github/workflows/offline-routing-checks.yml` が以後のPR更新でも全テストを行う。
- このワークフローは実機APIへの問い合わせや実際のAI推論を行わない。

## 計測スクリプトで別途発見した不具合

`evaluate-live.mjs` は旧JSON-schema専用の `request.response_format.json_schema.properties` を無条件に読んでいた。現在のJSON-object応答ではこの項目がなく、正常なHTTP応答の記録処理が例外となり、呼出側からAI失敗に見えていた。

モックHTTP応答を使う再現テストでは、旧計測コードが正常応答を `model_unavailable` にしてしまうことを確認した。修正後は検索語生成・初回判定・追加確認をそれぞれ記録でき、推論量の模擬usageも保持できる。同じテストでは全3呼出、再試行なし。別テストでは、結果が一部失敗したら次の質問を試さず停止することも確認した。

この計測バグは公開APIの本体にはなく、以前のGitHub Actionsによる17.5秒・18/24件の測定もこのスクリプトを使っていない。したがって、過去の6件未完了の原因を突き止めたとは主張しない。

`test-evaluate-live.mjs` はHTTP・資格情報・時計をすべてテスト用に置き換える。実際の資格情報や外部通信は使わず、模擬時計の数値を性能測定として出力しない。正常時と一部失敗時の両テストを `npm test` に加えた。修正後の全テストとビルドはローカルNode 22.16.0でも成功した。最新のPR更新に対する両Node環境のCI結果はPRのチェック欄を参照する。

## 再現

```sh
cd pages-api
npm test
npm run build
node --check dist/server/index.js
```

元v79との形式比較:

```sh
git show cf06bba11a51a0dba937b4a4ff5df63f534544db:pages-api/worker/semantic-review.mjs > /tmp/semantic-review-v79.mjs
node pages-api/scripts/test-review-wire.mjs --baseline /tmp/semantic-review-v79.mjs --report /tmp/review-wire-report.json
```

## 未確認・公開前の条件

Cloudflare実機での初回時間、意味判断、正例・負例の採否、旧版と同一原文・同一候補・同一キャッシュ条件の比較は未完了。公開APIとプレビューAPIへの直接の接続確認はこの作業環境から成功しなかったが、サービスの障害を示すものではない。Cloudflareプレビューのビルド成功だけを実機試験成功とは扱わない。

実機6件の原因も未特定である。20〜30秒の目標達成・速度向上・意味精度向上・無料推論消費の削減は主張しない。PRはDraftのままmainへマージしない。本番公開時にはAPIと画面のバージョンを更新する。
