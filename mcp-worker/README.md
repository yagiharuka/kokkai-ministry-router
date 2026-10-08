# 国会会議録・省庁担当エージェントのMCP接続先

質問案からエージェントが選んだ検索語で国立国会図書館の国会会議録APIを調べ、議員の発言と後続の政府側答弁候補を返します。エージェントは候補の内容を読み、関連事例だけを選んで省庁別の構成比を答えます。

- `POST /mcp`: stateless Streamable HTTP MCP endpoint (`initialize`, `tools/list`, `tools/call`)
- `search_answer_assignments`: 質疑候補、答弁者、肩書き、省庁、会議録URL、`case_id` を返す
- NDL APIへの検索は直列で、同じWorker内では呼び出し間に3秒の間隔を空ける
- `tools/call` はSitesによる認証済み利用者だけに許可する

公開画面は引き続き [GitHub Pages](https://yagiharuka.github.io/kokkai-ministry-router/) を利用します。このSiteはエージェントが呼ぶMCP接続先だけを担います。

## ローカル確認

```sh
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

GitHub Pagesには実行環境がないため、MCP接続先は別に公開する必要があります。NDL APIの応答が得られない場合、ツールはエラーを返し、架空の割合を作りません。
