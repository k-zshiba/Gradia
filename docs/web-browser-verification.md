# 元ページの閲覧を検証する

Windows 11 x64とWebView2 Runtimeを使います。Rust debug版をビルドし、llama-serverとPLaMoのGGUFを用意してください。

```powershell
npm ci
npm run build
cargo build --locked --manifest-path src-tauri/Cargo.toml
$env:GRADIA_LLAMA_PATH = "C:\models\llama-server.exe"
$env:GRADIA_MODEL_PATH = "C:\models\plamo-3-translate-2b-Q4_K_M.gguf"
node scripts/probe-web-browser.mjs
```

標準の実行ファイルは`src-tauri/target/debug/gradia.exe`です。別のビルド先を使う場合は`GRADIA_NATIVE_EXE`で絶対パスを指定します。モデルの標準位置は`.tools/llama/llama-server.exe`と`.tools/models/plamo-3-translate-2b-Q4_K_M.gguf`です。

Viteの1420番ポートを空けて実行してください。スクリプトは自分のViteとアプリを起動し、専用の`.tools/browser-native/日時/`にDB・信頼するUIのプロファイル・元ページのプロファイル・JSONとスクリーンショットを保存します。終了時に自分のアプリ・翻訳エンジン・Viteを停止します。インストール済みのGradiaやその保存先・資格情報を使いません。

ローカルfixtureの許可はdebugビルドと`STUDY_TOOL_BROWSER_TEST_ORIGIN`で指定した単一の`127.0.0.1`オリジンに限定します。信頼するUIと元ページのCDPポートは別々で、debugビルドの専用保存先を指定したプロセスにだけ設定します。release版にローカルfixtureの例外やCDP操作コマンドはありません。

次の結果を実画面とRustの保存値で確認します。

- X-Frame-Options DENYの元ページにCSSとJavaScriptを適用する。
- メインworldの関数を書き換えた敵対ページでも、画面外を含めて本文をisolated worldで解析する。
- PLaMoの実訳を元ページ内に表示し、0・50・100パーセントと併記モードを切り替える。
- キャッシュ済みの表示変更で新しい翻訳ジョブを作らない。
- 再解析前に原文へ戻し、サイト側の文字変更とノード交換を保持する。
- リンク・新しいウィンドウのリンク・戻る・進む・同じURLの再読み込みと同一文書内の移動を確認する。
- ファイル・外部スキーム・ダウンロード・通知権限を拒否する。
- 不変の原文・取得元・プロジェクト関連を保存し、既存の閲覧画面へ移る。
- 設定を開く前の子画面終了と、初期化途中の終了を確認する。

`GRADIA_PUBLIC_SMOKE=1`を指定すると、公開HTTPSページの読み込みと本文解析も確認します。この追加確認には外部ネットワークが必要です。標準実行はローカルfixtureとローカルモデルだけで完了します。

固定DOMスクリプトのテストでは、翻訳に含むHTMLを文字として表示すること、文間の空白を保持すること、解析上限による欠落を注記することを確認します。通常の`npm test`と`cargo test`にも所属検証・原文保存とキャッシュの分離・終了順序の検証があります。
