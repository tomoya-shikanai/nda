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

## 声とキャラクター

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-04 | VOICEVOX エンジンの安定版 0.26.0 に Linux CPU arm64 版がある。オフラインで動き、無料 | 確認済（公式のリリース） | Pi 5 でも動く見込み。1 文にかかる時間は実機で測る。遅ければ Mac で動かすか、定型の質問を前もって WAV にしておく | [VOICEVOX engine releases](https://github.com/VOICEVOX/voicevox_engine/releases) |
| 2026-11-04 | VOICEVOX は商用・非商用ともに使えるが、VOICEVOX を使ったと分かるクレジットが要る。生成した音声の扱いはキャラクターごとの規約に従う | 確認済（公式の利用規約） | 使う声を決めたら、その声の規約を個別に確かめる | [VOICEVOX 利用規約](https://voicevox.hiroshiba.jp/term/) |
| 2026-11-04 | ずんだもんの声は商用利用でき、表記は「VOICEVOX:ずんだもん」。クレジットなしで使うなら 1 キャラクター 40 万円＋税の契約 | 確認済（公式の音源の規約） | 声の候補の 1 つ。クレジットは画面の隅と README に書く | [ずんだもんの規約](https://zunko.jp/con_ongen_kiyaku.html) |
| 2026-11-04 | Anthropic の商標ガイドラインでは、商標の利用は Anthropic が明示的に許可した範囲と、事前に承認した素材に限る。色・字体・比率を含め、改変は一切不可。問い合わせは marketing@anthropic.com（取引関係のある相手向け） | 確認済（公式ガイドライン） | Clawd に整備服を着せるのは改変に当たるおそれがある。許可なしには使わない | [Anthropic Trademark Guidelines](https://www.anthropic.com/legal/trademark-guidelines) |
| 2026-11-04 | 大会のルールの素材の決まりは「権利を有しない素材の使用」の禁止。法令・条例・公的な様式は使え、利用規約で転載を認めている資料は出典を書けば使える（運営の Kai さんの回答。ルールの「自分が著作権を持っているものに限る」は表現が悪く、訂正するとのこと） | 確認済（Discord の質問チャンネルの運営の回答、2026-11-04 14:42） | VOICEVOX の声はクレジットを書けば使える。Clawd は商標ガイドラインが改変を認めていないので、許可なしには使えない。RacroS III の画面をデモに映してよいかは未確認 | Discord「❓質問-questions」の「申請書様式をデモ動画に映してよいか（著作権）」 |
| 2026-11-04 | Discord の質問チャンネルに、Anthropic のキャラクター（Clawd）や他社の業務ソフトの画面をデモに使ってよいか、という質問はまだ無い（表示された 7 件を確認）。AI で生成したキャラクターの絵を使ってよいかの質問はあり、回答待ち | 確認済（2026-11-04 夕方時点） | 必要なら自分で質問する | 同上のチャンネル |
| 2026-11-04 | Built with Claude: Japan 2026 のイベントページと、過去の Built with Claude の公式ルールに、ロゴ・キャラクター・知的財産の使い方の記載は無い | 確認済（記載が無いことを確認） | 大会としての許可も無い。使うなら運営に聞く | [イベントページ](https://cerebralvalley.ai/e/built-with-claude-japan2026)、[過去の公式ルール](https://support.claude.com/ja/articles/12003471) |

## 文字起こし

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-04 | ElevenLabs Scribe v2（`scribe_v2`、日本語）は API で動く。Mac の読み上げで作った架空の音声「…廃タイヤは二本です」が「…はい、タイヤは二本です」になった（同じ音の言葉の取り違え） | 確認済（実機、1 本だけ） | 整備の言葉（廃タイヤ・組替・脱着など）を前もって渡せるか（用語の指定）を、ベンダー比較の観点に入れる。明細では、発話から読めない値を推測せず確認事項に出す仕組みが最後の守り | 実機（scratchpad の架空の音声） |
| 2026-11-04 | ElevenLabs の無料プランは月 10,000 クレジットで、個人・非商用の利用に限る。商用ライセンスは有料プラン | 確認済（ElevenLabs の画面の案内） | 家業での実利用の前に有料プランに切り替える | ElevenLabs の API キー作成画面 |

## 方言と用語（津軽弁・整備の言葉・世代の言い回し）

| 日付 | 分かったこと | 確度 | 影響 | 出典 |
|---|---|---|---|---|
| 2026-11-04 | 実環境の方言談話（COJADS）で、Whisper（追加学習なし）の CER の中央値は 0.578（標準語は約 0.04）。方言データだけで学習したモデルが並ぶには約 35 時間が要る。誤りは方言を共通語に言い換える型が目立つ | 確認済（論文本文。査読なし、再現なし） | STT の段だけで方言を直すのは 3 日では無理。微調整はしない。「んだんだ→普段だ」も同じ型の誤り | [言語処理学会 2026 C1-7](https://www.anlp.jp/proceedings/annual_meeting/2026/pdf_dir/C1-7.pdf) |
| 2026-11-04 | 20 方言（CPJD）の評価で、津軽は文字の入力でも頑健性が特に低い方言の一つ。音声エンコーダの微調整で伸びる。評価は 8B 以下の公開モデルだけで、Opus 級は入っていない。標準語へ変換してから使う方式との比較は無い | 確認済（論文 HTML 本文） | 津軽弁は弱点になりやすい。Opus で実際に読めるかは父の実録音で確かめる | [arXiv 2606.25436](https://arxiv.org/html/2606.25436v1) |
| 2026-11-04 | `gemini-3.5-transcribe` の `custom_vocabulary` は 1,000 語まで、良い結果は概ね 100 語まで。入れるのは専門用語・固有名詞・ブランド名だけで、日常語は入れない。話者分離・単語の時刻とは併用できない | 確認済（公式文書） | 方言の語や数字は語彙に入れない（架空の音声で方言が悪化したのと整合）。整備の言葉だけを少数入れる | [AI Studio transcribe](https://aistudio.google.com/docs/transcribe.md.txt) |
| 2026-11-04 | Scribe v2 の `keyterms` は一括で 1,000 語まで、1 語 50 文字・5 単語まで。文脈を見て書くかを決める。方言・数字への副作用の記載は無い | 未確認（調査役が公式文書を読んだ。メインは未読） | 用語の指定は整備の言葉 10〜20 語に絞って実録音で試す | [ElevenLabs keyterm prompting](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting) |
| 2026-11-04 | 弘前大学に約 1 万語の津軽語辞書（Web 公開）、文例 3 万近く、会話音声 50 時間超、津軽弁音声認識の研究がある。モデルと音声は非公開。辞書は all rights reserved | 未確認（調査役が一次資料を読んだ） | 辞書は意味を確かめる参照だけにする。公開リポジトリに写さない。使うなら許諾を取る | [弘前大学の資料](https://www.innovation.hirosaki-u.ac.jp/wp-content/uploads/2022/04/imai_JPEN.pdf)、[津軽語辞書](https://tgrb.jp/) |
| 2026-11-04 | 国語研の日本語諸方言コーパス（COJADS）は非営利の学術利用だけで、学習したモデルも派生物の扱い | 未確認（規約の本文は未読） | 使わない | [COJADS 利用規約](https://clrd.ninjal.ac.jp/cojads/COJADS_Non_Commercial_1_Academic.pdf) |
| 2026-11-04 | 語に訳語の候補を添えてプロンプトに入れると、追加学習なしで資源の少ない言語の翻訳が良くなる（DiPMT、Chain-of-Dictionary）。STT の複数の候補を LLM に渡すと誤りが減る（HyPoradise）。日本語の方言で「標準語に変換して渡す」と「辞書を添える」を比べた研究は見つからない | 未確認（要旨のみ） | 変換の層は挟まず、小さな対照表を指示に添える。2 社の書き起こしの食い違いを確認事項にする案の根拠 | [arXiv 2302.07856](https://arxiv.org/abs/2302.07856)、[EMNLP 2024](https://aclanthology.org/2024.emnlp-main.55)、[arXiv 2309.15701](https://arxiv.org/abs/2309.15701) |

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
| 2026-11-04 | 販売元は株式会社プロトリオス（プロトコーポレーションのグループ会社）。正式名は「自動車整備業鈑金統合システム RacroS3」で、6 年リース。現行は Ver.2610.00（2026 年 10 月版）。1・4・7・10 月の第一営業日に自動で更新される | 確認済（公式サイト、更新の手引きの PDF） | 年 4 回の更新で画面が変わり得る。次は 2027-01。自動操作は更新のたびに確かめ直す | [製品ページ](https://bsrweb.jp/products/lp/racros/)、[更新の手引き](https://bsrweb.jp/assets_s/pdf/support/racros3/2610/VerupManual_202610.pdf)、[会社概要](https://www.proto-rios.co.jp/company/) |
| 2026-11-04 | 推奨環境は Windows 11 Pro、解像度 1920×1080 以上。ライセンスは USB ドングル（HASP）。複数台では親機（サーバー）と子機に分かれる。アプリのフォルダは `D:\RACROS3\`（更新の手引きの画面写真から） | 確認済（公式 FAQ、更新の手引き） | 記録・操作のプログラムは、親機に触れず子機で動かせるかを確かめる | [動作環境 FAQ](https://bsrweb.jp/faq/displayqa/914982?product_id=racros3&source=other) |
| 2026-11-04 | 公式 FAQ に並ぶ「実行時エラー」の番号（5, 6, 13, 52, 53, 70, 71, 94, 339, 372, 401, 429, 457, 481, 3704）は、VB6 の実行時エラーと ADO のエラー（3704）の番号と一致する | 番号は確認済（公式 FAQ）。VB6＋ADO で作られているという結論は推測 | VB6 なら、普通の欄やボタンは読めても、明細の表（他社製の部品）は外から中身が見えない可能性が高い。実機でウィンドウのクラス名（`ThunderRT6…` なら VB6）を見る | [FAQ 一覧](https://bsrweb.jp/faq/selectinquiry?product_id=racros3) |
| 2026-11-04 | 同じ顧客や同じ伝票の画面を重ねて開くと、排他警告（8001）が出る。直すには、全部の PC で作業を保存してメニュー以外を閉じ、「メンテナンス」→「システム強制リセット」を実行する | 確認済（公式 FAQ の原文）。「他の PC も使えなくなる」とは書かれていない | 自動操作が途中で止まって画面を開いたままにすると、父の作業の邪魔になり得る。操作のプログラムは必ず画面を閉じて終わる。履歴を見るときも同じ伝票を重ねて開かない | [排他警告 FAQ](https://bsrweb.jp/faq/displayqa/306323?product_id=racros3&source=other) |
| 2026-11-04 | 汎用の CSV・Excel・PDF の書き出しと取り込み、API は公開資料に見当たらない。会計ソフト（弥生・勘定奉行）への財務データ出力、顧客・車両の抽出印刷はある | 書き出しが無いことは未確認（記載が無いだけ） | 今夜、メニューで書き出しの機能を探す（#18） | [機能一覧](https://bsrweb.jp/products/racros_function.html) |
| 2026-11-04 | 本体の使用許諾契約は公開されていない。リモートサポートの規約はリバースエンジニアリングを禁じているが、対象はサポートのサービスとソフトで、本体ではない。リモート保守の道具は AnySupport | 契約は未確認。規約は確認済 | 店の契約書に、外部プログラムからの操作やデータの扱いの条項があるかを確かめる | [サポート規約](https://bsrweb.jp/support/clause.html) |
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
| 2026-11-05 | 業務の操作の記録で、画面の作りを確かめた。伝票は M_CAR（顧客・車両）→ M_NOU（伝票）の順に開く。数・文字の欄（NumEdit・TextEdit）は Name で読めるが、明細の表（VSFlexGridL）とツールバーのボタンは名前も値も読めない。M_NOU の保存・印保存の時刻は `TJNL_DAT` の作成・更新の時刻と分まで一致した | 確（記録と読むだけの SQL） | 入力後の照合は DB で行う。ツールバーを名前で押せないので、自動で押す方式は危ない（#26）。詳しくは `docs/racros-screens.md` | 事務所の PC の記録（外に出さない） |
| 2026-11-03 | GATCH と「はい！整備」は Windows 版、Maintenance.c と Car Store System Cloud はブラウザで動く、とされる | 未確認（調査役の報告） | 父の店のソフトは Windows のアプリの見込み | — |
