# 開発手順

変更は最新の`origin/main`から作業ブランチを作り、PRで取り込みます。ブランチ名、取り込み方法、リリース準備は[ブランチ運用](branching.md)を参照してください。

## 必要な環境

- Windows 11 x64 / WebView2 Runtime
- Node.js 22以上とnpm
- Rust stable MSVC、Microsoft C++ Build Tools「C++によるデスクトップ開発」、Windows SDK

## 起動

```powershell
npm ci
npm run desktop
```

画面だけをプレビューする場合は`npm run dev`または`Start-Preview.cmd`を使います。プレビューはサンプル表示専用です。資料保存・翻訳・AIへの質問はデスクトップ版で行います。`index.html`を直接開いてもアプリは起動しません。

この作業環境にあるローカルRust/npmを使う場合は`powershell -ExecutionPolicy Bypass -File scripts/desktop.ps1`で起動できます。

## 検証

```powershell
npm run release:check
npm audit --audit-level=high
npm test
npx playwright install chromium --only-shell
npm run test:e2e
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets
```

PRと手動実行のCIは署名鍵を使用せず、全テストと`npm run package:unsigned`によるインストーラー生成まで確認します。mainへのpushでは`node scripts/verify-release.mjs`による整合性検査だけを実行し、依存導入・Rustコンパイルは行いません。本番の全検証と署名付き配布はタグ用ワークフローで行います。成果物の場所は`src-tauri/target/release/bundle/nsis/`です。

テストの一時出力は`.tools/playwright-results/`に、検証で明示的に保存する画像・JSONの結果は`test-results/`に保存します。原本・モデル・資格情報・テスト結果・ビルド生成物はコミットしません。

## 実サービスとの結合確認

- `scripts/probe-translation.mjs`: `.tools/llama/`と`.tools/models/`を利用する実翻訳プローブ。
- `scripts/probe-native.mjs`: 起動済みのViteとdebug版`gradia.exe`を使用し、専用保存先で翻訳・保存・再起動を確認。
- `scripts/probe-materials.mjs`: 専用保存先でPDF原本・Monaco・Web抽出・中断を確認。
- `scripts/probe-projects.mjs`: debug版を専用保存先で起動し、複数ファイル・フォルダー取り込み、個別失敗、プロジェクト共有・変更・削除・再起動復元を確認。ファイル選択ダイアログの戻り値だけを置き換え、実際の読み込み・抽出・SQLite保存を通します。
- `scripts/probe-markdown.mjs`: 保存済みMarkdownのプレビュー版作成、版とプロジェクト関連の保持、整形表示、再起動復元を専用保存先で確認。`STUDY_TOOL_REAL_TRANSLATION=1`でPLaMoによる実翻訳、太字・コードの保持、併記と割合切り替えも確認します。
- `scripts/probe-markdown-images.mjs`: フォルダー内の相対画像・参照形式・画像変更時の版分け・原本がなくなった後の復元・資料削除を確認。選択前の画像取り込み、フォルダー外のファイル・ジャンクション・外部URL・SVGの拒否も、専用保存先で確認します。
- 上記プローブでは、翻訳サーバーが認証なしの要求を拒否することと、プライベートWeb取得を拒否することも確認します。
- `scripts/probe-codex.mjs`: ローカル模擬サーバーとのプロトコル確認。OpenAIへの推論要求は行わない。
- `scripts/probe-live-chat.mjs`: 接続済みインストール版のWebView2デバッグポート9224で、本人の契約枠による実回答を確認。開発者が明示的に実行する。

通常の起動でWebViewデバッグポートやテスト用保存先は指定しません。検証履歴は[verification.md](verification.md)に記載します。

## 対応範囲と上限

UTF-8コード/テキストは5 MB、PDFは100 MB、HTMLは10 MB以下、フォルダーは2000ファイル未満です。OCR、コード編集・実行、ログイン必須ページ、クラウド同期は対象外です。

PDFの読順や図・複雑な表・数式は抽出だけでは保証せず、原本ページに移動して確認できるようにしています。Monacoでコメントを安全に分類できない言語は翻訳対象にしません。

公式資料: [Tauri](https://v2.tauri.app/)、[PDF.js](https://mozilla.github.io/pdf.js/)、[Tauri Updater](https://v2.tauri.app/plugin/updater/)、[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)、[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。
