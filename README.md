# Slack Gmail Assistant 🤖✉️

このリポジトリは、Slack上で動作するGmail & Google Calendar 操作アシスタントボットです。  
OpenAI + MCP + Slack を連携し、自然言語でメールの下書き作成やカレンダー予定管理ができます。

## 💻 構成

- TypeScript（`tsx` 実行）
- Slack Bolt SDK
- OpenAI GPT-4.1 + MCP Tool
- .env による環境変数管理

## 🚀 起動方法

### 1. 依存パッケージのインストール
```bash
npm install
```

### 2. .env ファイルの作成
`.env` ファイルを作成し、必要な環境変数を設定してください。

### 3. サーバーの起動
```bash
npx tsx slack-bot.ts
```
または、`package.json`の`scripts`に以下を追記すると`npm run start`でも起動できます。
```json
"scripts": {
  "start": "tsx slack-bot.ts"
}
```

## 🧪 必要な環境変数
`.env` .env.exampleに設定例を記載してあります。


## 🔧 補足
- OpenAI tool calling に対応済み
- ユーザーごとに会話履歴を保持（`conversationStore`）
- Gmail操作完了後、自動で履歴をクリア

