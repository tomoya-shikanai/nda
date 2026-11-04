# 工場の Raspberry Pi 5 のセットアップ方針

Pi 5 が届いたら、鹿内さんは「SD に OS を書く・電源を入れる・認証する」だけを行う。残りの設定はすべて Claude が Mac から Tailscale 経由の SSH で行う。この文書はその分担、決めたこと、手順、確かめ方をまとめる。

参考にしたもの: `~/dev/AwesomeSea/sensor-system/docs/raspi-setup.md`（Pi 4、Tailscale、鍵認証の実績）と、同じリポジトリの `sensor` skill（Claude が `ssh raspi` で保守する形）。

## 1. Pi の役目

主軸（2026-11-04 決定）は、手がふさがる整備士の事務をハンズフリーで手伝うこと。最初はタイヤ交換の請求書。

| 機器 | 置き場所 | 役目 |
|---|---|---|
| Pi 5 ＋ Jabra Speak 510 ＋ 工場のモニター | 工場 | 起動語「んだ、Claude」の検出、声の録音と再生、モニターに作業状況と確認事項を出す。nDa の本体（Next.js と libSQL）もここで動かす |
| 事務所の PC（Windows） | 事務所 | 整備ソフト。PC に入れる小さなプログラムが、請求書を確定の手前まで入力する（作り方は整備ソフトの確認後に決める） |
| この Mac | 自宅など | 開発と保守。Tailscale で Pi に入る。事務所の PC には Chrome リモートデスクトップで入る |

- 声の文字起こしと Claude は外部の API を使う。録音はファイルで送る（ストリーミングは使わない）。
- 請求書の確定（発行）の最後の一押しは人間が行う。

## 2. 分担

| 段階 | 鹿内さん | Claude |
|---|---|---|
| P0 準備（届く前） | Tailscale のアカウントを決める（§3-6） | この文書、Mac の SSH 鍵と `~/.ssh/config` の用意 |
| P1 書き込み（約 15 分） | Imager で SD に OS を書く（§4）。Pi に挿し、Jabra とモニターをつないで電源を入れる | 設定値を渡す |
| P2 初回接続（約 5 分） | 同じ LAN の Mac から Claude が入れない場合だけ、モニターに出た Tailscale の認証 URL を開く | `ssh` で入り、Tailscale を入れる（§5） |
| P3 設定（約 1 時間） | なし（終わったらモニターの表示を目で確認） | 更新、電源・音声・画面の確認、自動起動（§6） |
| P4 秘密の値 | API キーを Pi の `~/nda/.env` に自分で書く（Claude は値を見ない） | ファイルの権限を確かめる（中身は読まない） |

## 3. 決めたこと

### 3-1. OS は書き直す（キットに入っている OS は使わない）
- キットの SD には Raspberry Pi OS が入っているが、初回の設定（ユーザー作成、Wi-Fi）にモニターとキーボードが要る。
- Imager の「OS のカスタマイズ」で書き直せば、SSH の鍵・Wi-Fi・ホスト名・ユーザーを起動前に入れられ、電源を入れるだけで Mac から入れる。
- この Mac には SD カードスロットと Imager（`/Applications/Raspberry Pi Imager.app`）がある。

### 3-2. デスクトップ付きの 64bit 版にする
- AwesomeSea は画面を使わないので Lite にしたが、こちらは工場のモニターに nDa の画面を出す。
- **Raspberry Pi OS (64-bit)**（デスクトップ付き）を選び、Chromium のキオスク表示（全画面で nDa の画面だけを出す）にする。

### 3-3. 名前
| 項目 | 値 |
|---|---|
| ホスト名 | `nda-pi` |
| ユーザー | `nda`（`pi` は攻撃の辞書に載っているので避ける） |
| Mac の SSH の別名 | `ssh nda-pi` |
| SSH 鍵 | この Pi 専用に `~/.ssh/id_nda_pi`（ed25519）を作る。他案件の鍵を使い回さない |

### 3-4. つなぎ方
- SSH は鍵認証だけにする（パスワード認証は無効）。
- Tailscale を入れ、`tailscale up --ssh` で、工場の外からも `ssh nda-pi` で入れるようにする（MagicDNS）。
- Wi-Fi は工場の SSID を Imager で入れる。届いた場所（自宅など）の SSID も使うなら、後で `nmcli` で足す（AwesomeSea の `raspi-wifi-switch.md` の方式 A）。電波が弱い場合は中継機か LAN ケーブルにする。

### 3-5. Claude が Pi で守ること
- 設定の変更は、Mac のリポジトリの `deploy/pi/` に、何度流しても同じ結果になるスクリプトとして残し、それを `ssh nda-pi` で流す。手で打った変更を残さない。SD が壊れても同じ状態に戻せるようにする。
- `sudo` はセットアップ中だけパスワードなしで使えるようにする。終わったら、使う命令（`systemctl`・`reboot`・`apt`）だけに絞る。
- API キーなどの秘密の値は、鹿内さんが Pi 上の `~/nda/.env`（権限 600）に書く。Claude は中身を読まず、リポジトリにも入れない。
- 客の情報と録音は Pi の `~/nda/data/` に置き、リポジトリには入れない（CLAUDE.md の匿名化の規則と同じ）。
- 夜間ループは Pi に触れない。夜間の sandbox はネットワークを塞いでいるので、今の設定のまま届かない。
- 再起動・電源断・Wi-Fi の切り替えなど、接続が切れる操作は、事前に鹿内さんに伝えてから行う。

### 3-6. 鹿内さんに決めてほしいこと
- **Tailscale のアカウント**: AwesomeSea と同じアカウント（tailnet）に入れるか、家業用に分けるか。AwesomeSea が仕事の案件の tailnet なら、客の情報を扱う Pi は分ける方を推す。この Mac の Tailscale は今止まっている。
- **事務所の PC も Tailscale に入れるか**（後でよい）: 入れると、Pi から事務所の PC へ安定した名前で届き、Mac からの開発も Chrome リモートデスクトップより扱いやすくなる。父の了承が要る。

## 4. P1: SD への書き込み（鹿内さん）

1. キットの microSD を Mac の SD カードスロットに挿す（中の OS は消えてよい）。
2. Raspberry Pi Imager を開き、次を選ぶ。

| 項目 | 値 |
|---|---|
| Device | Raspberry Pi 5 |
| OS | Raspberry Pi OS (64-bit) |
| Storage | 挿した microSD（**他のディスクと間違えないこと**） |

3. 「設定を編集する」で次を入れる。

| タブ | 項目 | 値 |
|---|---|---|
| 一般 | ホスト名 | `nda-pi` |
| 一般 | ユーザー名 | `nda` |
| 一般 | パスワード | 20 文字以上の強いもの（鍵認証にした後はほぼ使わない。パスワードの管理ツールに保存） |
| 一般 | Wi-Fi | 工場の SSID とパスワード、国は `JP`（5GHz を電波法どおりに使うため必須） |
| 一般 | ロケール | タイムゾーン `Asia/Tokyo`、キーボード `jp` |
| サービス | SSH | 有効、**公開鍵認証のみ**。公開鍵は Claude が用意する `~/.ssh/id_nda_pi.pub` の中身を貼る |
| オプション | 終わったら取り出す | 有効 |

4. 書き込み（5〜10 分）が終わったら SD を Pi に挿す。Jabra を USB-A（青い USB 3.0 の端子）に、モニターを micro HDMI の 0 番（USB-C の電源端子に近い側）につなぎ、最後に電源をつなぐ。
5. 1〜2 分でモニターにデスクトップが出たら、Claude に「起動した」と伝える。

## 5. P2: 初回接続と Tailscale（Claude）

```bash
# Mac が同じ LAN にいるとき（mDNS）
ssh nda-pi.local
# Tailscale を入れる
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh   # 表示された URL を鹿内さんが Mac のブラウザで開いて認証
```

- Mac が工場の LAN にいない場合は、鹿内さんが工場で Pi のターミナルを開き、上の 2 行を打つ（認証 URL はスマホで開いてよい）。
- 以後は `~/.ssh/config` の `Host nda-pi`（HostName `nda-pi`、User `nda`、IdentityFile `~/.ssh/id_nda_pi`）で入る。
- OS を書き直したときは `ssh-keygen -R nda-pi.local` と `ssh-keygen -R nda-pi` で古いホスト鍵を消す。

## 6. P3: 設定（Claude）

順に行い、各段で §7 の確認をしてから次へ進む。

1. **更新と基本**: `apt full-upgrade`、`ja_JP.UTF-8` と `en_US.UTF-8` の `locale-gen`（Mac が SSH で `en_US` を送るため）、`timedatectl` で時刻を確かめる。
2. **電源**: 5V 5A で認識されたかを確かめる（§7-1）。駄目なら、電源を Traskit の単品（5.1V/5A、PSE 認証）に替える。
3. **音声**: Jabra を既定の録音・再生の機器にする。Pi 本体の音声出力と順番が入れ替わらないよう、ALSA の設定でカードを固定する。16kHz の音で音程がおかしくなる報告があるので、Jabra の対応する形式に変換して流す。
4. **画面**: Chromium のキオスク表示で、仮のページ（「んだ、Claude」待機中）を全画面に出す。画面が消えないよう、省電力の画面オフを止める。
5. **自動起動**: nDa の本体を systemd のサービスにし、停電から戻ったら自動で上がるようにする（`Restart=always`）。
6. **sudo を絞る**: §3-5 のとおり。
7. **保守の skill**: `.claude/skills/pi/` に、状態・ログ・反映・再起動の命令を書く（AwesomeSea の `sensor` skill と同じ形）。

起動語の検出（Picovoice Porcupine を予定）、文字起こし、Claude の呼び出しは、この土台ができてから別の作業で入れる。Porcupine は日本語の独自起動語に対応しているかと、無料枠をハッカソンの提出に使ってよいかを、入れる前に確かめる。

## 7. 確かめ方

| # | 確かめること | 命令 | 合格 |
|---|---|---|---|
| 1 | 電源が 5A で認識された | `vcgencmd get_config usb_max_current_enable` | `=1`。起動時に 5A 不足の警告が無い |
| 2 | 電圧が落ちていない | `vcgencmd get_throttled` | `throttled=0x0` |
| 3 | Jabra が見える | `arecord -l`、`aplay -l` | どちらにも Jabra が出る |
| 4 | 録音と再生 | 5 秒録って再生する | 音程と速さが正しい。作業場の騒音の中で、2m 離れた声が聞き取れる |
| 5 | モニター | 目で見る | 仮のページが全画面で出て、10 分たっても消えない |
| 6 | 外からの接続 | 工場の外の Mac から `ssh nda-pi` | 入れる |
| 7 | 停電からの復帰 | `sudo reboot` の 2 分後に `ssh nda-pi 'systemctl is-active nda'` | `active`。モニターに仮のページが戻る |
| 8 | 秘密の値 | `stat -c %a ~/nda/.env` | `600`（中身は読まない） |

## 8. つまずいたとき

- **`ssh nda-pi.local` が届かない**: Mac と Pi が同じ LAN にいるか確かめる。AwesomeSea でも Mac から直接届かないことがあり、Tailscale で回避した。
- **`REMOTE HOST IDENTIFICATION HAS CHANGED`**: OS を書き直したため。§5 の `ssh-keygen -R` で古い鍵を消す。
- **locale の警告が出続ける**: `locale-gen` をやり直す。それでも出るなら Mac の `~/.ssh/config` の `Host nda-pi` に `SendEnv -LC_*` を足す。
- **apt で `NO_PUBKEY`**: `sudo apt install -y raspberrypi-archive-keyring` の後に `apt update`。
- **Tailscale がつながらない**: `sudo tailscale status` で認証済みかを見る。Mac と同じアカウントでログインしているか確かめる。

## 履歴
- 2026-11-04 初版。Pi 5（Traskit 4GB キット）、Jabra Speak 510、工場のモニター、Tailscale。11/5 着。
