# GitHub Pages 用会議録中継 API

GitHub Pages 上の画面から国立国会図書館の会議録 API を利用するための読み取り専用 Worker です。画面は GitHub Pages に置き、別の公開サービスは会議録検索だけを中継します。

- GET /api/meeting のみを受け付け、検索語、開始日、最大10件の取得件数を検証します。
- 上流への宛先は https://kokkai.ndl.go.jp/api/meeting に固定します。
- ブラウザーへの CORS 許可は https://yagiharuka.github.io のみに設定します。
- 質問全文やユーザーのアカウント情報は中継しません。
- CORS はブラウザー制限であり、公開 API のアクセス制御にはなりません。公開後は URL を知る誰でも検索を実行できます。

サイトの公開アクセスが許可されるまで、GitHub Pages の変更はマージしないでください。無関係な質疑の候補除外など、割合の品質評価は別途続けます。
