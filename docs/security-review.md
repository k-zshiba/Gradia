# セキュリティ・実装レビュー

実施日: 2026-11-08。Windows 11 x64を対象に、0.2.1のソースと今回の修正を確認しました。以下の修正は0.3.0の対象で、公開済み0.2.1のバイナリは変更していません。

## 結果と修正

| 優先度 | 発見した問題 | 修正と検証 |
| --- | --- | --- |
| P2 | Web取り込みがlocalhost・プライベートIPへ接続でき、公開サイトからの転送にも制限がなかった | DNSの全回答を検査し、検査したIPへ接続先を固定。転送先も毎回検査。内部サービスにHTTP要求が届かないことをテスト |
| P2 | llama-serverが認証なしで推論を受け付けていた | 起動ごとのランダムキーを環境変数で渡し、RustからBearer認証。実翻訳成功と認証なし要求のHTTP 401を確認 |
| P2 | 接続処理中のログアウトが、中断を通知する前に認証ロック待ちになった | 先にジョブを中断してからロックを取得。ロック保持中でも中断通知が届き、資格情報が削除される回帰テストを追加 |
| P3 | Codexの起動準備に失敗すると、トークンを保持する通信ゲートが残る経路があった | 失敗し得る準備を終えてからゲートを起動。起動エラー時の専用後始末も不要になった |

深刻度は影響と成立条件に基づくレビュー上の判断です。侵入試験で全攻撃経路を網羅したという意味ではありません。

## 防御を補強した箇所

- 本番CSPから開発サーバーへの通信許可を外し、開発用CSPへ移した。未使用のUpdater直接チェック権限を削除。
- PDF.jsの動的評価を無効化。HTML・AI回答をテキストとして描画し、未知の参照IDをリンクにしないことをテスト。
- OAuthのstate・PKCE・nonce・IDトークンの署名/issuer/audience/期限・必要scopeの検証を維持。不正・途中切断のコールバック1件で接続全体が失敗しないよう修正。
- DPAPIの復号バッファーは解放前に消去。資格情報を一時ファイルから置換して保存する処理は維持し、読み戻しに使っていなかったバックアップの生成を削除。
- 認証・AI・ローカル翻訳のHTTP通信は転送に追従しない。Web取得だけが接続先を再検査して転送を処理する。GitHub配布物の取得はTauri Updaterが担当。
- `requireSignedVersion`を有効化。公開前の検査で署名コメントのバージョンとタグの一致を要求し、インストール時はTauriが署名を検証する。
- GitHub Actionsを公式リポジトリのコミットSHAへ固定。checkoutの資格情報を残さず、`GH_TOKEN`は必要なステップへ限定。

## 簡潔さと責務

- 翻訳1文分の処理を`translate_segment`へ分離。キャッシュの有無によって重複していた保存処理を統合し、保護用正規表現を毎回生成しないようにした。
- 翻訳の中断を1文分の処理全体へ適用。レスポンス本文の受信待ちも中断できる。
- ジョブ中断処理を共通化。認証の中断はジョブの外側で扱い、重複する中断待ちを削除。
- 接続先ポリシーを`web.rs`へ集約。ファイル操作から分離し、汎用HTTPフレームワークや設定層は追加していない。
- コードを言い換えたコメントを減らし、単純化すると失われる制約をコメントに残した。Codexゲート、参照の版検証、更新署名は安全境界として維持した。
- `App.tsx`は画面状態とイベント処理を多く持つ。今後、独立した機能を変更するときに責務ごとに分ける余地がある。今回は画面全体の構造を変更していない。

規約は[AGENTS.md](../AGENTS.md)に記載した。コードにはHow、テストにはWhat、コミット本文にはWhy、コメントにはWhy notを書く。

## 依存監査と検証

- npm audit: 既知の脆弱性0件。
- cargo-audit 0.22.2 / RustSec: `vulnerabilities`は0件。ロック全体には`proc-macro-error 1.0.4`の保守終了警告（RUSTSEC-2024-0370）、`glib 0.18.5`の健全性警告（RUSTSEC-2024-0429）がある。両者とも`cargo tree --target x86_64-pc-windows-msvc -i 名前`でWindows依存ツリーに含まれないことを確認。Linux対応時は再評価する。
- JavaScript/TypeScript 31件、Rust 16件、ブラウザー5件の計52件が成功。フロントエンド本番ビルドも成功。
- Clippyで不要なcloneを1件修正し、静的解析の結果も確認。
- `scripts/probe-native.mjs`: 隔離した実アプリでPLaMoの実翻訳、認証なし推論の拒否、キャッシュ、再起動、原本・版・履歴を確認。
- `scripts/probe-materials.mjs`: PDF原本、Monaco、Webサニタイズ、プライベートHTTP要求が発生しないこと、中断後の閲覧を確認。
- 結果は`test-results/native-probe.json`、`native-materials.json`、`.tools/security-audit/rust-audit.json`へ保存。資格情報は含めていない。

## 保護の前提と制約

- 自分専用アプリとして、Windowsユーザー、選択した実行ファイル、モデル、ビルド依存関係を信頼する。同じユーザー権限のマルウェアを隔離する仕組みではない。
- DPAPIはOAuth資格情報を保護する。資料・訳文・会話を保存するSQLiteやCodexの会話データは平文のローカルファイルであり、ディスク全体の暗号化は行わない。
- Web取り込みではDNS検査を迂回しないようプロキシを使用しない。ローカル・社内サイト、プロキシ必須のサイトは取得対象外。ブラウザーで原本を開くことは可能。
- ActionsのSHA固定や環境変数の範囲制限は、署名時に使う依存関係そのものの悪意を排除する保証ではない。公開するコードとビルド環境の信頼は引き続き必要。

公式資料: [OpenAI app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)、[llama-server認証](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[Tauri Updater](https://v2.tauri.app/plugin/updater/)、[GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)、[RustSec](https://github.com/rustsec/rustsec/tree/main/cargo-audit)。
