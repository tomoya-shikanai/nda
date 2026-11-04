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
| 2026-11-04 | Picovoice Porcupine は独自の起動語を作れ、Pi で動く。日本語に対応している、とされる | 未確認（記憶。今回は調べていない） | 使う前に、日本語の独自起動語と、無料枠をハッカソンの提出に使ってよいかを確かめる | — |
| 2026-11-04 | ESP32-S3 の端末側の検出（Espressif WakeNet）は、独自の起動語に Espressif 側での学習が要る | 未確認（記憶） | 11/8 には間に合わないので、検出は Pi で行う | — |

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
| 2026-11-03 | GATCH と「はい！整備」は Windows 版、Maintenance.c と Car Store System Cloud はブラウザで動く、とされる | 未確認（調査役の報告） | 父の店のソフトは Windows のアプリの見込み。製品名を確かめる | — |
