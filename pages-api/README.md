# GitHub Pages 用会議録中継 API

GitHub Pages の画面から国立国会図書館の会議録 API を利用するための読み取り専用 Worker です。画面は GitHub Pages に置き、検索だけを別の公開サービスで中継します。

- `GET /api/speech` は発言単位の検索を中継し、最大30件を返します。
- `GET /api/meeting` は会議単位の検索を中継し、最大10件を返します。任意の `nameOfMeeting` 条件に対応します。
- `GET /api/jurisdiction?term=...` は e-Gov 法令APIの現行組織令のキーワード一致を照合し、法令名と参照URLを返します。
- 検索語、開始日、件数、会議名を検証し、宛先は国立国会図書館APIと e-Gov 法令APIに固定します。
- ブラウザーへの CORS 許可は `https://yagiharuka.github.io` のみに設定します。
- 質問全文やユーザーのアカウント情報は中継しません。
- CORS はブラウザー制限であり、公開 API のアクセス制御にはなりません。URL を知る誰でも検索できます。

公開先: https://kokkai-pages-api.haru620328.chatgpt.site
