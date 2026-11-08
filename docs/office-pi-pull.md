# 工場の Pi から事務所の PC へ、指示を取りに行く道（設定の手順）

2026-11-08 作成（#53・#56）。客の名前・ナンバー・PC と Pi の IP はこの文書に書かない。

## 形
- 事務所の PC（有線）と工場の Pi（Wi-Fi）は同じルーターにつながっている。
- 事務所の PC の見回り（`python -m box run --send ...`）が、`interval_s`（既定 3 秒）おきに Pi へ SSH でつなぎ、送り箱の指示を受け箱 `C:\nda\box\in` へ移す（`office/box/pull.py`）。
- 事務所の PC は外からの接続を受けない。共有フォルダ・ファイアウォール・ネットワークの種類は変えない。
- Pi の側では、事務所の PC の鍵で動くのは門番 `deploy/pi/nda-outbox-gate.sh` だけ。頼めるのは `list`・`get <uuid>.json`・`ack <uuid>.json` の 3 つ。シェル・転送はできない。
- 返し（入れた・止まった）は今のまま、事務所の PC から Pi の関所（3001 番、`POST /api/office/reply`）へ HTTP。
- 待ち: 承認から受け箱に置くまで 2〜4 秒（間隔の待ち＋SSH 1 回 0.3〜1 秒×3）。

## 工場の Pi で（工場側の Claude か鹿内さん）
1. 本体（nda-app）が書く送り箱を作る: `/var/lib/nda/outbox`（`nda-app:nda`、2770）。目印 `.nda-box` を置く。
   受け取った分は、門番が同じフォルダの中で `.sent-<id>.json` に名前を変える（7 日で消える）。
2. 本体の設定: `NDA_OFFICE_BOX=/var/lib/nda/outbox`、`NDA_OFFICE_BOX_REQUIRE_MOUNT=0`（mount しない）。
   ファイルは `.<名前>.<乱数>.tmp` に書いて `<id>.json` へ rename する（今の `lib/office/link.ts` のまま）。
   **ファイルの mode を 0640 にする**（今は 0600。取り出し用のユーザーが nda グループで読むため）。
3. 取り出し用のユーザーを作る（例 `nda-pull`）。パスワードなし、`nda` グループ、シェルは `/bin/bash`（command= を動かすのに要る）、sudo なし。
4. 門番を置く: `sudo install -o root -g root -m 755 deploy/pi/nda-outbox-gate.sh /usr/local/bin/nda-outbox-gate`
5. 事務所の PC の公開鍵（下の手順で作る `pi-key.pub`）を、`~nda-pull/.ssh/authorized_keys` に次の 1 行で登録する（`.ssh` は 700、ファイルは 600、持ち主は nda-pull）:
   ```
   command="/usr/local/bin/nda-outbox-gate /var/lib/nda/outbox",restrict ssh-ed25519 AAAA... nda-office
   ```
6. `58-office-share.sh`（SMB の mount）は流さない。

## 事務所の PC で（Claude が用意済みのものと、鹿内さんがそばにいるときにやること）
1. 鍵を作る（Claude）: `C:\Users\PRS\nda-private\pi-key`（秘密鍵、Git に入れない）と `pi-key.pub`（公開鍵、Pi に渡す）。
2. Pi の鍵の控えを作る（Claude）: `ssh-keyscan` で Pi のホスト鍵を取り、`nda-pi` の名前で `C:\Users\PRS\nda-private\pi-known_hosts` に置く。
   指紋は、Pi の画面で `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` を打って出る値と、鹿内さんが見比べる（なりすましを防ぐ）。
3. `C:\nda\box\config.json` に足す:
   ```json
   "pi_pull": {"host": "<Pi の名前>.local", "user": "nda-pull",
               "key_file": "C:\\Users\\PRS\\nda-private\\pi-key",
               "known_hosts": "C:\\Users\\PRS\\nda-private\\pi-known_hosts", "interval_s": 3}
   ```
   返しも使うなら `"pi_url": "http://<Pi の名前>.local:3001/api/office/reply"` と `"secret"`（Pi の `NDA_OFFICE_TOKEN` と同じ）。
4. 確かめる: office フォルダで `python -m box pi`。「つながった。届いている指示: N 件（取っていない）」と出れば通る（取らない・印も付けない）。
5. 見回りを起動すると、取りに行き始める（`python -m box run --send --auto`）。`--send` の無いドライランでは取りに行かない。

## 止まったとき
- 「工場の Pi に届かない」: Pi が起きているか、同じルーターか、`<名前>.local` が引けるか（`ping <名前>.local`）。見回りは止めずに試し続ける。
- 「取らない（中の id がファイル名と違う・JSON でない・大きすぎる）」: Pi の送り箱のそのファイルを工場側で確かめる。取らずに残す。
- 2 回届いても、受け箱が同じ id を 1 回しか入れない（`done\<id>.json` と `done\<id>.pulled` で見分ける）。
