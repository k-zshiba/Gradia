# Gradiaのアーキテクチャ

GradiaはWindows 11 x64向けの、技術資料の閲覧・部分翻訳・AIへの質問を一つの画面で行うアプリです。

## 全体構成

```mermaid
flowchart LR
  User["ユーザー"] --> UI["React / TypeScript<br/>資料一覧・閲覧・AIチャット"]
  Code["ソースコード"] --> Monaco["Monaco<br/>構文・コメント分類"]
  PDF["文字入りPDF"] --> PDFJS["PDF.js<br/>本文抽出・原本描画"]
  Web["公開Webページ"] --> Fetch["Rust HTTP取得<br/>DNS・転送先検査 / 接続先固定"]
  Fetch --> Readability["Readability / DOMPurify<br/>本文抽出・サニタイズ"]
  Monaco --> Docs["Document → Segment<br/>原文・順序・ページ/行"]
  PDFJS --> Docs
  Readability --> Docs
  Docs --> UI
  UI <-->|"Tauri invoke / study-jobイベント"| Rust["Rust / Tokio<br/>資料・翻訳・会話ジョブ"]
  Rust <--> DB[("SQLite<br/>資料の版・訳文・設定・履歴")]
  Rust <--> Files["ローカルファイル<br/>原本スナップショット / モデル"]
  Rust --> Llama["llama-server 子プロセス<br/>127.0.0.1 / 起動ごとの認証 / PLaMo"]
  Rust --> Codex["Codex app-server 子プロセス<br/>stdio / アプリ専用データ"]
  Codex --> Gate["127.0.0.1 通信ゲート<br/>ツール除外 / 契約枠トークン付与"]
  Gate --> OpenAI["OpenAI Responses<br/>ChatGPT契約枠"]
  Rust --> Auth["ブラウザーOAuth / PKCE<br/>Windows DPAPI保存"]
  UI --> Updater["Tauri Updater<br/>同意・取得・署名検証・更新"]
  Updater --> Releases["GitHub Releases<br/>安定版マニフェスト / NSIS"]
```

UIはTauriのWebView内で動き、ファイルアクセス、HTTP取得、子プロセス、SQLite、資格情報はRustが担当します。取り込んだWebページのスクリプトは実行しません。

## 資料・翻訳のモデル

```mermaid
erDiagram
  DOCUMENT ||--o{ SEGMENT : contains
  SEGMENT ||--o| TRANSLATION : translated_as
  DOCUMENT ||--o{ CHAT_MESSAGE : referenced_by
  TRANSLATION }o--|| CACHE : uses
  DOCUMENT {
    string id
    string revision
    string source
    string kind
    int ratio
  }
  SEGMENT {
    string id
    string text
    int order
    boolean eligible
    json location
  }
  TRANSLATION {
    string document_id
    string revision
    string segment_id
    string cache_key
  }
  CACHE {
    string key
    string translated_text
  }
  CHAT_MESSAGE {
    string id
    string revision
    string status
    json references
  }
```

- 同じ取得元の内容が変わると、新しいrevisionとして保存します。過去の会話は過去の版を参照します。
- スライダーは翻訳可能な文を固定順位で選び、表示を切り替えます。割合の増加で選択済みの文が原文へ戻ることはありません。
- 訳文のキーにはモデルハッシュ、PFML3プロンプト、周辺原文を含めます。コード・数式は保護し、復元を検証できない訳文は採用しません。
- PDFはページ・矩形、コードは行、Webは本文ブロックの位置を保持します。複雑なPDFの読順は原本で補います。

## 質問と認証

```mermaid
sequenceDiagram
  actor User as ユーザー
  participant UI as 画面
  participant Rust as Rust
  participant Browser as システムブラウザー
  participant Auth as OpenAI認証
  participant Codex as Codex app-server
  participant Gate as ローカル通信ゲート
  participant Responses as OpenAI Responses
  User->>UI: ChatGPTに接続
  UI->>Rust: sign_in
  Rust->>Browser: state / nonce / PKCE付き認証URL
  Browser->>Auth: 本人のサインイン・同意
  Auth-->>Rust: loopback callback
  Rust->>Auth: コード交換・署名鍵の取得
  Rust->>Rust: ID・nonce・利用権限を検証しDPAPI保存
  User->>UI: 選択範囲に質問
  UI->>Rust: 質問 + 表示した参照内容
  Rust->>Rust: 資料の版・原文・参照位置を検証
  Rust->>Codex: 初期化・thread開始/再開・turn開始
  Codex->>Gate: Responsesリクエスト
  Gate->>Gate: toolsを空にし契約枠トークンを付与
  Gate->>Responses: 契約枠での推論
  Responses-->>Gate: SSEストリーム
  Gate-->>Codex: SSEストリーム
  Codex-->>Rust: JSON-RPC回答イベント
  Rust-->>UI: study-job回答イベント
  Rust->>Rust: 履歴・参照・thread IDを保存
```

既存Codexアプリの資格情報は読みません。GradiaのOAuth登録を利用します。子プロセスに渡すのはローカルゲート専用の一時トークンで、OpenAIのアクセストークンはRust側に保持します。APIキーへの自動切り替えはありません。

## リリースと更新

```mermaid
flowchart TB
  Tag["main上の vX.Y.Z タグ"] --> Check["バージョン・変更履歴・テスト検査"]
  Check --> Build["Windows x64 / NSISビルド"]
  Secret["GitHub Actions Secret<br/>署名秘密鍵"] --> Build
  Build --> Draft["Draft Release<br/>exe / sig / latest.json / SHA256SUMS"]
  Draft --> Publish["全ファイル取得後に公開<br/>安定版だけlatestに指定"]
  Publish --> Startup["アプリ起動時にRelease APIで安定版チェック"]
  Startup --> Prompt{"新しい版あり<br/>更新に同意?"}
  Prompt -->|"いいえ"| Read["現在の版で継続"]
  Prompt -->|"はい"| Download["Asset APIから取得<br/>埋込公開鍵で署名検証"]
  Download -->|"検証成功"| Stop["読書位置保存・ジョブ中断<br/>子プロセス終了"]
  Download -->|"失敗"| Read
  Stop --> Install["NSISで置換・自動再起動"]
```

更新確認の通信は公開GitHub Releaseだけを参照します。資料や認証情報をGitHubへ送りません。拒否した場合はインストーラーのダウンロードもインストールもしません。起動時にオフラインであっても閲覧を継続し、ヘッダーのバージョンボタンから再確認できます。

保存先の識別子は旧名との互換性のため`local.study-tool.desktop`を維持します。更新でSQLite・モデル・暗号化資格情報を削除しません。

## コードの配置

| 場所                                   | 担当                                  |
| -------------------------------------- | ------------------------------------- |
| `src/App.tsx` / `components.tsx`       | 3ペイン、PDF原本、コード、設定        |
| `src/core.ts` / `importers.ts`         | 文分割、順位、保護、資料抽出          |
| `src/UpdateControl.tsx` / `updater.ts` | 更新確認と同意、進捗                  |
| `src-tauri/src/updates.rs`             | Release API・配布物の解決と版の検査    |
| `src-tauri/src/files.rs` / `store.rs`  | 原本・版・SQLite                      |
| `src-tauri/src/web.rs`                 | 公開IP検査・DNS固定・転送と受信量制限  |
| `src-tauri/src/translation.rs`         | PLaMo子プロセスとキャッシュ           |
| `src-tauri/src/auth.rs` / `codex.rs`   | OAuth・DPAPI・Codex・ゲート           |
| `src-tauri/src/lib.rs`                 | IPC登録、ジョブ管理、更新前の終了処理 |
| `scripts/*release*.mjs`                | 版検査、更新マニフェスト、Release公開 |
| `.github/workflows/release.yml`        | タグから署名付きWindows版を公開       |

開発手順は[development.md](development.md)、運用規約は[releasing.md](releasing.md)を参照してください。
