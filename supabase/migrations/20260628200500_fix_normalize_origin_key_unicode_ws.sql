-- Fix key-parity bug in normalize_origin_key. The edge function / backfill writes
-- cache keys using JavaScript's `\s` (which collapses Unicode whitespace such as
-- the ideographic full-width space U+3000, common in Japanese-entered origins like
-- "ブラジル　コロンビア"), but Postgres `\s` and `[[:space:]]` do NOT match U+3000.
-- So such origins normalized to a different key in SQL than in TS and never matched
-- their own cache row — the cron re-processed them forever and they were dropped
-- from facets.
--
-- Translate the Unicode-whitespace characters in JS's `\s` set to ASCII spaces
-- before collapsing, so SQL keys match the keys the function already wrote.

create or replace function public.normalize_origin_key(p_origin text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select lower(btrim(regexp_replace(
    translate(
      coalesce(p_origin, ''),
      -- U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF
      chr(160)  || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) ||
      chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) ||
      chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) ||
      chr(65279),
      repeat(' ', 19)
    ),
    '\s+', ' ', 'g'
  )));
$$;
