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
| P4 秘密の値 | API キーと合言葉を Pi の `/etc/nda/nda.env`（`nda-app:nda-app` 600）に、事務所の共有の資格情報を `/etc/nda/office-share.cred`（`root:root` 600）に、パスワード付きの sudo で書く（Claude は値を見ない。項目と手順は `deploy/pi/README.md` の「鹿内さんが書く値」）。事務所の PC 名と共有名を Claude に伝える | ファイルの権限と所有者を確かめる（中身は読まない） |

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
| ユーザー | `nda`（管理用。`pi` は攻撃の辞書に載っているので避ける） |
| 本体を動かすユーザー | `nda-app`（`50-service.sh` が `--system` で作る。sudo なし、ログインできない） |
| Mac の SSH の別名 | `ssh nda-pi` |
| SSH 鍵 | この Pi 専用に `~/.ssh/id_nda_pi`（ed25519）を作る。他案件の鍵を使い回さない |

### 3-4. つなぎ方
- SSH は鍵認証だけにする（パスワード認証は無効）。
- Tailscale を入れ、`tailscale up --ssh` で、工場の外からも `ssh nda-pi` で入れるようにする（MagicDNS）。
- Wi-Fi は工場の SSID を Imager で入れる。届いた場所（自宅など）の SSID も使うなら、後で `nmcli` で足す（AwesomeSea の `raspi-wifi-switch.md` の方式 A）。電波が弱い場合は中継機か LAN ケーブルにする。

### 3-5. Claude が Pi で守ること
- 設定の変更は、Mac のリポジトリの `deploy/pi/` に、何度流しても同じ結果になるスクリプトとして残し、それを `ssh nda-pi` で流す。手で打った変更を残さない。SD が壊れても同じ状態に戻せるようにする。
- 管理と本体の実行を別のユーザーに分ける。Claude が入る `nda` は管理用、本体（`nda.service`）は sudo を持たない `nda-app` で動かし、systemd の保護（`NoNewPrivileges`・`ProtectSystem=strict` など）をかける。本体の不具合が管理者の権限につながらないようにするため。
- `sudo` はセットアップ中だけパスワードなしで使えるようにする。終わったら、パスワードなしは引数まで固定した命令（`systemctl start/stop/restart nda.service`・`reboot`）だけに絞る。`apt` と `systemctl` の任意の操作は、フックや任意のユニットで root を取れるので許さない。OS の更新は `unattended-upgrades` に任せ、手で行うときはパスワード付きの sudo を使う。ログは sudo なしで読む（`systemd-journal` グループ）。
- 置き場: 本体は `/opt/nda`（`nda` が配置、`nda-app` は読むだけ）、データは `/var/lib/nda`（`nda-app` だけが書ける）。
- API キーなどの秘密の値は、鹿内さんが Pi 上の `/etc/nda/nda.env`（`nda-app:nda-app`、権限 600）に書く。Claude は中身を読まず、リポジトリにも入れない。
- 客の情報と録音は Pi の `/var/lib/nda/` に置き、リポジトリには入れない（CLAUDE.md の匿名化の規則と同じ）。
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

順に行い、各段で §7 の確認をしてから次へ進む。各段のスクリプトは `deploy/pi/` にある（流し方と戻し方は `deploy/pi/README.md`）。

1. **更新と基本**（`10-base.sh`）: `apt full-upgrade`、`unattended-upgrades` の有効化（60 で apt の sudo を外すため）、`ja_JP.UTF-8` と `en_US.UTF-8` の `locale-gen`（Mac が SSH で `en_US` を送るため）、`timedatectl` で時刻を確かめる。
2. **電源**（`20-power-check.sh`）: 5V 5A で認識されたかを確かめる（§7-1）。駄目なら、電源を Traskit の単品（5.1V/5A、PSE 認証）に替える。
3. **音声**（`30-audio.sh`）: Jabra を既定の録音・再生の機器にする。Pi 本体の音声出力と順番が入れ替わらないよう、ALSA の設定でカードを固定する。16kHz の音で音程がおかしくなる報告があるので、Jabra の対応する形式に変換して流す。
4. **画面**（`40-display.sh`）: Chromium のキオスク表示で、nDa のモニター（`/monitor`）を全画面に出す。画面が消えないよう、省電力の画面オフを止める。
   触らなくても声が鳴るよう自動再生を許す（`--autoplay-policy=no-user-gesture-required`）。起動のたびに PipeWire の既定のシンク・ソースを Jabra にする。
5. **自動起動**（`50-service.sh`）: Node（公式の tar、版と SHA-256 を固定）を入れ、本体専用の `nda-app` を作り、公開リポジトリを `/opt/nda` に clone し、nDa の本体を `nda-app` で動く systemd のサービスにし、停電から戻ったら自動で上がるようにする（`Restart=always`）。作業の状態と料金表は `/var/lib/nda`（`NDA_SESSION_DIR`・`NDA_LEDGER_PATH`）。
6. **本体の配置**（`52-deploy.sh`）: `origin/main` に合わせて build し、`nda.service` を入れ直す。本体を更新するたびに流す。
7. **ずんだもんの声**（`57-voicevox.sh`）: VOICEVOX ENGINE の Linux arm64 の CPU 版（公式 Releases）を `127.0.0.1:50021` のサービスにする。遅いときの代わりは `deploy/pi/README.md` の「声の代わり」。
8. **聞き役**（`55-listener.sh`）: §6-1。
9. **事務所の受け箱**（`58-office-share.sh`）: 事務所の PC の共有（SMB 3.0 以上、暗号化）を `/mnt/nda-office` に automount し、本体は `NDA_OFFICE_BOX` でそこに書く（`docs/decisions.md` 2026-11-05）。
10. **sudo を絞る**（`60-sudo-tighten.sh`）: §3-5 のとおり、パスワードなしは固定の 4 命令だけにする。最後に流す。
11. **保守の skill**: `.claude/skills/pi/` に、状態・ログ・反映・再起動の命令を書く（AwesomeSea の `sensor` skill と同じ形）。

起動語は Picovoice Porcupine をやめて Vosk にした（`docs/decisions.md` 2026-11-04。§6-1）。

本体は `127.0.0.1:3000` だけで待つ。LAN に出すのは事務所の返しの関所（`0.0.0.0:3001`、`POST /api/office/reply` だけを本体へ中継）だけ（`deploy/pi/README.md` の「LAN に出すのは関所だけ」）。事務所の返し先は `http://<Pi>:3001/api/office/reply`。
出来事の記録（`docs/logging.md`）は `/var/lib/nda/logs`（`NDA_LOG_DIR`）。本体と聞き役の両方が書く。

### 6-1. 現場の聞き役（起動語と録音）

起動語の検出と録音は `device/listener/listen.py`（Vosk、オフライン）が行い、`/api/session/voice` へ送る。Mac で先に一周させてある。
Pi では `55-listener.sh` が `libportaudio2` と venv を入れ、Vosk の `vosk-model-small-ja-0.22`（alphacephei.com、SHA-256 `efa092d280153a77615e9e0c7d7283e93e600de3d19d3bec686c57ef19d52eac`）を `/opt/nda-listener` に置き、`--device Jabra --output-device Jabra` 相当の環境変数で `nda` のユーザーのサービス（`nda-listener.service`）にする。
ユーザーのサービスにするのは、画面の Chromium（ずんだもんの声）と同じ PipeWire のセッションで Jabra を使うためと、本体の更新の後に sudo なしで入れ直すため。本体の `/monitor` が応答するまで待ってから聞き始める。閾値と変える所は `device/listener/README.md`。

## 7. 確かめ方

Pi の上で自動で確かめられる項目は `deploy/pi/90-verify.sh` が表にする（#4・#5・#6、#7 の再起動後の確認、#13 の起動語は人が行う。#10 は本体が動いていれば自動）。

| # | 確かめること | 命令 | 合格 |
|---|---|---|---|
| 1 | 電源が 5A で認識された | `vcgencmd get_config usb_max_current_enable` | `=1`。起動時に 5A 不足の警告が無い |
| 2 | 電圧が落ちていない | `vcgencmd get_throttled` | `throttled=0x0` |
| 3 | Jabra が見える | `arecord -l`、`aplay -l` | どちらにも Jabra が出る |
| 4 | 録音と再生 | 5 秒録って再生する | 音程と速さが正しい。作業場の騒音の中で、2m 離れた声が聞き取れる |
| 5 | モニター | 目で見る | 仮のページが全画面で出て、10 分たっても消えない |
| 6 | 外からの接続 | 工場の外の Mac から `ssh nda-pi` | 入れる |
| 7 | 停電からの復帰 | `sudo reboot` の 2 分後に `ssh nda-pi 'systemctl is-active nda'` | `active`。モニターに仮のページが戻る |
| 8 | 秘密の値 | `stat -c '%U:%G %a' /etc/nda/nda.env` | `nda-app:nda-app 600`（中身は読まない） |
| 9 | 本体のユーザーに sudo が無い | `id -nG nda-app`、`getent passwd nda-app` | `sudo` 等のグループに入っていない。シェルが `nologin` |
| 10 | 本体が専用のユーザーで動く | `systemctl show -p User,MainPID nda.service`、`ps -o user= -p <PID>` | `nda-app` |
| 11 | パスワードなしの sudo が固定の命令だけ | `sudo -n -l`、`sudo -n true` | `NOPASSWD:` は `systemctl start/stop/restart nda.service` と `reboot` だけ。`sudo -n true` は拒否 |
| 12 | 本体と関所 | `curl 127.0.0.1:3000/monitor`、`ss -ltn`、関所の `/monitor`、関所への合言葉なしの `POST /api/office/reply` | `/monitor` が 200、本体は `127.0.0.1:3000` だけ、関所の `/monitor` は 404、返しは 401 か 503 |
| 13 | 聞き役が動く | `systemctl --user status nda-listener`、「んだ クロード」と言う | active。ログに「起動語待ち」。合図音が Jabra から鳴り、話した声がモニターに出る |
| 14 | ずんだもんの声 | `curl 127.0.0.1:50021/version`、短い 1 文を合成 | 応答がある。1 文 3 秒以内。モニターの台詞が Jabra から鳴る（人） |
| 15 | 受け箱の mount | `findmnt /mnt/nda-office`、`.nda-box` | cifs で `seal` 付きで mount され、目印がある |
| 16 | 出来事の記録 | `stat /var/lib/nda/logs`、nda で書いてみる | `nda-app:nda 2770`、nda が書ける。一周の後に `events-*`・`listener-*` が出る |

## 8. つまずいたとき

- **`ssh nda-pi.local` が届かない**: Mac と Pi が同じ LAN にいるか確かめる。AwesomeSea でも Mac から直接届かないことがあり、Tailscale で回避した。
- **`REMOTE HOST IDENTIFICATION HAS CHANGED`**: OS を書き直したため。§5 の `ssh-keygen -R` で古い鍵を消す。
- **locale の警告が出続ける**: `locale-gen` をやり直す。それでも出るなら Mac の `~/.ssh/config` の `Host nda-pi` に `SendEnv -LC_*` を足す。
- **apt で `NO_PUBKEY`**: `sudo apt install -y raspberrypi-archive-keyring` の後に `apt update`。
- **Tailscale がつながらない**: `sudo tailscale status` で認証済みかを見る。Mac と同じアカウントでログインしているか確かめる。

## 履歴
- 2026-11-04 初版。Pi 5（Traskit 4GB キット）、Jabra Speak 510、工場のモニター、Tailscale。11/5 着。
- 2026-11-04 本体を sudo の無い `nda-app` で動かし（置き場 `/opt/nda`・`/var/lib/nda`・`/etc/nda/nda.env`）、パスワードなしの sudo を固定の 4 命令に絞った（自動セキュリティレビューの指摘）。§7 に #9〜#11 を足した。
- 2026-11-05 §6-1 に現場の聞き役（`device/listener`）への参照を足した。起動語は Porcupine でなく Vosk。
- 2026-11-08 今の本体に追いつかせた。Node の導入と clone（50）、配置と build（52）、聞き役（55）、VOICEVOX（57）、事務所の受け箱の mount（58）を足し、キオスクを自動再生ありに。§7 に #12〜#15 を足した。
- 2026-11-08 自動のセキュリティ点検の 3 件: 本体を 127.0.0.1 に戻し、LAN には事務所の返しの関所（:3001）だけを出す。受け箱の SMB を暗号化（seal、3.0 以上）し、名前の解決の IP を鹿内さんが確かめる。出来事の記録の置き場（`/var/lib/nda/logs`、#16）を足した。
