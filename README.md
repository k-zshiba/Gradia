# Gradia

Windowsで技術資料を読み、文単位の英日翻訳とCodexへの質問を同じ画面で行う個人用アプリです。

## 実装済みの機能

- Rust / Tauri 2 + React / TypeScript、幅を変更できる3ペイン。
- UTF-8のコード・テキスト・Markdown、文字入りPDF、公開HTML記事の取り込み。
- PDF原本表示、ページ・コード行への参照、本文検索、目次、取得時点の版管理。
- 0〜100%の翻訳表示。固定順位による文の切り替え、原文確認、翻訳キャッシュ、中断。
- PLaMo 3 Translate 2B GGUFとローカルのllama-server。原文・周辺文脈・モデルハッシュ別のキャッシュ。
- ChatGPT契約枠のOAuth接続、Windows DPAPIによる資格情報保護、Codex app-serverとのstdio通信、回答ストリーム、履歴と出典。
- AIのツール利用を無効化するローカルの通信ゲート。取り込んだ資料は実行せず、原本は変更しません。

**Windows版をインストールし、資料閲覧・PLaMo実翻訳・ChatGPT契約枠でのCodex実回答を確認しました。** 出典への移動、回答中断後の再開、再起動後の認証保持も確認済みです。詳細は [docs/verification.md](docs/verification.md) を参照してください。

## まず画面を開く

インストーラーで導入後、**スタートメニューの「Gradia」**を開いてください。インストール先は `%LOCALAPPDATA%\Gradia\gradia.exe` です。作業フォルダーの `Start-Gradia.cmd` でも、ビルド済みのWindows版を起動できます。通常利用にNode.jsや開発サーバーは不要です。

`index.html` はViteが処理する開発用の入口です。直接開いてもReactアプリは動きません。サーバー起動後のURLは **http://127.0.0.1:1420** です。

ブラウザーで画面だけを確認する場合は `Start-Preview.cmd`、停止には `Stop-Preview.cmd` を使います。こちらはサンプル画面で、Windows版の機能とは異なります。

## 開発環境

Windows 11 x64、Node.js 22以上（npmを含む）、RustのMSVCツールチェーン、Microsoft C++ Build ToolsとWindows SDK、WebView2 Runtimeが必要です。

Visual Studio Installerの「C++によるデスクトップ開発」が必要です。このPCにはユーザーの許可を得てBuild Tools 2022とWindows SDKを導入済みです。

```powershell
npm install
npm run desktop
```

今回の作業環境に作成したローカルRust/npmを利用する場合:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/desktop.ps1
```

## 画面だけを確認する

```powershell
npm run dev
# または（npmがPATHにない作業環境）
powershell -ExecutionPolicy Bypass -File scripts/preview.ps1
```

ブラウザーで `http://127.0.0.1:1420` を開き、「サンプルを開く」を選択します。サンプルの訳文は動作確認用の事前収録データです。ブラウザー版は資料保存・PLaMo・Codex接続を実行しません。

## ローカル翻訳の準備

このPCでは `.tools/llama/llama-server.exe` と `.tools/models/plamo-3-translate-2b-Q4_K_M.gguf` を導入し、アプリに設定済みです。CPUで利用できます。別のPCでは以下を行ってください。

1. PLaMo 3に対応するWindows版llama.cppを導入します。
2. [PFNのモデル配布ページ](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF)から `plamo-3-translate-2b-Q4_K_M.gguf` を取得します。モデルのライセンスは同ページで確認してください。
3. アプリの設定で `llama-server.exe` とGGUFの絶対パスを選択します。
4. CPU実行ではGPUレイヤー数を0に設定し、「翻訳エンジンを起動」を押します。

モデル・実行ファイルはアプリに同梱していません。公式CLIのWindows対応に依存せず、Rustからllama-serverを直接起動します。ローカルサーバーは127.0.0.1の空きポートに限定します。エンジン起動時にモデルのSHA-256を計算するため、初回は時間がかかります。

## Codexの準備

このPCではCodex実行ファイルのパスを設定し、ChatGPTへの接続と契約枠による実回答を確認済みです。再認証が必要になった場合は、アプリから「ChatGPTに接続」を押してください。

1. Codex CLIを導入し、設定で `codex.exe` の絶対パスを指定します。
2. 「ChatGPTに接続」を押し、ブラウザーでアプリ登録と契約枠の利用許可を完了します。
3. 資料を開き、チャット下部の参照内容を確認して質問します。

既存のCodexアプリの認証ファイルは読み取りません。Gradia専用のOAuth登録を作成します。APIキーは要求せず、自動的に従量課金へ切り替えません。アカウント・モデルの利用権限や上限によって利用できない場合があります。

質問ごとにapp-serverを起動し、保存したthread IDを再開します。期限切れ前にトークンを更新してから起動するため、子プロセスへ古い認証情報を残しません。「接続解除」はこのPC上の資格情報を削除します。アカウント側の許可撤回はChatGPTで行ってください。

参照資料はJSONデータとして渡します。画面に表示する原文・訳文・位置と送信内容を一致させ、Rustでも版と原文を検証します。通常の閲覧と翻訳はローカル処理です。AIへの質問時には、質問・参照範囲・会話の履歴がOpenAIへ送信されます。

## 保存と制限

- `%LOCALAPPDATA%/local.study-tool.desktop/` にSQLite、原本スナップショット、暗号化した資格情報、Codex専用データを保存します。
- 開発名Study Toolからの名称変更後も保存先識別子と画面設定のキーを維持し、既存資料・認証・会話を引き継ぎます。既にインストールした旧名のアプリは、Gradiaのインストーラーを作成してから更新してください。
- 資料の内容が変わった場合は別の版として保存します。過去の会話は過去の版に結び付きます。
- 初版はUTF-8、コード/テキスト5 MB以下、PDF100 MB以下、HTML10 MB以下に対応します。フォルダーは2000ファイル未満。
- OCR、動的サイト・ログイン必須サイト、資料横断検索、コード編集・実行は対象外です。
- PDFの図・複雑な表・数式は原本で確認してください。段組みの読み順は自動抽出だけでは保証しません。
- ソースコメントはMonacoのトークン分類で識別します。未対応言語の本文を勝手に翻訳しません。
- Markdownのコードフェンスと数式ブロックは原文保持。翻訳で保護記号が欠落した場合も原文表示を維持します。

## 検証・パッケージ化

```powershell
npm test
npm run test:e2e
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run package
```

NSISインストーラーの出力先: `src-tauri/target/release/bundle/nsis/`。コード署名は行いません。Windows用のCI定義は `.github/workflows/windows.yml` にありますが、この作業ではリポジトリの公開やCI実行はしていません。

## 構成

- `src/`: UI、資料取り込み、文分割、翻訳表示・参照選択。
- `src-tauri/src/`: SQLite、ファイルとWeb取得、PLaMo、OAuth/DPAPI、Codex通信。
- `tests/`: 単体テストとブラウザー上の操作テスト。
- `docs/`: 設計上の判断と検証結果。

技術資料: [Tauri](https://v2.tauri.app/)、[PDF.js](https://mozilla.github.io/pdf.js/)、[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)、[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。
