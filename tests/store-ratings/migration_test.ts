// A disposable PostgreSQL WASM instance tests real SQL/RLS without contacting
// production. Cron/pg_net/Vault are stubbed; their integration needs deployment.
// deno-lint-ignore no-import-prefix -- Pinned test-only PostgreSQL dependency.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
Deno.test("ratings migration: leases, atomic weighted publication, RLS, and last valid snapshots", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema service; grant usage on schema service to service_role;
      create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
      create schema net;
      create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
        returns bigint language sql as 'select 1::bigint';
      create schema cron; create table cron.job(jobname text primary key, schedule text, command text);
      create function cron.schedule(jobname text, schedule text, command text) returns bigint language sql as
        'insert into cron.job values ($1,$2,$3); select 1::bigint';
    `);
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../../supabase/migrations/20260930134755_app_store_ratings_pipeline.sql",
          import.meta.url,
        ),
      ),
    );
    const date = (await db.query<{ date: string }>(
      "select to_char(now() at time zone 'utc', 'YYYY-MM-DD') as date",
    )).rows[0].date;
    const jobs = (await db.query<{ jobname: string }>(
      "select jobname from cron.job order by jobname",
    )).rows;
    equal(jobs.length, 2);
    await db.exec("set role service_role");
    const claim = async (store: string, countries: string[]) =>
      (await db.query<
        { result: { status: string; lease_token: string; countries: string[] } }
      >(
        "select service.claim_store_ratings_run($1,$2::date,$3,$4::text[]) as result",
        [
          store,
          date,
          store === "app_store" ? "6449322787" : "com.coffee.timer",
          countries,
        ],
      )).rows[0].result;
    const finish = async (
      store: string,
      token: string,
      observations: unknown[],
      snapshot: unknown = null,
      error: string | null = null,
    ) =>
      (await db.query<{ result: { status: string } }>(
        "select service.finish_store_ratings_run($1,$2::date,$3::uuid,$4::jsonb,$5::jsonb,$6) as result",
        [
          store,
          date,
          token,
          JSON.stringify(observations),
          snapshot === null ? null : JSON.stringify(snapshot),
          error,
        ],
      )).rows[0].result;
    const row = (country: string, average: number, count: number) => ({
      country,
      status: "ok",
      average_rating: average,
      rating_count: count,
      source_date: date,
    });

    const first = await claim("app_store", ["fr", "us"]);
    equal(first.countries, ["fr", "us"]);
    equal((await claim("app_store", ["fr", "us"])).status, "busy");
    let badLeaseRejected = false;
    try {
      await finish("app_store", crypto.randomUUID(), []);
    } catch {
      badLeaseRejected = true;
    }
    equal(badLeaseRejected, true);
    equal(
      (await finish(
        "app_store",
        first.lease_token,
        [row("fr", 1, 1)],
        null,
        "upstream_request_failed",
      )).status,
      "failed",
    );
    equal(
      (await db.query("select * from public.app_store_ratings")).rows.length,
      0,
    );
    const retry = await claim("app_store", ["fr", "us"]);
    equal(retry.countries, ["us"]);
    equal(
      (await finish("app_store", retry.lease_token, [row("us", 5, 9)])).status,
      "complete",
    );
    const apple = (await db.query<{ average: number; count: number }>(
      "select average_rating::float8 as average, rating_count::int as count from public.app_store_ratings where store='app_store'",
    )).rows[0];
    equal(apple, { average: 4.6, count: 10 });
    equal((await claim("app_store", ["fr", "us"])).status, "complete");

    // A country-only Google export must retain an existing worldwide snapshot.
    await db.query(
      "insert into public.app_store_ratings (store,app_id,average_rating,source_date,methodology) values ('google_play','com.coffee.timer',4.9,$1::date,'google_play_total_average')",
      [date],
    );
    const google = await claim("google_play", []);
    equal(
      (await finish("google_play", google.lease_token, [{
        ...row("us", 3, 1),
        rating_count: null,
      }])).status,
      "blocked",
    );
    equal(
      (await db.query<{ average: number }>(
        "select average_rating::float8 as average from public.app_store_ratings where store='google_play'",
      )).rows[0].average,
      4.9,
    );
    const googleRetry = await claim("google_play", []);
    const oldDate = new Date(Date.parse(date) - 86400000).toISOString().slice(
      0,
      10,
    );
    await finish("google_play", googleRetry.lease_token, [], {
      average_rating: 2,
      rating_count: null,
      source_date: oldDate,
      methodology: "google_play_total_average",
      coverage: {},
    });
    equal(
      (await db.query<{ average: number }>(
        "select average_rating::float8 as average from public.app_store_ratings where store='google_play'",
      )).rows[0].average,
      4.9,
    );

    // An overview report can publish its explicit worldwide mean without
    // country observations or invented rating counts.
    await db.query(
      "delete from service.app_store_rating_runs where store='google_play'",
    );
    const overviewRun = await claim("google_play", []);
    equal(
      (await finish("google_play", overviewRun.lease_token, [], {
        average_rating: 4.9411,
        rating_count: null,
        source_date: date,
        methodology: "google_play_total_average",
        coverage: {
          reportType: "overview",
          countriesReported: 0,
          overallRow: true,
        },
      })).status,
      "complete",
    );
    equal(
      (await db.query<{ average: number; count: number | null }>(
        "select average_rating::float8 as average, rating_count as count from public.app_store_ratings where store='google_play'",
      )).rows[0],
      { average: 4.9411, count: null },
    );

    await db.exec("reset role; set role anon");
    equal(
      (await db.query("select * from public.app_store_ratings")).rows.length,
      2,
    );
    for (
      const sql of [
        "delete from public.app_store_ratings",
        "select * from service.app_store_rating_observations",
        "select service.claim_store_ratings_run('google_play',current_date,'com.coffee.timer','{}')",
        "select service.dispatch_store_ratings('app_store')",
      ]
    ) {
      let denied = false;
      try {
        await db.query(sql);
      } catch {
        denied = true;
      }
      equal(denied, true);
    }
  } finally {
    await db.close();
  }
});
