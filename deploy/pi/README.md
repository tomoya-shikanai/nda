# deploy/pi: 工場の Raspberry Pi 5 の設定スクリプト

方針と背景は `docs/pi-setup.md`（§6 が P3 の設定、§7 が確かめ方）。ここはその手順をスクリプトにしたもの。
Pi には手で変更を入れず、必ずここのスクリプトを流す（SD が壊れても同じ状態に戻すため）。

**2026-11-08 に実機（Raspberry Pi OS、Debian 13 trixie）で 10〜59 を流した**（58 の SMB は送り箱＋門番の 59 に置き換えたので流していない。60 は撮影の後）。実機で直したもの: 30 で Jabra のカード番号を 0 に固定すると HDMI とぶつかる（固定をやめた）、40 で Chromium が鍵束のパスワードを求めて画面を塞ぐ（--password-store=basic）、59 の確かめを / で流す。

## 流す順（一覧）

Mac のリポジトリのルートから。`<…>` は鹿内さんに聞いて埋める。

```bash
ssh nda-pi 'bash -s' < deploy/pi/10-base.sh            # 更新・自動更新・locale
ssh nda-pi 'bash -s' < deploy/pi/20-power-check.sh     # 5A と電圧（不合格なら電源を替える）
ssh nda-pi 'bash -s' < deploy/pi/30-audio.sh           # Jabra をカード 0 に固定
ssh nda-pi 'bash -s' < deploy/pi/40-display.sh         # キオスク（/monitor、自動再生、声は Jabra）
ssh nda-pi 'bash -s' < deploy/pi/50-service.sh         # Node・nda-app・置き場・clone・nda.service
#   ここで鹿内さんが /etc/nda/nda.env を書く（下の「鹿内さんが書く値」）
ssh nda-pi 'bash -s' < deploy/pi/52-deploy.sh          # origin/main に合わせて build、nda.service を起動
ssh nda-pi 'bash -s' < deploy/pi/57-voicevox.sh        # ずんだもんの声（約 1.9GB を取る。数分〜十数分）
ssh nda-pi 'bash -s' < deploy/pi/55-listener.sh        # 聞き役（起動語・録音）
#   ここで鹿内さんが事務所の PC の共有を設定し（下の「鹿内さんがやる設定」）、/etc/nda/office-share.cred を書く
ssh nda-pi 'NDA_OFFICE_HOST=<PC 名> NDA_OFFICE_SHARE=<共有名> bash -s' < deploy/pi/58-office-share.sh
#   nda.env に NDA_OFFICE_BOX=/mnt/nda-office を足して sudo systemctl restart nda.service（鹿内さん）
#   再起動（鹿内さんに伝えてから）: 30 のカード固定・40 のキオスク・audio グループが効く
ssh nda-pi 'bash -s' < deploy/pi/90-verify.sh          # 16 項目の表
ssh nda-pi 'bash -s' < deploy/pi/60-sudo-tighten.sh    # 最後。パスワードなしの sudo を固定の 4 命令に絞る
```

本体の更新は、Mac で main に push した後に `ssh nda-pi 'bash -s' < deploy/pi/52-deploy.sh` だけ（60 の後も流せる）。
聞き役のコードも `/opt/nda/device/listener` を使うので、52 の後に `ssh nda-pi 'systemctl --user restart nda-listener.service'`。

## 流し方

Mac のリポジトリのルートから、Tailscale 経由の SSH で流す。

```bash
ssh nda-pi 'bash -s' < deploy/pi/10-base.sh
```

- 何度流しても同じ結果になる。変更の前に今の状態を見て、すでに正しければ何もしない。
- 1 行ごとに `[済]`（変更不要）、`[変更]`（やった）、`[情報]`、`[警告]`、`[要再起動]`、`[失敗]` を出す。
- 再起動・電源断など接続が切れる操作は、スクリプトはしない。必要なら `[要再起動]` と出すので、鹿内さんに伝えてから行う。
- 秘密の値（`/etc/nda/nda.env`）の中身は、どのスクリプトも読まない・作らない。権限と所有者だけ見る。

## 順番

| 順 | スクリプト | 何をするか | 終わりの確認（docs §7） |
|---|---|---|---|
| 1 | `10-base.sh` | `apt full-upgrade`、`unattended-upgrades` を入れて毎日の自動更新を有効にする（自動の再起動はしない）、`ja_JP.UTF-8` と `en_US.UTF-8` の `locale-gen`、タイムゾーンが `Asia/Tokyo` か確認 | 時刻 |
| 2 | `20-power-check.sh` | `usb_max_current_enable=1` と `throttled=0x0` を確かめて合否を出す（設定は変えない。不合格で終了コード 1） | #1, #2 |
| 3 | `30-audio.sh` | Jabra を ALSA のカード 0 に固定（`/etc/modprobe.d/nda-audio.conf`）、`/etc/asound.conf` で既定の録音・再生にし、`plug` で 16kHz モノに変換して流す。5 秒録って再生する手順を表示 | #3, #4 |
| 4 | `40-display.sh` | `~/.local/bin/nda-kiosk.sh`（本体が上がるのを待ち、PipeWire の既定のシンク・ソースを Jabra にして、Chromium を全画面・自動再生ありで `http://localhost:3000/monitor` に開く）、`~/.config/labwc/autostart`、デスクトップ自動ログイン、画面ブランキング無効、`pactl`（pulseaudio-utils） | #5 |
| 5 | `50-service.sh` | Node 24.22.1 を公式の tar（SHA-256 固定）で `/usr/local/lib/nodejs` に入れる。本体専用の `nda-app`、置き場（下の表）、公開リポジトリの clone（初回だけ）、料金表を `/var/lib/nda/ledger.json` に写す（初回だけ）、`nda.service`（`User=nda-app`、`next start -H 127.0.0.1 -p 3000`、`NDA_SESSION_DIR`・`NDA_LEDGER_PATH`・`NDA_LOG_DIR` は `/var/lib/nda`、systemd の保護つき）と関所 `nda-office-gate.service`（`0.0.0.0:3001`、`POST /api/office/reply` だけ）を enable。build 前は start しない | #7〜#10 |
| 6 | `52-deploy.sh` | `/opt/nda` を `origin/main`（`NDA_REF` で変えられる）に合わせ、`corepack pnpm install --frozen-lockfile` と `next build`（同じコミットなら飛ばす）。`.next/cache` を `/var/lib/nda/next-cache` へ向け、`nda.service` を restart して `/monitor` が 200 になるまで待つ | #12 |
| 7 | `57-voicevox.sh` | VOICEVOX ENGINE 0.26.1 の `linux-cpu-arm64`（公式 Releases、SHA-256 固定）を `/opt/voicevox-engine/0.26.1` に置き、`nda-voicevox.service`（`127.0.0.1:50021`、DynamicUser、4 スレッド）にする。起動の後にずんだもんを読み込み、1 文の合成の秒数を出す | #14 |
| 8 | `55-listener.sh` | `libportaudio2`・`python3-venv`、`/opt/nda-listener/venv` に `requirements.txt`、Vosk の `vosk-model-small-ja-0.22`（SHA-256 固定）、`nda` を `audio` グループと linger に入れ、nda のユーザーのサービス `nda-listener.service`（`--device Jabra --output-device Jabra` 相当、本体の `/monitor` が応答するまで待つ）を enable・起動 | #13 |
| 9 | `58-office-share.sh` | `cifs-utils`、事務所の PC の共有を `/mnt/nda-office` に mount する systemd の mount と automount のユニット（`<PC 名>.local` → だめなら NetBIOS の IP、`/etc/nda/office-share.cred`、`vers=3.0`、持ち主 `nda-app`）。`seal`（暗号化）、3.0 未満の版は断る。解決した IP を出し、鹿内さんが PC の IP と同じか確かめる。目印 `.nda-box` を確かめる | #15 |
| 10 | `90-verify.sh` | §7 の 16 項目のうち Pi 上で自動で見られるものを表にする（合格／不合格／手動） | 全項目 |
| 11 | `60-sudo-tighten.sh` | `nda` のパスワードなしの sudo を、引数まで固定した 4 命令（`systemctl start/stop/restart nda.service`、`reboot`）だけにする。`nda` を `systemd-journal` に入れ、ログは sudo なしで読む。**最後に流す** | #11 |

各段で終わりの確認をしてから次へ進む。20 が不合格なら、電源を替えてから先へ進む。
40・55 を流した後、画面・声・聞き役の確認のために再起動する（鹿内さんに伝えてから）。
Tailscale は、このスクリプト群の範囲外（docs §5）。

## サービスの一覧

| サービス | 種類 | 動かすユーザー | 待ち受け | ログ |
|---|---|---|---|---|
| `nda.service` | system | `nda-app` | `127.0.0.1:3000`（この Pi の中だけ） | `journalctl -u nda.service` |
| `nda-office-gate.service` | system | その場限り（DynamicUser） | `0.0.0.0:3001`（`POST /api/office/reply` だけを本体へ） | `journalctl -u nda-office-gate.service` |
| `nda-voicevox.service` | system | その場限り（DynamicUser） | `127.0.0.1:50021` | `journalctl -u nda-voicevox.service` |
| `nda-listener.service` | user（nda） | `nda` | なし（本体へ送るだけ） | `journalctl --user -u nda-listener.service` |
| `mnt-nda\x2doffice.automount` | system | — | — | `journalctl -u 'mnt-nda\x2doffice.mount'` |
| キオスク（Chromium） | labwc の autostart | `nda` | — | — |

聞き役を nda のユーザーのサービスにしたのは、画面の Chromium と同じ PipeWire のセッションで Jabra を使うため（別のユーザーだと Jabra を取り合う）と、本体の更新の後に sudo なしで入れ直すため。

## 鹿内さんが書く値

Claude は中身を読まない。どちらも Pi の上でパスワード付きの sudo で書く。

### `/etc/nda/nda.env`（`nda-app:nda-app` 600）

`.env.example` の全項目。値はここに書かない。

| 名前 | 何か | 工場の Pi での値の決め方 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude の API キー | 必須 |
| `ELEVENLABS_API_KEY` | ElevenLabs（Scribe v2）の API キー | 聞き役の既定の STT が scribe なので必須 |
| `GEMINI_API_KEY` | Gemini の API キー | STT を gemini にするとき |
| `AMIVOICE_APP_KEY` | AmiVoice の APPKEY | 比べるときだけ。空でよい |
| `NDA_OFFICE_BOX` | 事務所の受け箱 | `/mnt/nda-office`（共有の中の下の階層にしたなら `/mnt/nda-office/<SUBDIR>`。58 が最後に出す値）。空なら事務所なし |
| `NDA_OFFICE_SFTP` | sftp の口（未実装） | 書かない（空） |
| `NDA_OFFICE_BOX_REQUIRE_MOUNT` | 受け箱が mount した先かを確かめる | 書かない（既定は確かめる。`0`・`false`・`no` のときだけ確かめない。Pi では確かめる） |
| `NDA_OFFICE_TOKEN` | 事務所→工場の返し（`POST /api/office/reply`）の合言葉 | 事務所の `box\config.json` の `secret` と同じ値。空なら受け口は閉じる（503） |

次は `.env.example` に無く、`nda.service` が既定を入れる（nda.env に書けばそちらが勝つ。普段は書かない）。
`NDA_SESSION_DIR=/var/lib/nda/sessions`、`NDA_LEDGER_PATH=/var/lib/nda/ledger.json`、`NDA_LOG_DIR=/var/lib/nda/logs`（聞き役にも同じ値を 55 が入れる）。
声を Pi の外で作るときだけ `VOICEVOX_URL=http://<その機械>:50021` を書く（下の「声の代わり」）。話速は `NDA_TTS_SPEED`（0.5〜2、既定 1.25）。

```bash
sudo nano /etc/nda/nda.env
sudo chown nda-app:nda-app /etc/nda/nda.env && sudo chmod 600 /etc/nda/nda.env
sudo systemctl restart nda.service
```

### `/etc/nda/office-share.cred`（`root:root` 600）

事務所の PC の共有に入る、工場専用の低い権限のユーザー（下の「鹿内さんがやる設定」）。

```text
username=<ユーザー>
password=<パスワード>
domain=<PC 名か WORKGROUP。要らなければ行ごと書かない>
```

```bash
sudo nano /etc/nda/office-share.cred
sudo chown root:root /etc/nda/office-share.cred && sudo chmod 600 /etc/nda/office-share.cred
```

あわせて、58 に渡す PC 名（Windows の「設定 → システム → バージョン情報」のデバイス名）と共有名を Claude に伝える。

## LAN に出すのは関所だけ

本体（`next start`）は `127.0.0.1:3000` だけで待ち、LAN にも Tailscale にも出さない。画面（`/monitor`）は同じ Pi のキオスクが開く。
事務所の返しのためだけに、関所 `nda-office-gate.service`（`scripts/office-gate.ts`、Node の標準の http だけ）が `0.0.0.0:3001` で待つ。

- 中継するのは `POST /api/office/reply` だけ。他の道は 404、同じ道の POST 以外は 405、本文が 64KB を超えたら 413、本体が止まっていれば 502。
- 渡すヘッダーは `Authorization` と `Content-Type` だけ。合言葉（`NDA_OFFICE_TOKEN`）の確かめは本体の route がする（違えば 401、未設定なら 503）。
- 関所は `DynamicUser` で動き、受けるのは私設の LAN（`10/8`・`172.16/12`・`192.168/16`）・Tailscale（`100.64/10`）・自分だけ（`IPAddressAllow=`）。
- `PartOf=nda.service` なので、52 が本体を restart すると関所も入れ直される。

**事務所の返し先（#41 の事務所のプログラムの設定）**: `http://<Pi の名前か IP>:3001/api/office/reply`（3000 ではない）。
同じ LAN の中なら `http://nda-pi.local:3001/api/office/reply`、Tailscale なら `http://nda-pi:3001/api/office/reply`。

残る危険: 同じ LAN の誰でも関所まで届く。合言葉を知らなければ 401 で止まるが、合言葉が漏れれば照合の答え・入力の結果を偽って返せる。客用の Wi-Fi と店の LAN が分かれているかを鹿内さんに確かめる。

## 鹿内さんがやる設定（事務所の PC）

受け箱の共有は、次の形にする（58 の前に）。

1. **工場専用のユーザー**を事務所の PC に作る（例 `nda-factory`。管理者にしない、ふだんのログインに使わない、強いパスワード）。この名前とパスワードを `/etc/nda/office-share.cred` に書く。
2. **受け箱だけを共有する**（`C:\nda\box\in` を共有。ドライブ全体や業務ソフトのフォルダを共有しない）。共有の権限とフォルダの権限（NTFS）の両方で、`nda-factory` には受け箱の「変更」（書く・名前を変える・消す）だけを与え、他の場所には何も与えない。`Everyone` を外す。
3. **通り道を暗号化する**（管理者の PowerShell で）:
   ```powershell
   Set-SmbShare -Name <共有名> -EncryptData $true -Force
   Get-SmbShare -Name <共有名> | Select-Object Name, Path, EncryptData   # EncryptData が True
   ```
   Pi 側は `seal`（暗号化）と `vers=3.0` 以上で mount する（58 が 3.0 未満を断る）。
4. **IP を固定するか、ルーターで予約する**（名前が引けないとき 58 は IP で mount する）。
5. 58 が出す「宛先 … は今 … に解決された」の IP が、事務所の PC で `ipconfig` した IP と同じかを確かめる。違えば止めて Claude に伝える。

名前の解決の限界: `<PC 名>.local`（mDNS）と NetBIOS は、同じ LAN の中の機械がなりすませる（偽の PC が名乗り出る）。
なりすまされると、工場の請求の依頼がその機械に置かれうる。資格情報は `seal` の SMB3 の認証で守られ、平文では流れない。
被害を小さくするため、共有のユーザーは受け箱だけに書ける低い権限にしている（上の 1・2）。なりすましを防ぐ方法（IP の固定と照合、Tailscale＋SSH への切り替え）は、LAN に知らない機械がつながる店なら検討する。

## 声の代わり（VOICEVOX を Pi で動かせない・遅いとき）

本体は `VOICEVOX_URL` の先に問う（`lib/voice/tts.ts`）。失敗しても画面は文字だけで続く（声が出ないだけ）。

| 案 | やり方 | 良い所 | 悪い所 |
|---|---|---|---|
| A. Pi で動かす（推す） | 57 | 外の機械に頼らない。LAN の往復が無い | Pi 5 の CPU で 1 文が何秒かは未確認。4GB を本体の build と分け合う |
| B. 事務所の PC で動かす | 事務所の PC に VOICEVOX（ENGINE か製品版）を入れ、`run --host 0.0.0.0` で上げ、Windows のファイアウォールで 50021 を Pi の IP だけに開ける。nda.env に `VOICEVOX_URL=http://<PC 名>.local:50021` | PC の CPU は Pi より速い見込み | 事務所の PC が止まると声が出ない。父の PC に常駐物が増える |
| C. この Mac で動かす | Mac の VOICEVOX ENGINE を `--host 0.0.0.0` で上げ、`VOICEVOX_URL=http://<Mac の Tailscale 名>:50021` | 今すぐ動く（Mac では一周済み） | Mac が工場にある間だけ。撮影の日の控えにとどめる |

57 の最後と 90 の #14 が 1 文の秒数を出す。3 秒を超えるなら、まず `NDA_VOICEVOX_THREADS` と話速を見て、それでも遅ければ B に切り替える。

## ユーザーと置き場

管理と本体の実行を別のユーザーに分ける。本体の不具合が管理者の権限につながらないようにするため。

| ユーザー | 何に使うか | sudo | ログイン |
|---|---|---|---|
| `nda` | 管理用。Claude が SSH で入り、スクリプトを流し、本体を配置する | パスワード付きは全部（`%sudo`）。パスワードなしは固定の 4 命令だけ（60 の後） | SSH（鍵）とデスクトップ（キオスク） |
| `nda-app` | 本体（`nda.service`）を動かすだけ。`useradd --system` | なし | できない（シェルは `nologin`） |

| 置き場 | 所有者・権限 | 中身 |
|---|---|---|
| `/opt/nda` | `nda:nda` 755 | 本体のコード（公開リポジトリの clone、`node_modules`、`.next`）。`nda` が 52 で更新し、`nda-app` は読むだけ（`ProtectSystem=strict` で読み取り専用になる） |
| `/var/lib/nda` | `nda-app:nda-app` 751 | データ。`nda-app` のホームも兼ねる。`nda.service` が書けるのはここと受け箱だけ（`ReadWritePaths=`）。751 は、他のユーザーは中を一覧できず `logs/` へ通れるだけ |
| `/var/lib/nda/logs` | `nda-app:nda` 2770 | 出来事の記録（`NDA_LOG_DIR`、`docs/logging.md`）。本体（`events-*.jsonl`）と聞き役の `nda`（`listener-*.jsonl`）が書く。ファイルは書き手が 600 で作るので、本体の記録を読むのは `nda-app`（パスワード付きの `sudo -u nda-app`） |
| `/var/lib/nda/sessions` | `nda-app:nda-app` 750 | 作業の状態（文字起こし・明細を含む。`NDA_SESSION_DIR`） |
| `/var/lib/nda/ledger.json` | `nda-app:nda-app` 640 | 料金表（`NDA_LEDGER_PATH`）。50 が初回だけ `/opt/nda/data/ledger.json` から写す。以後はこちらが正 |
| `/var/lib/nda/next-cache` | `nda-app:nda-app` 750 | `next start` のキャッシュ。`/opt/nda/.next/cache` がここを指す（52 が張る） |
| `/etc/nda/nda.env` | `nda-app:nda-app` 600 | 秘密の値。systemd が `EnvironmentFile` として読む。鹿内さんが書く（上の「鹿内さんが書く値」） |
| `/etc/nda/office-share.cred` | `root:root` 600 | 事務所の共有の資格情報。鹿内さんが書く |
| `/mnt/nda-office` | cifs（持ち主 `nda-app`、グループ `nda`、`seal`） | 事務所の受け箱（58） |
| `/usr/local/lib/nodejs` | `root` 755 | Node 24.22.1（50） |
| `/opt/voicevox-engine/<版>`・`current` | `root` 755 | VOICEVOX ENGINE（57）。`/var/lib/nda-voicevox` が書き込み先 |
| `/opt/nda-listener` | `nda:nda` 755 | 聞き役の venv と Vosk のモデル（55） |

本体の更新は 52（`sudo systemctl restart nda.service` だけ使うので、60 の後もパスワードなしで通る）。
状態とログは sudo なしで `systemctl status nda.service`、`journalctl -u nda.service -n 100`。

Node の場所は `50-service.sh` の `NODE_BIN_DIR`（既定 `/usr/local/bin`、50 が公式の tar を入れて張る）。pnpm は入れない。build のときだけ `corepack pnpm`（`package.json` の `packageManager` の版）を使い、実行は `node node_modules/next/dist/bin/next start` で pnpm を通さない。

### OS の更新

60 の後は、`apt`・`apt-get` をパスワードなしの sudo で使えない（apt のフックで root を取れるため外した）。
- 普段は `unattended-upgrades`（10 で有効にする）が毎日、更新を入れる。自動の再起動はしない。`/var/run/reboot-required` があれば、鹿内さんに伝えてから `sudo reboot`。
- 手で更新するときは、パスワード付きの sudo（Pi のターミナルか `ssh -t nda-pi`）で `sudo apt update && sudo apt full-upgrade`。

### 60 を流した後に他のスクリプトを流し直すとき

60 の後は `sudo` が固定の 4 命令以外ではパスワードを要求する。10・30・40・50・55・57・58 の流し直しは、次の「戻し方」で一時的に緩めてから行い（52 は緩めなくてよい）、終わったら 60 を流し直す。

## 戻し方

どれも Pi の上（SSH かモニター）で行う。`*.nda-orig` はスクリプトが初めて上書きするときに残した元のファイル。

| スクリプト | 戻し方 |
|---|---|
| 10 | locale は `sudo nano /etc/locale.gen` で行を戻して `sudo locale-gen`。`apt` の更新は戻さない（戻す必要が出たら SD を書き直す） |
| 20 | 変更なし |
| 30 | `sudo rm /etc/modprobe.d/nda-audio.conf`、`/etc/asound.conf` は `.nda-orig` があれば戻し、無ければ `sudo rm`。再起動で反映 |
| 40 | `rm ~/.local/bin/nda-kiosk.sh`、`~/.config/labwc/autostart` は `.nda-orig` があれば戻し、無ければ消す。ブランキングは `sudo raspi-config nonint do_blanking 0`。再起動で反映 |
| 50 | `sudo systemctl disable --now nda.service && sudo rm /etc/systemd/system/nda.service && sudo systemctl daemon-reload`。`nda-app` を消すなら `sudo userdel nda-app`。`/opt/nda`・`/var/lib/nda`・`/etc/nda/nda.env` は触らない（データと秘密の値を消さない） |
| 52 | `ssh nda-pi 'NDA_REF=<戻したいコミット> bash -s' < deploy/pi/52-deploy.sh` |
| 55 | `systemctl --user disable --now nda-listener.service && rm ~/.config/systemd/user/nda-listener.service && systemctl --user daemon-reload`。`/opt/nda-listener` は消してよい。linger は `sudo loginctl disable-linger nda` |
| 57 | `sudo systemctl disable --now nda-voicevox.service && sudo rm /etc/systemd/system/nda-voicevox.service && sudo systemctl daemon-reload`。`/opt/voicevox-engine` と `/var/lib/private/nda-voicevox` は消してよい |
| 58 | `sudo systemctl disable --now 'mnt-nda\x2doffice.automount' && sudo systemctl stop 'mnt-nda\x2doffice.mount'`、`/etc/systemd/system/mnt-nda\x2doffice.{mount,automount}` を消して daemon-reload。資格情報は鹿内さんが消す |
| 60 | 下を参照 |

### 60 の戻し方（sudo を緩める）

絞った後は `nda` のパスワード付きの `sudo`（`%sudo` グループ経由）で戻せる。Pi のターミナルか、`ssh -t nda-pi` で行う。

```bash
sudo mv /etc/sudoers.d/010_pi-nopasswd.nda-disabled /etc/sudoers.d/010_pi-nopasswd   # 全許可に戻す
sudo rm /etc/sudoers.d/020_nda-tight                                                   # 絞りの規則を消す（任意）
sudo gpasswd -d nda systemd-journal                                                    # ログのグループから外す（任意）
```

締め出された場合（パスワードも通らない）は、SD を Mac に挿して `etc/sudoers.d/` を直す。なお `/etc/sudoers.d/` の中のファイルを直接編集せず、`sudo visudo -f` を使う。

## 実機で確かめる所（11/5、11/8 に追記）

OS の版や機器の個体で違いうるため、次はスクリプトの仮定で、実機で確かめる。

- **OS のセッション**: Wayland の labwc が既定か（40）。wayfire だった場合は `~/.config/wayfire.ini` に書く方式へ直す。
- **Chromium の実行名**: `chromium-browser` か `chromium`（40 は両方を探す）。
- **自動ログイン・ブランキングの `raspi-config nonint`**（`B4`、`do_blanking`）が版で同じ意味か（40）。10 分たっても画面が消えないことを目で見る。
- **Jabra のカード ID と USB の vid:pid**（30 は `/proc/asound/cards` と `lsusb` から拾う。Speak 510 は `0b0e:0420` のはずだが未確認）。
- **Jabra の対応形式**（30 は 16kHz・モノ・S16_LE を既定とし、`NDA_AUDIO_RATE` で変えられる。`/proc/asound/card*/stream0` の表示と照らす）。音程が正しいか、2m 離れた声が聞こえるか。
- **PipeWire との競合**: 既定を `/etc/asound.conf` で上書きしたとき、`arecord` が "busy" にならないか（30）。なる場合は `wpctl` で既定を設定する方式に切り替える。
- **カード順の固定**は再起動後に効く。再起動後に `cat /proc/asound/cards` で Jabra が 0 番か。
- **電源の 5A 認識**: Pi 5 で `get_config usb_max_current_enable` が 5A の認識を正しく映すか（20）。補助の `max_current`（5000 なら 5A）と起動時の警告も見る。
- **sudoers**: `/etc/sudoers.d/010_pi-nopasswd` という名前が実機で同じか、他に `NOPASSWD` が残っていないか（60 が一覧を出す）。
- **`sudo -l` の表示の形**: 60 と 90 は `sudo -n -l` の `NOPASSWD:` の後ろを `, ` で区切って固定の 4 命令と比べる。実機の表示（命令の並び、`reboot` のパス `/usr/sbin/reboot`）がこの形か。違えば 60 が `[失敗]` と出す（規則は入った後なので、表示を見て比べ方を直す）。
- **ログを sudo なしで読めるか**: 60 の後に SSH を入り直して `journalctl -u nda.service -n 5` が出るか（`systemd-journal` グループ）。`systemctl status nda.service` のログの行も出るか。
- **unattended-upgrades の対象**: `/etc/apt/apt.conf.d/50unattended-upgrades` の `Origins-Pattern` に Raspberry Pi のリポジトリ（`archive.raspberrypi.com`）が入っているか。Debian の security だけなら、カーネルやファームウェアの更新は手で行う（上の「OS の更新」）。`sudo unattended-upgrade --dry-run -d` で対象を見る。
- **`nda.service`**: 停電からの復帰（`sudo reboot` の 2 分後に `active`）。
- **systemd の保護と Next.js**: `ProtectSystem=strict` で `/opt/nda` が読み取り専用になる。`.next/cache` は 52 が `/var/lib/nda/next-cache` へ向ける。それでも `journalctl -u nda.service` に `EROFS` が出ないか。`SystemCallFilter=@system-service`・`PrivateDevices=yes`・`RestrictAddressFamilies=` で落ちないか。`systemd-analyze security nda.service` の点数も見る。
- **next build（52）**: 4GB で終わるか、何秒か。`corepack` が pnpm 10.10.0 を取れるか（`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`）。`@libsql` の linux-arm64-gnu の部品が入るか。
- **聞き役（55）**: `--list-devices` に Jabra の名前が出るか。Jabra を直に開いて、Chromium の声と取り合わないか（"Device unavailable"・"busy"）。取り合うなら `NDA_LISTENER_INPUT=pipewire NDA_LISTENER_OUTPUT=pipewire` で 55 を流し直す（PipeWire の既定は 40 のキオスクが Jabra にする）。16kHz で開けるか。工場の騒音で `NDA_WAKE_CONF`・`NDA_SILENCE_RMS`。requirements.txt の版（Mac の Python 3.14 で決めた）が Pi の Python（3.11 か 3.13）に wheel があるか。
- **声（57）**: 1 文の秒数（57 の最後、90 の #14）。初回の合成が遅いのは読み込みのため（ExecStartPost で先に読み込む）。`run` が展開した中のどこにあるか（57 は 3 階層まで探す）。`DynamicUser` で書き込み先が足りるか。ずんだもんの speaker id が 3 か（`curl 127.0.0.1:50021/speakers`）。
- **声の出口（40）**: キオスクの起動で `pactl set-default-sink` が Jabra になるか（`pactl get-default-sink`）。触らなくても声が鳴るか（自動再生のフラグ）。
- **受け箱（58）**: `<PC 名>.local` が引けるか。SMB 3.0 で入れるか。共有用のユーザーで `.tmp` を書いて名前を変えられるか。事務所の PC の再起動・スリープの後、次の書き込みで戻るか。`nda.service` の `ReadWritePaths=-/mnt/nda-office` と automount の組み合わせで、本体の起動が PC の停止中に待たされないか（待たされるなら、受け箱を `/var/lib/nda` の下に mount する形へ）。
- **関所**: 事務所の PC から `http://<Pi>:3001/api/office/reply` に届くか。`http://<Pi>:3000/` には届かないか。Node 24 が `scripts/office-gate.ts` を型の取り除きでそのまま動かすか（Mac の Node 24.22.1 では動いた）。`IPAddressAllow=` で事務所の PC の IP が範囲に入るか。
- **出来事の記録**: 一周の後に `/var/lib/nda/logs` に `events-<日付>.jsonl`（nda-app）と `listener-<日付>.jsonl`（nda）が出るか（90 の #16）。
- **SMB の暗号化**: `seal` で mount できるか（Windows 側の `EncryptData` と SMB 3.0 以上）。
- **`nda-app` の作成**: `useradd --system` で作ったユーザーが `sudo -l -U nda-app` で「許可なし」と出るか（60 の前に見る。90 の #9 は 60 の後はグループとシェルで判定する）。
- **ShellCheck**: Mac に無かったので未実施（11/8 も `bash -n` だけ）。入れられる環境で `shellcheck deploy/pi/*.sh` を流す。
