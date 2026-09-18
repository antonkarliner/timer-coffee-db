-- Randomized connection pre-warm experiment for the Jev roaster-link shadow
-- evaluation (plan 034). The Jev HTTP call costs ~654-667 ms from the
-- Supabase edge but ~246 ms over a warm connection, so each parse-coffee-label
-- request now draws an experiment arm at the START of the request: "warm"
-- opens a keep-alive connection to api.typesafe.ai with a keyless GET to the
-- origin (never billed), "cold" does nothing. Shadow mode draws 50/50;
-- enforce is always warm. Nothing user-visible changes.
--
-- Analysis: compare jev_call_ms (wall-clock of the Jev call alone) by
-- prewarm_arm — warm should show the handshake already paid. prewarm_ms is
-- the pre-warm's own latency, bounded at insert time; NULL when cold,
-- unresolved or failed.
--
-- No new grants: added columns inherit the table's existing privileges.
alter table service.jev_eval_roaster_link
  add column if not exists prewarm_arm text check (prewarm_arm in ('warm','cold')),
  add column if not exists prewarm_ms  integer,
  add column if not exists jev_call_ms integer;
