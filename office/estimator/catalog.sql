-- 項目の目録（読むだけ）。客の情報（顧客・車・伝票番号）は出さない。@since は YYYYMMDD の int。
-- 1) 項目CD ごとの使われ方（項目CD 0 を除く）。直近の値は、金額の入った行のうち最も新しいもの
WITH R AS (
  SELECT SYAJNL_DENNO dn, SYAJNL_KOUCD code, SYAJNL_NM nm, SYAJNL_SAGKBN sag, SYAJNL_B_SU su, SYAJNL_B_TAN tan,
         SYAJNL_B_KIN bkin, SYAJNL_S_KIN skin,
         ROW_NUMBER() OVER (PARTITION BY SYAJNL_KOUCD ORDER BY CASE WHEN SYAJNL_B_KIN + SYAJNL_S_KIN > 0 THEN 0 ELSE 1 END, SYAJNL_DENNO DESC, SYAJNL_DENSEQ DESC) rn
  FROM SYAJNL_DAT WHERE SYAJNL_DEL = 0 AND SYAJNL_YMD >= @since AND SYAJNL_KOUCD <> 0
)
SELECT code, COUNT(*) n,
       SUM(CASE WHEN skin <> 0 AND bkin = 0 THEN 1 ELSE 0 END) n_labor,
       SUM(CASE WHEN bkin <> 0 THEN 1 ELSE 0 END) n_part,
       MAX(CASE WHEN rn = 1 THEN su END) last_su, MAX(CASE WHEN rn = 1 THEN tan END) last_tan,
       MAX(CASE WHEN rn = 1 THEN skin END) last_skin, MAX(CASE WHEN rn = 1 THEN bkin END) last_bkin,
       MAX(CASE WHEN rn = 1 THEN sag END) last_sag
FROM R GROUP BY code;
-- 2) （空）明細の名前の履歴は集めない。自由に書ける欄で、客の名前が入りうる（Codex の指摘）。表の数を保つための空の表
SELECT TOP 0 0 AS code, N'' AS nm, 0 AS c;
-- 3) マスタ（削除されていないもの）
SELECT KOUM_CODE code, RTRIM(KOUM_NM) nm, KOUM_KBN1 kbn1, KOUM_URI_TAN uri_tan
FROM KOUM_DAT WHERE KOUM_DEL = 0 AND KOUM_SEQ = 0;
-- 4) 項目CD 0（自由入力）の名前ごとの使われ方。決まった形の名前（廃ﾀｲﾔ･<数>ｲﾝﾁ）だけ。自由に書いた名前は集めない（Codex の指摘）
WITH F AS (
  SELECT RTRIM(d.SYAJNL_NM) nm, h.TJNL_KOKCD kok, d.SYAJNL_SAGKBN sag, d.SYAJNL_B_SU su, d.SYAJNL_B_TAN tan,
         d.SYAJNL_B_KIN bkin, d.SYAJNL_S_KIN skin,
         ROW_NUMBER() OVER (PARTITION BY RTRIM(d.SYAJNL_NM) ORDER BY CASE WHEN d.SYAJNL_B_KIN + d.SYAJNL_S_KIN > 0 THEN 0 ELSE 1 END, d.SYAJNL_DENNO DESC, d.SYAJNL_DENSEQ DESC) rn
  FROM SYAJNL_DAT d JOIN TJNL_DAT h ON h.TJNL_DENNO = d.SYAJNL_DENNO
  WHERE d.SYAJNL_DEL = 0 AND d.SYAJNL_YMD >= @since AND d.SYAJNL_KOUCD = 0
    AND (RTRIM(d.SYAJNL_NM) LIKE N'廃ﾀｲﾔ･[0-9][0-9]ｲﾝﾁ' OR RTRIM(d.SYAJNL_NM) LIKE N'廃ﾀｲﾔ･[０-９][０-９]ｲﾝﾁ'
      OR RTRIM(d.SYAJNL_NM) LIKE N'廃タイヤ･[0-9][0-9]インチ' OR RTRIM(d.SYAJNL_NM) LIKE N'廃タイヤ･[０-９][０-９]インチ')
)
SELECT nm, COUNT(*) n, MAX(CASE WHEN rn = 1 THEN sag END) last_sag,
       MAX(CASE WHEN rn = 1 THEN su END) last_su, MAX(CASE WHEN rn = 1 THEN tan END) last_tan,
       MAX(CASE WHEN rn = 1 THEN skin END) last_skin, MAX(CASE WHEN rn = 1 THEN bkin END) last_bkin
FROM F GROUP BY nm HAVING COUNT(DISTINCT kok) >= 5;
-- 5) 一緒に使われる項目（同じ伝票に出る組。上位）
WITH P AS (
  SELECT DISTINCT SYAJNL_DENNO dn, SYAJNL_KOUCD code FROM SYAJNL_DAT
  WHERE SYAJNL_DEL = 0 AND SYAJNL_YMD >= @since AND SYAJNL_KOUCD <> 0
)
SELECT TOP 2000 a.code a, b.code b, COUNT(*) n
FROM P a JOIN P b ON a.dn = b.dn AND a.code < b.code
GROUP BY a.code, b.code HAVING COUNT(*) >= 3 ORDER BY n DESC;
