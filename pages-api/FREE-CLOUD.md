# 無料のクラウド判定への接続

現在は接続準備中。コードと模擬応答の検証は完了したが、Cloudflareへの実接続・意味判断の精度・応答時間は未検証。旧OpenAI版の実測値を新しいモデルの結果として扱わない。

## 費用が別になる二つの処理

- 国会図書館のAPI：会議録を検索・取得する。登録やAPIキーは不要。今回のAI残高不足とは別のサービス。
- Workers AI：質問案と実際の質疑の関連性を文脈で確認する。Workers Freeでは1日10,000 Neuronsまで。使い切るとエラーになり、日本時間09:00に枠が更新される。閲覧者全員と同じアカウントの他の用途で共有する枠で、質問回数との換算は入力・出力の長さで変わる。

Workers Paidでは超過料金が発生するため、この構成には使わない。ローカルのカウンターや設定フラグが課金を止めるのではなく、Cloudflare側のFreeプランが超過実行を止める。有料サービスへの自動切替は実装していない。

## 運営者が一度だけ行う設定

1. [Cloudflare](https://dash.cloudflare.com/)で、利用するアカウントが **Workers Free** であることを確認する。有料プランへの変更、支払方法の追加、有料モデルの選択は不要。
2. Workers AIの「Use REST API」から、そのアカウントだけのWorkers AI Read / Edit権限を持つAPIトークンを作成する。Account IDも控える。
3. 公開中継サーバーの環境変数に `CLOUDFLARE_ACCOUNT_ID` と、シークレットの `CLOUDFLARE_API_TOKEN` を設定する。Freeプランを実際に確認してから `CLOUDFLARE_WORKERS_PLAN=free` を設定する。このフラグだけではアカウント契約を確認・変更できない。
4. 同じ中継サイトを再配備する。`/api/status` の `model_ready` は設定の有無を示すだけなので、会議録の実例でも動作確認する。

トークンはチャット本文、ブラウザーのコード、GitHub、`.openai/hosting.json` に貼らない。受け取る人はGitHubのサイトを開くだけで、アカウントや端末内モデルは不要。

固定モデルは `@cf/qwen/qwen3-30b-a3b-fp8`。検索計画と候補の文脈確認を実行し、省庁ラベル・URL・割合はモデルに作らせない。引用を原文と照合し、検証できない判定から割合を出さない。未接続時は通信せず即座に「準備中」を返す。

## 実接続後の確認

`npm test` は通信しない検証。明示的な実接続テストは、上記の環境変数が設定済みの環境で `node scripts/evaluate-live.mjs` を実行する。無料枠を消費するため通常テストには含めない。失敗したら後続の質問を止める。女性スタートアップ、半導体、教員、医療機器、農産物輸出、なでしこ銘柄について、引用・採否・速度を原文と比較してから配布する。

公式仕様：

- [国会会議録検索API](https://kokkai.ndl.go.jp/api.html)
- [Workers AIの料金・無料枠](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [REST APIの接続手順](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [モデルの仕様](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)
- [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
