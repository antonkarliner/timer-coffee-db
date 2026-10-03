-- Start initial refreshes through the exact Vault/pg_net path used by cron.
-- Deploy both collector functions before applying this migration. Apple runs
-- remain resumable: a later cron batch completes any unfinished storefronts.
select service.dispatch_store_ratings('app_store');
select service.dispatch_store_ratings('google_play');
