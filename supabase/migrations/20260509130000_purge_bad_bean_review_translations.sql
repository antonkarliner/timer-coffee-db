-- One-time cleanup: purge translations produced by the initial
-- translate-bean-review prompt that did not specify the target language
-- explicitly, causing the model to translate into an arbitrary language
-- (observed in TestFlight: pl→en, en→zh when the user expected pl→ru, en→ru).
-- The fixed prompt is in supabase/functions/translate-bean-review/index.ts.
-- After this purge, the next reader request for any (review, locale) pair will
-- repopulate the cache with a correct translation under the new prompt.
delete from public.bean_review_translations;

-- Also clear detected_source_locale so a stale "same language" short-circuit
-- can't suppress a translation that should now be produced.
update public.bean_reviews set detected_source_locale = null;
