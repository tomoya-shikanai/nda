# deploy/pi: 工場の Raspberry Pi 5 の設定スクリプト

方針と背景は `docs/pi-setup.md`（§6 が P3 の設定、§7 が確かめ方）。ここはその手順をスクリプトにしたもの。
Pi には手で変更を入れず、必ずここのスクリプトを流す（SD が壊れても同じ状態に戻すため）。

**2026-11-04 時点で、どのスクリプトも実機で動かしていない**（Pi は 11/5 着）。初回は 1 本ずつ流して結果を見る。

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
| 4 | `40-display.sh` | `~/.local/bin/nda-kiosk.sh`（本体が上がるのを待って Chromium を全画面で `http://localhost:3000/monitor` に開く）、`~/.config/labwc/autostart`、デスクトップ自動ログイン、画面ブランキング無効 | #5 |
| 5 | `50-service.sh` | 本体専用のユーザー `nda-app` を作り、置き場（下の表）を用意し、`/etc/systemd/system/nda.service`（`User=nda-app`、`Restart=always`、`EnvironmentFile=-/etc/nda/nda.env`、ExecStart は仮の `<NODE_BIN_DIR>/pnpm start`、systemd の保護つき）を enable。`package.json` が無い間は start しない | #7, #8, #9, #10 |
| 6 | `60-sudo-tighten.sh` | `nda` のパスワードなしの sudo を、引数まで固定した 4 命令（`systemctl start/stop/restart nda.service`、`reboot`）だけにする。`nda` を `systemd-journal` に入れ、ログは sudo なしで読む。**最後に流す** | #11 |
| 7 | `90-verify.sh` | §7 の 11 項目のうち Pi 上で自動で見られるものを表にする（合格／不合格／手動） | 全項目 |

各段で終わりの確認をしてから次へ進む。20 が不合格なら、電源を替えてから先へ進む。
40・50 を流した後、画面の確認と `nda.service` の確認のために再起動する（鹿内さんに伝えてから）。
Node と pnpm の導入、本体（`/opt/nda`）の配置、Tailscale は、このスクリプト群の範囲外（Tailscale は docs §5）。

## ユーザーと置き場

管理と本体の実行を別のユーザーに分ける。本体の不具合が管理者の権限につながらないようにするため。

| ユーザー | 何に使うか | sudo | ログイン |
|---|---|---|---|
| `nda` | 管理用。Claude が SSH で入り、スクリプトを流し、本体を配置する | パスワード付きは全部（`%sudo`）。パスワードなしは固定の 4 命令だけ（60 の後） | SSH（鍵）とデスクトップ（キオスク） |
| `nda-app` | 本体（`nda.service`）を動かすだけ。`useradd --system` | なし | できない（シェルは `nologin`） |

| 置き場 | 所有者・権限 | 中身 |
|---|---|---|
| `/opt/nda` | `nda:nda` 755 | 本体のコード。`nda` が配置し、`nda-app` は読むだけ（`ProtectSystem=strict` で読み取り専用になる） |
| `/var/lib/nda` | `nda-app:nda-app` 750 | データ（libSQL のファイル、録音、客の情報）。`nda-app` のホームも兼ねる。`nda.service` が書けるのはここだけ（`ReadWritePaths=`） |
| `/etc/nda/nda.env` | `nda-app:nda-app` 600 | 秘密の値。systemd が `EnvironmentFile` として読む。鹿内さんが書く（下） |

`.env` の書き方（P4、鹿内さんが Pi の上でパスワード付きの sudo で行う。Claude は中身を見ない）:

```bash
sudo nano /etc/nda/nda.env
sudo chown nda-app:nda-app /etc/nda/nda.env && sudo chmod 600 /etc/nda/nda.env
sudo systemctl restart nda.service
```

本体の更新は、`nda` が `/opt/nda` に置いてから `sudo systemctl restart nda.service`（パスワードなしで通る）。
状態とログは sudo なしで `systemctl status nda.service`、`journalctl -u nda.service -n 100`。

Node と pnpm の場所は `50-service.sh` の `NODE_BIN_DIR`（既定 `/usr/local/bin`）の 1 か所で決める。入れ方（apt の nodesource か公式の tar か）は実機で決め、`/usr/local/bin` 以外なら `ssh nda-pi 'NDA_NODE_BIN_DIR=/usr/bin bash -s' < deploy/pi/50-service.sh` のように渡す。`nda-app` から読める場所（`/home` の下は不可）に入れる。

### OS の更新

60 の後は、`apt`・`apt-get` をパスワードなしの sudo で使えない（apt のフックで root を取れるため外した）。
- 普段は `unattended-upgrades`（10 で有効にする）が毎日、更新を入れる。自動の再起動はしない。`/var/run/reboot-required` があれば、鹿内さんに伝えてから `sudo reboot`。
- 手で更新するときは、パスワード付きの sudo（Pi のターミナルか `ssh -t nda-pi`）で `sudo apt update && sudo apt full-upgrade`。

### 60 を流した後に他のスクリプトを流し直すとき

60 の後は `sudo` が固定の 4 命令以外ではパスワードを要求する。10・30・40・50 の流し直しは、次の「戻し方」で一時的に緩めてから行い、終わったら 60 を流し直す。

## 戻し方

どれも Pi の上（SSH かモニター）で行う。`*.nda-orig` はスクリプトが初めて上書きするときに残した元のファイル。

| スクリプト | 戻し方 |
|---|---|
| 10 | locale は `sudo nano /etc/locale.gen` で行を戻して `sudo locale-gen`。`apt` の更新は戻さない（戻す必要が出たら SD を書き直す） |
| 20 | 変更なし |
| 30 | `sudo rm /etc/modprobe.d/nda-audio.conf`、`/etc/asound.conf` は `.nda-orig` があれば戻し、無ければ `sudo rm`。再起動で反映 |
| 40 | `rm ~/.local/bin/nda-kiosk.sh`、`~/.config/labwc/autostart` は `.nda-orig` があれば戻し、無ければ消す。ブランキングは `sudo raspi-config nonint do_blanking 0`。再起動で反映 |
| 50 | `sudo systemctl disable --now nda.service && sudo rm /etc/systemd/system/nda.service && sudo systemctl daemon-reload`。`nda-app` を消すなら `sudo userdel nda-app`。`/opt/nda`・`/var/lib/nda`・`/etc/nda/nda.env` は触らない（データと秘密の値を消さない） |
| 60 | 下を参照 |

### 60 の戻し方（sudo を緩める）

絞った後は `nda` のパスワード付きの `sudo`（`%sudo` グループ経由）で戻せる。Pi のターミナルか、`ssh -t nda-pi` で行う。

```bash
sudo mv /etc/sudoers.d/010_pi-nopasswd.nda-disabled /etc/sudoers.d/010_pi-nopasswd   # 全許可に戻す
sudo rm /etc/sudoers.d/020_nda-tight                                                   # 絞りの規則を消す（任意）
sudo gpasswd -d nda systemd-journal                                                    # ログのグループから外す（任意）
```

締め出された場合（パスワードも通らない）は、SD を Mac に挿して `etc/sudoers.d/` を直す。なお `/etc/sudoers.d/` の中のファイルを直接編集せず、`sudo visudo -f` を使う。

## 実機で確かめる所（11/5）

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
- **`nda.service`**: Node と pnpm の入れ方と場所（`NODE_BIN_DIR`）。pnpm が `#!/usr/bin/env node` の形でも単体の実行ファイルでも、`Environment=PATH=` で node が見つかるか。停電からの復帰（`sudo reboot` の 2 分後に `active`）。
- **systemd の保護と Next.js**: `ProtectSystem=strict` で `/opt/nda` が読み取り専用になる。`next start` が `.next/cache`（画像の最適化・ISR）に書こうとして失敗しないか（`journalctl -u nda.service` に `EROFS` が出ないか）。出るなら、キャッシュの置き場を `/var/lib/nda` の下に向けるか、`ReadWritePaths=` に `/opt/nda/.next/cache` を足すかを決める。`SystemCallFilter=@system-service`・`PrivateDevices=yes`・`RestrictAddressFamilies=` で落ちないか。`systemd-analyze security nda.service` の点数も見る。
- **データの置き場の向け先**: 本体の libSQL のファイルと録音の置き場を `/var/lib/nda` の下に向ける（本体側の設定。`/etc/nda/nda.env` か unit の `Environment=` で渡す。まだ決まっていない）。
- **`nda-app` の作成**: `useradd --system` で作ったユーザーが `sudo -l -U nda-app` で「許可なし」と出るか（60 の前に見る。90 の #9 は 60 の後はグループとシェルで判定する）。
- **ShellCheck**: Mac に無かったので未実施。入れられる環境で `shellcheck deploy/pi/*.sh` を流す。
