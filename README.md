<img src="assets/icon.svg" width="64" height="64" alt="">

# DeepAI-API-bridge

DeepAI Code のローカル・モデル転送（`127.0.0.1:55587`）を OpenAI 互換 API として
公開するブリッジ。opencode / Codex 系クライアントから DeepAI のモデルを使える。

```
opencode / curl / Codex
        │  OpenAI 互換 (http://127.0.0.1:8787/v1)
        ▼
   bridge.mjs  ── 認証・正規化・model 名書き換え・theos 記録
        │  POST /chat/completions + Authorization: Bearer <transport token>
        ▼
   DeepAI Code サーバ (127.0.0.1:55587)  ── 内部トークン/lane ヘッダ付与
        ▼
   上流モデル (OpenRouter 互換レスポンス)
```

## 調査結果（ブラックボックス検証済み）

app.asar を展開せず、実プロセスの HTTP 挙動・ログ・ローカル状態から特定した内容。

| 項目 | 実態 |
| --- | --- |
| 待受 | `127.0.0.1:55587`（モデル転送）/ `55588`（転送以外。`/chat/completions` は 404）|
| 対応パス | `POST /chat/completions`（OpenAI 互換）、`POST /responses`（`api:"openai-responses"` のモデルのみ）|
| 非対応 | `GET /v1/models`・`/embeddings` など一覧/その他系は `404 {"error":{"message":"Unsupported model operation.","type":"deepai_connection_error"}}` |
| 認証 | `Authorization: Bearer <64 hex>`。無い/不正だと `403 Model transport authentication required.` |
| トークン実体 | サーバが `pi` 子プロセスの環境変数 `T3_DEEPAI_TOKEN` として渡す短命トークン（アプリ再起動で変わる可能性あり）。`~/.deepai-code/userdata/secrets/deepai-account.bin` の `apiKey` や `connect.token` では **通らない** |
| 必須条件 | `messages` は非空、かつ **先頭が `system`（または `developer`）**。それ以外は `400 This request cannot be accepted.` |
| その他 | `temperature` / `top_p` / `penalties` / `response_format` / `tools` / `tool_choice` / `max_tokens` / `max_completion_tokens` / `reasoning_effort` はそのまま通る。`image_url` は `{url}` オブジェクト形式のみ可（文字列は 400） |
| レスポンス | 標準 OpenAI 形式 + `delta.reasoning` / `reasoning_details`（OpenRouter 風）。`stream:false` でも `stream` を明示しないと SSE が返る |
| モデル一覧 | `GET /v1/models` は塞がれているが、`~/.deepai-code/userdata/deepai/pi/deepai/models.json` に 27 モデル分の定義（context/maxTokens/premier/theos）が平文である |
| 課金 | `premier:true` のモデルはリクエスト毎に theos を消費（2〜50）。`premier:false` は 0 |

トークンの取得は `ps eww` では不可（macOS で環境変数表示が廃止）。
`sysctl KERN_PROCARGS2` で同一ユーザの `pi` プロセスの環境ブロックを読む方式を採用し、
取得値を `~/.config/deepai-bridge/token.json`（0600）にキャッシュする。
`403` を受けると自動で再取得して 1 回だけリトライする。

## 使い方

```bash
cd ~/.deepai-code/projects/deepai-api-bridge
npm start                     # node bridge.mjs （既定 127.0.0.1:8787）
./scripts/bridge-service.sh start   # バックグラウンド起動（status / logs / stop）
```

前提: **DeepAI Code アプリが起動していること**（上流とトークンの供給元）。

```bash
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/v1/models | jq '.data[].id'
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}'
```

トークンを手動で固定したい場合:

```bash
node bridge.mjs --token "$(somehow-obtained-64-hex-token)"
# または DEEPAI_TRANSPORT_TOKEN=... npm start
```

## opencode への接続

```bash
npm run opencode:install     # ~/.config/opencode/opencode.json に provider を追記（バックアップ自動作成）
npm run opencode:print       # 追記内容だけを確認したいとき
opencode run -m deepai/glm-5.3-flash "Reply with exactly: OK"
```

生成される provider 定義（`@ai-sdk/openai-compatible`）:

```json
{
  "provider": {
    "deepai": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepAI Code (local bridge)",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "deepai-local-bridge" },
      "models": {
        "glm-5.3-flash": {
          "name": "GLM 5.3 Flash",
          "reasoning": true,
          "attachment": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 320000, "output": 131072 }
        }
      }
    }
  }
}
```

premier モデルは名前の末尾に `· premier <n> theos` が付く。

## API

| メソッド | パス | 備考 |
| --- | --- | --- |
| GET | `/healthz` | 上流・トークン取得元・モデル数（トークンは末尾 6 文字のみ）|
| GET | `/v1/models`, `/v1/models/{id}` | models.json 由来。`deepai.premier` / `theos_per_request` 付き |
| POST | `/v1/chat/completions` | 本命。SSE / JSON 両対応、model 名は要求値に書き換え |
| POST | `/v1/responses` | Responses API クライアント向け。`api:"openai-responses"` のモデルは上流へパススルー、それ以外は chat/completions へ翻訳（テキストのみ）|
| POST | `/v1/completions` | 旧 completions → chat へ翻訳 |
| POST | `/v1/embeddings` | 501（上流に無い）|

ブリッジ側の正規化:

- `messages` 先頭が system/developer でなければ既定 system プロンプトを挿入（`defaultSystemPrompt`）
- `stream` を常に明示（未指定は `false` で JSON 応答）
- `image_url` 文字列 → `{url}` オブジェクトへ変換
- `deepai/` や `deepai:` のモデル接頭辞を除去

## 設定

`~/.config/deepai-bridge/config.json`（すべて任意）:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "upstream": "http://127.0.0.1:55587",
  "defaultSystemPrompt": "You are a helpful assistant.",
  "rewriteModel": true,
  "allowPremier": false,
  "verbose": false,
  "apiKeys": []
}
```

`allowPremier:false` で theos 消費モデルを 403 で止められる。`apiKeys` を入れると
ブリッジ自体が Bearer 認証を要求する（既定は 127.0.0.1 バインドで無認証）。

## トラブルシュート

| 症状 | 対処 |
| --- | --- |
| `DeepAI transport token not found` | DeepAI Code を起動（`pi` プロセスが必要）。または `--token` で固定 |
| `403 Model transport authentication required.` が続く | アプリ再起動でトークンが変わった。ブリッジ再起動 or `--token` 更新 |
| `400 This request cannot be accepted.` | system メッセージ欠落。ブリッジ経由なら自動挿入されるので、直接叩いていないか確認 |
| `Model 'x' is not available on this endpoint.` | `/responses` は `api:"openai-responses"` のモデルのみ上流パススルー |
| opencode がモデルを出さない | `npm run opencode:install` 実行後に opencode を再起動 |
| ポート衝突 | `DEEPAI_BRIDGE_PORT=8788 ./scripts/bridge-service.sh start`（opencode 側 baseURL も変更）|

## 構成

```
bridge.mjs                 HTTP サーバ本体（依存パッケージなし / Node 20+）
src/catalog.mjs            models.json 読み込み・モデル ID 正規化
src/token.mjs              T3_DEEPAI_TOKEN の探索（env → キャッシュ → プロセス走査）
src/opencode-config.mjs    opencode provider 生成 / マージ
scripts/bridge-service.sh  start / stop / status / logs
```
