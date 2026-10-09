# 無料のクラウド判定への接続

現在は接続準備中。コードと模擬応答の検証は完了したが、Cloudflareへの実接続・意味判断の精度・応答時間は未検証。旧OpenAI版の実測値を新しいモデルの結果として扱わない。

## 費用が別になる二つの処理

- 国会図書館のAPI：会議録を検索・取得する。登録やAPIキーは不要。今回のAI残高不足とは別のサービス。
- Workers AI：質問案と実際の質疑の関連性を文脈で確認する。Workers Freeでは1日10,000 Neuronsまで。使い切るとエラーになり、日本時間09:00に枠が更新される。閲覧者全員と同じアカウントの他の用途で共有する枠で、質問回数との換算は入力・出力の長さで変わる。

Workers Paidでは超過料金が発生するため、この構成には使わない。ローカルのカウンターや設定フラグが課金を止めるのではなく、Cloudflare側のFreeプランが超過実行を止める。有料サービスへの自動切替は実装していない。

## 推奨する接続方法

1. [Cloudflare](https://dash.cloudflare.com/)で、利用するアカウントが **Workers Free** であることを確認する。有料プランへの変更、支払方法の追加、有料モデルの選択は不要。
2. CloudflareのGit連携でこのリポジトリを選び、ルートディレクトリを `pages-api` にして配備する。
3. `wrangler.jsonc` のWorkers AI bindingが、同じCloudflareアカウントのAIを直接呼び出す。公開サイトやGitHubにAPIトークンを保存する必要はない。
4. `/api/status` の `model_ready` と会議録の実例で動作確認する。

REST接続も互換用として残しているが、トークンはチャット本文、ブラウザーのコード、GitHub、`.openai/hosting.json` に貼らない。受け取る人はGitHubのサイトを開くだけで、アカウントや端末内モデルは不要。

固定モデルはCloudflare上のOpenAI公開モデル `@cf/openai/gpt-oss-20b`。検索計画と候補の文脈確認を実行し、省庁ラベル・URL・割合はモデルに作らせない。引用を原文と照合し、検証できない判定から割合を出さない。未接続時は通信せず即座に「準備中」を返す。

## 実接続後の確認

`npm test` は通信しない検証。明示的な実接続テストは、上記の環境変数が設定済みの環境で `node scripts/evaluate-live.mjs` を実行する。無料枠を消費するため通常テストには含めない。失敗したら後続の質問を止める。女性スタートアップ、半導体、教員、医療機器、農産物輸出、なでしこ銘柄について、引用・採否・速度を原文と比較してから配布する。

公式仕様：

- [国会会議録検索API](https://kokkai.ndl.go.jp/api.html)
- [Workers AIの料金・無料枠](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [モデルの仕様](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
