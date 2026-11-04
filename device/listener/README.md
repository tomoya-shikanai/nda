# 現場の聞き役（device/listener）

マイクを常時聞き、起動語「んだ クロード」を聞いたら合図音を鳴らして録音し、`POST /api/session/voice` へ送る。
サーバーは、最新の作業が質問中か承認待ちならその返事として、それ以外なら新しい作業として受ける（`lib/session/voice.ts` の `routeVoice`）。

- 起動語の検出はこの機械の中だけ（Vosk の日本語小型モデル、オフライン）。grammar `["んだ クロード","[unk]"]`、両語の conf ≥ 0.9。
- 録音は合図音の後から。声の後に無音が 1.5 秒続くか、最大 30 秒で止める。合図の後 5 秒たっても声が無ければ送らない。
- 録音はメモリの中で 16kHz モノラルの WAV にして送るだけで、ファイルに残さない。文字起こしはサーバーが STT（Scribe か Gemini）に渡す。
- 起動語の後は、合図音を待ってから話す（起動語と続けて話すと、Vosk が区切りを待つ間の声が録音に入らない）。
- 返事も承認（「請求書頼む」）も、毎回起動語から始める。

## Mac で一周させる

3 つの端末で順に起動する。

```sh
# 1. VOICEVOX ENGINE（ずんだもんの声、127.0.0.1:50021）
/Users/dev/tools/nda/voicevox-engine/run

# 2. nDa の本体（127.0.0.1:3000）。モニターは http://127.0.0.1:3000/monitor
pnpm dev

# 3. 聞き役（起動語待ちと出たら「んだ クロード」→ 合図音 → 話す）
/Users/dev/tools/nda/venv/bin/python device/listener/listen.py
```

- 初回は、端末のアプリにマイクの許可を求める画面が出る。許可しないと、macOS はエラーにせず無音を渡すので、起動語に一度も反応しない。
- ずんだもんの話速は既定 1.25 倍。変えるときは `pnpm dev` の前に `NDA_TTS_SPEED`（0.5〜2）を渡す。
- 入力デバイスの一覧: `listen.py --list-devices`。
- 無音の閾値（既定 RMS 500）が合わないとき: `--show-level` を付けて録音中の音量を見て、`--silence-rms` で変える。

## 設定

引数が優先。無ければ環境変数、それも無ければ既定。

| 引数 | 環境変数 | 既定 |
|---|---|---|
| `--server` | `NDA_SERVER_URL` | `http://127.0.0.1:3000` |
| `--device`（入力デバイス名の部分一致） | `NDA_INPUT_DEVICE` | システムの既定 |
| `--output-device`（合図音を鳴らすデバイス名の部分一致） | `NDA_OUTPUT_DEVICE` | システムの既定 |
| `--vendor` | `NDA_STT_VENDOR` | `scribe` |
| `--wake-conf` | `NDA_WAKE_CONF` | `0.9` |
| `--silence-rms` | `NDA_SILENCE_RMS` | `500` |
| `--silence-sec` / `--max-sec` | — | `1.5` / `30` |
| `--model` | `NDA_VOSK_MODEL` | `/Users/dev/tools/nda/vosk-model-dl/vosk-model-small-ja-0.22` |

名前に当たるデバイスが無ければ、既定に戻さず止まる。

## Pi と Jabra に移すとき変える所

1. 入力と合図音の出力を Jabra にする: `--device Jabra --output-device Jabra`（または `NDA_INPUT_DEVICE=Jabra`、`NDA_OUTPUT_DEVICE=Jabra`）。名前は `--list-devices` で確かめる。
2. Vosk のモデルの置き場: `--model`（または `NDA_VOSK_MODEL`）を Pi の置き場にする。
3. 依存: Pi では `sudo apt install libportaudio2` の後に、venv で `pip install -r device/listener/requirements.txt`。
4. 送り先: 本体が同じ Pi なら既定の `http://127.0.0.1:3000` のまま。
5. 閾値: 工場の騒音と父の声で `--wake-conf` と `--silence-rms` を確かめ直す（今の値は Mac の架空の読み上げで決めたもの）。

## 試験

音声を使わない部分（起動語の判定・録音の止め時・WAV と multipart・デバイスの選び方）は `listener_core.py` にあり、標準ライブラリだけで試せる。`pnpm check` でも流れる。

```sh
cd device/listener && python3 -m unittest discover -s tests
```
