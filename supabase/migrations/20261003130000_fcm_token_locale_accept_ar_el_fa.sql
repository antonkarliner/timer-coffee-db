-- Plan 042: accept ar, el and fa in service.user_fcm_tokens.valid_locale.
-- All three are in public.supported_locales and selectable in the app, but the
-- CHECK rejected them, so the app's 23514/valid_locale fallback stored those
-- users' tokens as 'en' and language-targeted sends to them reached nobody.
--
-- Stays a CHECK named valid_locale (not an FK to supported_locales): installed
-- app builds match on SQLSTATE 23514 and this constraint name to fall back to
-- 'en'; an FK violation (23503) would make the whole token write fail instead.
--
-- The list below is every distinct code in the live definition as of
-- 2026-10-03 (read with pg_get_constraintdef, duplicates removed), plus the
-- three new codes. When a language ships, add its code here as well as to
-- public.supported_locales (see CLAUDE.md).
begin;

alter table service.user_fcm_tokens drop constraint valid_locale;

alter table service.user_fcm_tokens add constraint valid_locale check (
  locale is null or locale = any (array[
    'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'sv', 'da', 'no', 'fi', 'pl',
    'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sl', 'et', 'lv', 'lt', 'mt', 'ga',
    'cy', 'eu', 'ca', 'gl', 'is', 'mk', 'sq', 'sr', 'bs', 'me', 'tr', 'ru',
    'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'mn', 'ko', 'ja', 'zh', 'th', 'vi',
    'ms', 'id', 'tl', 'hi', 'bn', 'ta', 'te', 'ml', 'kn', 'gu', 'mr', 'ne',
    'si', 'my', 'km', 'lo', 'ka', 'am', 'sw', 'zu', 'af', 'gd',
    -- plan 042
    'ar', 'el', 'fa'
  ]::text[])
);

commit;
