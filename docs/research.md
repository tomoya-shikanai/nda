# 調べて分かったこと

調査役のエージェントや Web で確かめた事実を、出典つきで残す。書式は「日付｜分かったこと｜確度｜私たちへの影響｜出典」。確度は「確認済」（一次資料か実機で確かめた）か「未確認」（二次情報、古い、推測を含む）。決めたことは `docs/decisions.md` に書く。

## 機材（Raspberry Pi 5 まわり）

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-04 | Pi 5 は USB PD で 5V 5A を取れたときだけ、USB 端子に最大 1.6A を流す。取れないと 600mA に制限される。取れたかは `usb_max_current_enable` が 1 かで分かる | 確認済（公式資料） | Jabra を挿すので 5A で認識されることが要る。届いた日に確かめる | [Raspberry Pi 公式 USB PD ホワイトペーパー](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009856-WP-1-USB%20Power%20delivery%20on%20Raspberry%20Pi%205.pdf) |
| 2026-11-04 | 27W の電源でも 5V 5A の出力を持たないものがある | 未確認（フォーラム） | 電源は 5V/5A の表記で選ぶ | [Pimoroni Forums](https://forums.pimoroni.com/t/psus-for-raspberry-pi-5/23351) |
| 2026-11-04 | 公式 27W 電源は PSE を取っておらず、国内では正規に売られていない（Amazon のものは米国・カナダ向けの海外出品） | 未確認（2024 年の個人ブログ） | 国内では PSE 付きの 5V/5A 電源を使う | [もりしーのblog](https://kotamorishita.com/raspberry-pi-5-japan/) |
| 2026-11-04 | Traskit の Pi 5 用電源は 5.1V/5A を含む 27W PD、PSE 認証付き。キットの同梱品が同じかは販売ページで書き方が違う | 未確認（販売ページ） | 5A で認識されなければ単品（B0D8SY7ZW5）に替える | [Amazon](https://www.amazon.co.jp/dp/B0D8SY7ZW5) |
| 2026-11-04 | Jabra Speak 410／510 は Pi に USB で挿すと標準のオーディオ機器として認識され、録音も再生もできる。報告は Pi 2〜4 で、Pi 5 の報告は見つからない。Pi 本体の音声とカードの順番が入れ替わる、16kHz で音程がおかしくなる、という報告がある | 未確認（フォーラム） | ALSA でカードを固定し、形式を変換して流す | [Raspberry Pi Forums](https://forums.raspberrypi.com/viewtopic.php?t=223910)、[jarvis #65](https://github.com/alexylem/jarvis/issues/65) |
| 2026-11-04 | Jabra Speak 410／510／710 は、Pi で音声アシスタントを作る人たちの間で推奨機種に挙がる。起動語によって反応のしやすさに差が出る | 未確認（コミュニティ） | 「んだ、Claude」は実機で感度を合わせる | [speaker-hass](https://github.com/moimart/speaker-hass)、[wyoming-satellite #43](https://github.com/rhasspy/wyoming-satellite/issues/43) |
| 2026-11-04 | Anker PowerConf S330 は Linux で正しく動かず返品したという報告がある | 未確認（古いフォーラム） | 候補から外した | [Mycroft Community](https://community.mycroft.ai/t/anyone-using-the-anker-powerconf-s330-on-pi/12099) |
| 2026-11-04 | Pi 5 の画面出力は micro HDMI。HDMI0 は USB-C の電源端子に近い側 | 確認済 | 変換ケーブルが要る（購入済み） | — |

## 起動語

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-04 | Picovoice（Porcupine）の無料枠は 2026-06-30 で終わり、無料枠の AccessKey は無効になった。個人・非商用の枠は予定が無い。今の公式ドキュメントは企業向けの試用（1 回限り）だけを案内している | 確認済（複数の情報源と公式ドキュメントの文面が一致） | 公開リポジトリと家業での実利用には使えない。候補から外した | [Home Assistant Community](https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744)、[Picovoice docs](https://picovoice.ai/docs/) |
| 2026-11-04 | Porcupine 自体は日本語と Raspberry Pi 5 に対応し、独自の起動語を作れる | 確認済（公式 FAQ） | 参考。使わない | [Porcupine FAQ](https://picovoice.ai/docs/faq/porcupine/) |
| 2026-11-04 | Vosk には日本語の小型モデル `vosk-model-small-ja-0.22`（約 48MB、Apache 2.0）がある。小型モデルは実行中に認識する語を絞れる | 確認済（公式のモデル一覧） | 起動語の第一候補。キー不要で、完全にオフラインで動く | [Vosk models](https://alphacephei.com/vosk/models) |
| 2026-11-04 | 日本語のモデルで、認識する語を「んだ」「クロード」だけに絞る使い方が効くか | 未確認（資料が見つからない） | Pi が届いたら最初に実機で試す。駄目ならボタンを押して話す方式に切り替える | — |
| 2026-11-04 | openWakeWord は英語だけに対応（学習用の音声を英語の TTS で作るため）。学習済みモデルは商用不可（CC BY-NC-SA 4.0） | 確認済（公式リポジトリ） | 使わない | [openWakeWord](https://github.com/dscripka/openWakeWord) |
| 2026-11-04 | microWakeWord はマイコン向けで、学習は上級者向け。日本語への対応は読み取れない | 未確認 | 11/8 には間に合わないので使わない | [microWakeWord](https://github.com/kahrendt/microWakeWord) |
| 2026-11-04 | ESP32-S3 の端末側の検出（Espressif WakeNet）は、独自の起動語に Espressif 側での学習が要る | 未確認（記憶） | 検出は Pi で行う | — |

## データの扱い（Claude API）

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-04 | API に送ったデータは、既定ではモデルの学習に使われない。例外は、利用者がフィードバックを送った場合（最大 5 年保存）と、利用を許可した場合 | 確認済（プライバシーセンター、2026-08-18 付） | フィードバック機能を使わない | [privacy.claude.com](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) |
| 2026-11-04 | API の入出力は、原則 30 日以内に削除される。利用規約違反の疑いで自動検知されると、入出力は最大 2 年、分類スコアは最大 7 年保存される | 確認済（プライバシーセンター、2026-07-01 付）。「2025-09 から 7 日に短縮」とする第三者の記事があり、食い違う | README には公式の 30 日を書き、出典の日付を添える | [privacy.claude.com](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)、[API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) |
| 2026-11-04 | ゼロデータ保存（ZDR）は営業窓口に申し込み、組織ごとに有効にする。個人・小規模で使えるかは書かれていない | 有無は確認済。個人で使えるかは未確認 | 申し込まない。既定の扱いで進める | 同上 |
| 2026-11-04 | Batch（29 日保存）、Files API（削除するまで保存）、コード実行（最大 30 日）は保存のされ方が違う | 確認済 | 使わない。データは毎回リクエストに直接入れる | 同上 |
| 2026-11-04 | 個人情報保護法では、外国の第三者に個人データを渡すときは、委託でも原則として本人の同意が要る。同意の前に、移転先の国名・その国の制度・移転先の保護措置を伝える。Web ページの URL で示してもよい | 確認済（個人情報保護委員会 Q&A、令和 8 年 10 月 30 日版） | 客の情報を送るなら、客に説明して同意をもらう | [個人情報保護委員会 Q&A](https://www.ppc.go.jp/personalinfo/faq/APPI_QA/) |
| 2026-11-04 | 事業者が個人データを取り扱わない契約・体制なら「提供」に当たらない、という例外がある。Claude API がこれに当たるかは分からない | 未確認（調査役の推論。専門家の確認が要る） | 安全側に倒し、同意をもらう前提で設計する | 同上 |
| 2026-11-04 | 文字起こしを外部ベンダに送るなら、そのベンダの規約も別に調べる必要がある | 確認済（当然の事実） | ベンダを決めたら調べる | — |

## Claude と開発の道具

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-03 | Citations は structured outputs と同じリクエストでは使えない（400 になる） | 確認済（公式ドキュメント） | 息子の問いを Citations にするなら、出力の形は自分で検証する | Claude API ドキュメント |
| 2026-11-03 | computer use は API で stable（`computer_toolset_20260801`、claude-opus-5-5 対応） | 確認済（公式ドキュメント） | 事務所の PC の操作に使う選択肢がある（議題 7） | Claude API ドキュメント |
| 2026-11-03 | 評価は、起きるべき場合と起きるべきでない場合を同数そろえ、k 回回して pass^k を見る | 確認済（Anthropic「Demystifying evals」） | 評価の設計に使う（議題 4） | Anthropic Engineering ブログ |
| 2026-11-03 | `claude -p --bare` は API キーが要り、OAuth を読まず、フックと CLAUDE.md も読み飛ばす | 確認済（実機） | 夜間ループでは使わない | 実機（CLI 2.1.316） |
| 2026-11-04 | Claude Code の sandbox は、Read/Edit の拒否規則も sandbox の制限に反映する。`//**/data/kartes/**` のような glob は、試験の一時フォルダまで塞ぐ | 確認済（実機） | 拒否は実行時に絶対パスで入れる | 実機（`scripts/night-probe.sh`） |
| 2026-11-04 | Next.js 16 の `LayoutProps` は型生成で作られる。ビルド前の worktree では `next typegen` が要る | 確認済（実機） | `typecheck` に `next typegen` を含めた | 実機 |

## 整備ソフト

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-04 | **店のソフトは RacroS III（ラクロス3）**（鹿内さんが父に確認）。Windows のデスクトップのソフトで、整備と鈑金見積を 1 つにまとめた業務ソフト。販売元のサイトは bsrweb.jp | 製品名は確認済（父）。製品の概要は確認済（公式サイト） | 以下の候補 2 製品の調査は参考に下げる。操作方式は RacroS III の実物で決める | [製品情報](https://bsrweb.jp/products/)、[導入工場のレポート](https://bsrweb.jp/article/878561) |
| 2026-11-04 | RacroS III は月額 2 万円前後・5 年契約から・解約時のデータ抽出は不可、とする比較記事がある | 未確認（個人の比較記事） | 書き出し・取り込みの機能は期待しにくい。画面の操作を前提にする | [カーライドの比較記事](https://car-ride.net/topics/3369) |
| 2026-11-04 | 「はい！整備」は Windows のアプリ（FAQ に「Windows10、8.1、7、Vista で動作」）。「クラウド形式のインターネットを使用したシステムでは無い為、現在、インターネットを経由した接続はできません」。CSV・外部連携・API の記載は無く、帳票や機能の追加は有償のカスタマイズ | 確認済（公式 FAQ の原文） | もし店のソフトなら、画面の操作が本命。データは店内（共有フォルダの見込み、未確認） | [はい！整備 FAQ](https://www.isi-grp.co.jp/hi-seibi/faq/) |
| 2026-11-04 | GATCH には 2 か月の無料体験版がある（メール・会社名・電話・住所を入れて体験 ID をもらう）。体験版は共有のクラウドサーバーを使い、外向きの 1433 番ポートが要る。体験版のデータは全利用者で共有されるので、個人情報を入れてはいけない | 確認済（公式の体験版ページの原文） | もし店のソフトなら、手元の Windows で作り込める。架空のデータだけを入れる | [GATCH 体験版](http://gatch.softplanner.co.jp/download) |
| 2026-11-04 | 両製品とも、請求明細を CSV で取り込む機能や API は、公開資料に見当たらない | 未確認（記載が無いだけ） | 画面の操作を前提にする。店の版で CSV があるかは #2 で確かめる | 同上、[GATCH](https://gatch.softplanner.co.jp/) |
| 2026-11-04 | pywinauto は backend が 2 つ。win32 は MFC・VB6・Delphi・古いアプリ向け、uia は WinForms・WPF 向け。どちらで多く見えるかは Inspect.exe などで確かめる。既定は win32 | 確認済（pywinauto の公式ドキュメント） | 最初の 30 分で両方を試す | [pywinauto](https://pywinauto.readthedocs.io/en/latest/getting_started.html) |
| 2026-11-04 | SendInput は、同じかそれより低い権限のアプリにしか入力できず、失敗しても戻り値に出ない | 確認済（Microsoft の文書） | 整備ソフトが管理者権限で動くなら、こちらも管理者で動かす。入力後は必ず読み返す | [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) |
| 2026-11-04 | `ValuePattern.SetValue` は 1 行の編集欄だけに効き、IME に左右されない。ただし、キー入力で動く処理（合計の再計算など）が走らないことがある | 一部確認済（Microsoft の文書）。業務ロジックの点は推測 | 値を入れた後に Tab で抜け、合計欄を読んで確かめる | [ValuePattern.SetValue](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue) |
| 2026-11-04 | pywinauto の `type_keys` は、既定で文字を VK_PACKET で送るので全角も送れる。IME の状態で数字・英字が全角になる恐れがある（推測） | 一部確認済 | 入力前に IME を切り、入力後に読み返す | [pywinauto keyboard](https://pywinauto.readthedocs.io/en/latest/code/pywinauto.keyboard.html) |
| 2026-11-04 | WinForms の DataGridView は MSAA 経由でしか出ず、一部が使えない。Delphi の TStringGrid はセルが部品として存在しない | 確認済（Microsoft の文書、DelphiUIAutomation の wiki） | 明細の表（グリッド）が最大の難所。見えなければ Tab で移って読むか、座標でクリックして画像で照らす | [標準部品の UIA 対応](https://learn.microsoft.com/en-us/dotnet/framework/UI-automation/ui-automation-support-for-standard-controls)、[TStringGrid](https://github.com/jhc-systems/DelphiUIAutomation/wiki/TAutomationStringGrid) |
| 2026-11-04 | computer use は、操作が成功したか確かめずに成功したように振る舞うことがある、と Anthropic 自身が書いている | 確認済（公式ドキュメント） | 使う場合も、読み返しの照合を必ず挟む | [computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) |
| 2026-11-04 | 安全な作法の定番：押してよいボタン・キーを許可リストで決め、確定・発行・印刷と Enter は送らない。想定外のダイアログで止まる。請求 ID ごとの処理済み台帳で二重入力を防ぐ。入力の前・後・停止時にスクリーンショットを撮り、1 件ごとに記録する | 未確認（業界の定番としての推測） | 事務所の PC 側のプログラム（N7）の設計に使う | — |
| 2026-11-03 | GATCH と「はい！整備」は Windows 版、Maintenance.c と Car Store System Cloud はブラウザで動く、とされる | 未確認（調査役の報告） | 父の店のソフトは Windows のアプリの見込み | — |
