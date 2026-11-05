# 構成（アーキテクチャ）

2026-11-05 時点。工場は Pi 5 だけ（nDa の本体も Pi で動かす。`docs/decisions.md` 2026-11-04）。事務所は今ある Windows の PC。
考え方は「**判断はモデル、作業はプログラム**」。Claude（モデル）を使うのは、明細の下書きと聞き返しだけ。データを運ぶ・照らす・業務ソフトに打ち込む・保存の後に照らすのは、決まった手順のプログラムで行う。

## 全体の図

```mermaid
flowchart LR
  subgraph factory["工場"]
    father(["父（整備士）"])
    subgraph pi["Raspberry Pi 5 ＋ Jabra Speak 510 ＋ モニター"]
      wake["起動語の検出<br/>（Vosk）"]
      rec["録音"]
      app["nDa の本体（Next.js）<br/>明細の下書き → 料金表で照合 → 確認事項"]
      ledger[("料金表<br/>lib/ledger")]
      state[("作業の状態<br/>libSQL")]
      monitor["相棒の画面<br/>app/monitor"]
      tts["声の返事<br/>（VOICEVOX）"]
      reader["車検証の読み取り<br/>QR・IC（#49、未）"]
    end
  end

  subgraph cloud["外部の API"]
    stt["文字起こし<br/>（ベンダーは #31 で決める）"]
    claude["Claude API<br/>Opus 5.5（分離・一問）<br/>Haiku 5.5（補助）"]
  end

  subgraph office["事務所"]
    human(["人<br/>（保存・印保存・発行を押す）"])
    subgraph pc["Windows の PC"]
      inbox[/"受け箱のフォルダ<br/>受付 1 件 = 1 ファイル（#25・#49）"/]
      watcher["受け箱の見張り<br/>（未）"]
      check["既にある車かの照合<br/>保存の後の照合<br/>（SELECT のみ）"]
      input["業務ソフトへの入力<br/>保存の手前で止まる（#26、未）"]
      racros["RacroS III<br/>（業務ソフト）"]
      db[("RacroS の DB<br/>SQL Server")]
      recorder["操作の記録<br/>office/recorder（済）"]
      trends["タイヤの傾向の台帳<br/>（済、毎晩は未）"]
    end
  end

  father -- "「んだ、Claude」" --> wake --> rec
  rec -- "音声" --> stt -- "文字" --> app
  app -- "発話" --> claude
  claude -- "明細の候補・聞き返し" --> app
  app --- ledger
  app --- state
  app --> monitor
  app --> tts --> father
  father -- "答え・「請求書頼む」" --> app
  reader --> app
  app -- "承認した明細・車検証の値（Claude を通さない）" --> inbox
  inbox --> watcher --> check
  check -- "読むだけ" --> db
  watcher --> input --> racros
  racros --> db
  human -- "画面を見て保存" --> racros
  recorder -. "画面の操作を記録（値は伏せる）" .-> racros
  trends -. "読むだけ" .-> db
```

- 実線はデータの流れ、点線は読むだけ・記録するだけ。
- 「済」は動いているもの、「未」はこれから作るもの。印の無いものは、架空の素材で一周した段階（`progress.md`）。

## 決まりごと

| 所 | 決まり | 出所 |
|---|---|---|
| Pi → 事務所 | Claude（モデル）を通さない。受け箱のフォルダに置く（同じ LAN なら共有フォルダ、Tailscale なら SSH）。書きかけを拾わないよう、一時の名前で書いてから名前を変える | `docs/decisions.md` 2026-11-05、#49 |
| 車検証の値 | 1 文字も変えずに運ぶ（IC のファイルは署名がある）。API に送らない | #49 |
| 業務ソフトへの入力 | 保存・印保存・印刷・発行は人が押す。整備の間に保存を押す人はいない前提で、入力は承認の後に保存の手前まで。画面を何時間も開いたままにしない | `docs/decisions.md` 2026-11-05 |
| 照合 | 明細の表は画面から読めないので、保存の後に DB を読むだけの SQL で照らす | `docs/racros-screens.md` |
| DB | 読むだけのログイン（`claude_reader`）で SELECT だけ。業務ソフトのフォルダには書かない | #41 |
| 料金 | 料金表に無い値は推測で埋めず、確認事項にする | README「安心の設計」 |

## 開発のつなぎ方

```mermaid
flowchart LR
  mac["Mac<br/>Claude Code"] -- "SSH（Tailscale）" --> pi2["工場の Pi 5<br/>deploy/pi のスクリプトで設定"]
  mac -- "SSH（Tailscale、#39）" --> pc2["事務所の PC<br/>Claude Code も動く"]
  mac --> gh["GitHub<br/>（公開リポジトリ）"]
  pc2 --> gh
  gh --> hosted["審査員向けの hosted 版<br/>架空の素材だけ"]
```

- Pi に Claude Code は入れない。Pi で動くのは決まったプログラムで、設定は Mac から SSH で行う。
- 事務所の PC の Claude Code は、業務ソフトの解析と記録のプログラムの開発に使う（#41・#48）。客の情報は PC の外に出さない。
