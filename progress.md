# progress

数字は「知識／センス／判断」の 3 区分で持つ。捨てたものも書く。

## 2026-11-02（日）
- 12:00 キックオフ。審査員は実際にアプリを触る。審査基準の詳細を確認（インパクト 30／デモ 25／Claude 25／深さ 20）。
- 工場は休みで客が来なかった。実録音はゼロ。優勝仮説の検証（3 腕比較＋息子の未使用例）は 11/3 に移す。
- 17:30 リポジトリ作成。README 骨格、事前登録の書式、匿名化ルール。コードはまだ無い。
- 決定: 「確かめたこと」は順序つきにし、息子の問いの第一形を「客がこう言っている。父ならどこから確かめる？」にする。
- 捨てた: センサーや音で不調箇所を予測する案（根拠データが作れない、汎用解析ツールに見える）。

| 区分 | 数字 |
|---|---|
| 知識 | 承認カルテ 0 |
| センス | 原音つき観察 0 |
| 判断 | 3 腕比較 未実施 |

- STT の候補を Scribe v2／AmiVoice／Gemini 3.5 Transcribe に絞った。基準線は kotoba-whisper。津軽弁の第三者比較は見つからず、父の実録音で決める。音響モデルの自作は捨てた（学習データが無い）。

- 2026-11-04 夜間ループのハーネスを固めた。OS sandbox（ネットワーク無し、ホーム直下と他案件の読み取り禁止）、起動前の拒否点検 19 項目（sandbox を切ると 6 項目が不合格になることも確認）、事前登録ガード（--arm all は未コミットなら止まる、カルテにコミット ID を刻む）、朝の検収 skill。偽 claude の失敗系 9 種と本物の Haiku 1 タスク（43 秒、$0.005）が期待どおり。Web フォントの取得は捨てた（回線なしでビルドするため）。製品の開発は戦略会議の後。

- 2026-11-04 文字起こしを架空の読み上げ 10 本（Kyoko、計 94 秒）で 8 通り比べた（scripts/stt-compare.ts）。整備の言葉は Scribe v2 23/23・CER 3.7%・1.25 秒、gemini-3.5-transcribe 6 本で 13/13・CER 0.7%・3.5 秒（Interactions API で呼ぶと本文が出る。無料枠 25 回/日で途中まで）、turbo 21/23、kotoba 18/23。kotoba に initial_prompt で用語を渡すのは崩れるので捨てた。say は「組替」を「くみたい」と読むので読み上げ用の文を分けた。方言は say では測れない。
- 2026-11-04 夜間 N1: タイヤ交換の声から請求の明細を作る `lib/invoice/`（schema・extract・verify）を追加。verifyInvoice は出所を verifyDraft と同じ規則で照合し、単価は引用に「数字＋円」が無ければ不合格。試験 11 件（架空 3 録音、偽サーバー）全て合格。料金表の値を単価に写す経路は作らなかった（推測で埋めないため。台帳照合は別タスク）。画面は無し。
- 2026-11-04 夜間 N2: 明細を料金表で照らす `lib/invoice/price.ts`（priceInvoice）を追加。台帳は lookup の完全一致だけ、found:false は推測で埋めず確認事項にし、発話と料金表の単価が違えば単価を null にする。確認事項が 1 件でもあれば合計は null。試験 6 件（tire-002 合計 13640、tire-003 ホイールナットは found:false で合計 null、数量 null、単価食い違い、料金表外で発話に単価あり、入力不変）全て合格。別名の推測・あいまい一致は足さなかった。画面は無し。
- 2026-11-04 夜間 N1・N2 の敵対レビュー（Codex）の指摘 9 件を night-fix/20261104 で直した。verifyInvoice は料金表（省略可）を受け、品目（正式名か別名）・数量（数＋単位、明細と同じ単位）・単価（1 単位あたりの形、数字の境界と小数点を見る）を引用と、引用を作った 1 つの発話の中で照らす。引用の幅は 20 秒まで、話者は引用を作った発話と一致。priceInvoice は単位の食い違いと同じ品目の 2 行を確認事項にし、lookup は正式名を優先してあいまいなら found:false。通しの buildInvoice は不合格の行を確認事項（line）にして合計を出さない。試験 34→60 件、全て合格。料金表の別名の追加は不要だった。抽出の指示文は変えていない。
- 2026-11-04 明細の検証の作り直し案（#32）が採用になった。今夜の夜間に V1（候補の列挙）と V3（参照を値に戻す）を積んだ。言い直しは必ず聞き返すことにし、V6 は捨てた。前の夜の worktree（../nda-night）とマージ済みの night/20261104 を片付けた（同じ日付で古いブランチに切り替わり、新しいタスクを拾わないため）。
- 2026-11-04 夜間 V1: 発話から候補を列挙する `lib/invoice/candidates.ts`（enumerateCandidates・normalizeText、純粋な関数）を追加。qty・unitPrice・total・amount・unparsedYen・item の 6 種に kind ごとの連番 ID を振る。漢数字は 1 字読みと位取りを読み、位取りの崩れ（二二十）は漢字のまま残して unparsedYen にする。試験 10 件（tire-002 と架空の録音）全て合格。verify.ts からの import はせず写した。否定・言い直しの判定は V3 に回した。画面は無し。
- 2026-11-04 夜間 V3: モデルの参照（`LineRef`、schema.ts に zod で追加）を発話の値に戻す `lib/invoice/resolve.ts`（resolveInvoice、純粋な関数）を追加。条件 1〜8・15 と「参照が不正」を確認事項にし、使われない qty・unitPrice・amount を unused に返す。試験 32 件（tire-001・002 は確認事項 0 件・unused 空、敵対レビューの指摘 1〜9 の移植を含む）全て合格。既存の verify・extract・build と既存試験は変えていない。残った穴: 料金表に無い品目で数量の単位（本）と単価の単位（1セット）が違っても、V3 の条件にも priceInvoice にも当たらない（指摘 2 の「1セット1000円」は料金表に有る品目で移植し、単価の食い違いで止まることを確かめた）。足すかは仕様の判断なので入れなかった。画面は無し。
- 2026-11-04 Codex の 2 回目のレビューで、語彙に無い否定と発話をまたぐ訂正が確認事項にならない欠陥 2 件を確定。否定は語彙で閉じないので、モデルに行の status と否定の文を返させる役割分担に決め、設計書（条件 17〜19）と backlog の V2・V4 を書き直した。語彙を広げる案は捨てた。コードは変えていない。
- 2026-11-04 事務所の PC に Tailscale・OpenSSH Server（鍵認証だけ・Tailscale の範囲だけ）・Claude Code を入れる手順を #39 に起票した。Chrome リモートデスクトップは、Claude が操作する Chrome が別のアカウントのため事務所の PC が見えず、入れなかった。Mac に事務所の PC 専用の鍵 ~/.ssh/id_nda_office を作った。
- 2026-11-04 夜間 V2: `extract.ts` を書き直し、extractInvoice(t, ledger) が候補（enumerateCandidates）と、候補 ID を指す参照（行の status・evidence・correctedFrom/To）と否定の文（negations）を返すようにした。スキーマは refSchema(candidates) でリクエストごとに候補 ID の z.enum から作る。resolveInvoice に negations を足し、条件 17（status が done 以外）・18（否定の文に入る候補・品目の語を使った行、文が発話に無い）・19（訂正の合図の発話の数と、20 秒以内の同じ単位の数量を別の行が使う）を確認事項にした。分かったこと: SDK の transformJSONSchema は enum を description に移すので API 側では強制されず、候補に無い ID は parse の段の zod で落ちて throw する。試験は tests/invoice-extract.test.ts に 15 件（偽サーバー）を足し、invoice.test.ts の古い「抽出:」4 件を消した。build・verify・price は変えていない（通しの順の変更は V4）。画面は無し。
- 2026-11-04 夜間 V4: `lib/invoice/check.ts`（checkAmounts、純粋な関数）を追加し、条件 13（数量 × 照合後の単価 ≠ 言った金額、impliedQty の食い違い）と条件 14（言った合計 ≠ 計算した合計。他の確認事項があれば照らさない。税込みは必ず「照らせない」）を確認事項にした。`price.ts` は別名があいまいな品目（lookup.ts に isAmbiguous を足した。findEntry・lookup は不変）を、発話の単価があっても使わず「別名があいまい」（field item）にする。料金表に無い品目の発話の単価は今のまま（#33）。`build.ts` を assembleInvoice（resolve → price → check、確認事項の行は amount null）と buildInvoice（extract → assemble）に書き直した。旧 `verify.ts` と、それだけを試す tests/invoice-build.test.ts・tests/invoice.test.ts を削除（指摘 1〜9 は invoice-resolve.test.ts に移植済みを確認）。invoice-resolve の指摘 7 は確認事項を「別名があいまい」に合わせた。試験は tests/invoice-assemble.test.ts に 12 件（偽サーバー含む）全て合格。画面は無し。
