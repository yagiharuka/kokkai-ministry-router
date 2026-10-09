# 判定モデルの再選定（2026-10-09）

## 決定と現在の状態

Qwenの採用・接続は保留する。Cloudflareとの接続も未設定で、公開中継サーバーの環境変数にAI接続用のキーはないことを確認した。Qwenへ利用者入力を送っていない。既存ソースにはQwen向けの未接続アダプターが残っているため、現在のFREE-CLOUD.mdに記載された有効化手順は実施しない。代替モデルも自動的に有効化しない。

有料OpenAI API接続は廃止済み。GitHubの画面は維持し、追加料金なし・利用者の端末内実行なし・リンクで配布できる条件を維持する。自動判定は未復旧。

## 比較候補

| 候補 | 開発元 | 実行先 | 確認できた仕様 | 未確認 |
| --- | --- | --- | --- | --- |
| gpt-oss-20b | OpenAI | Cloudflare-hosted | 128,000トークンの文脈長。Cloudflareは低遅延用途向けと説明 | 国会質疑での日本語精度、実際の速度、無料枠で処理できる件数 |
| llama-3.1-8b-instruct-fp8 | Meta | Cloudflare-hosted | 32,000トークンの文脈長 | 同上 |

最初の検証候補はgpt-oss-20b。長い質疑を保持できる点から検討する判断であり、Llamaより正確と実証したものではない。ChatGPTそのものや有料OpenAI APIとは別の、公開ウェイトをCloudflareが実行するモデル。まだ実装の差替え・実接続試験はしていない。

## 費用

現行のWorkers Freeでは1日10,000 Neuronsまでで、超過時は停止する。Paidへの変更・プリペイド購入・有料フォールバックは行わない。全利用者で共有する枠で、質問1回に必要な量は入力と出力で変わる。無料で無制限に配布できる保証はない。

## データの扱い

Cloudflareの説明では、Workers AIの顧客コンテンツを明示的同意なくモデル学習やサービス改善に使わない。開発元と処理する事業者は分けて評価する。

日本国内だけでの推論処理、保存・ログの詳細、実際の契約条件、省内の利用許可は確認できていない。一般のWorkersの地域設定の説明を、Workers AIの推論場所の保証と読み替えない。米国企業のモデルを選んだだけで省内業務に利用可能と判断しない。

検証では公開会議録と公開してよい例題だけを用いる。未公表の質問案・個人情報等を入力できる業務システムとしては扱わない。

## 次の作業

運営用の接続を確保してから、公開例題による引用照合・文脈判定・応答時間・無料枠の消費量を検証する。未接続なので、その精度や処理件数は現時点では報告しない。モデル変更時は応答形式も確認し、名前だけを差し替えない。

## 確認した公式資料

- [gpt-oss-20b](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [Llama 3.1 8B FP8](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/)
- [Workers AIの料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AIのデータ利用](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
