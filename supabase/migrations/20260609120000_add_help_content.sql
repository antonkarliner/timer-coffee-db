-- Help / FAQ / Manuals content: server-curated, read-only articles that explain
-- the app's features and improve their discoverability.
--
-- Two tables use the per-locale-row pattern (like coffee_facts / launch_popup):
--   help_categories   one row per (category slug, locale)
--   help_articles     one row per (article slug, locale), tagged with category_slug
--
-- Each row carries an `is_translated` flag (English is the source; the translation
-- pipeline fills localized rows). Clients query their locale and fall back to 'en'
-- per slug when a localized row is missing.
--
-- Clients are read-only: SELECT is public. No INSERT/UPDATE/DELETE policies are
-- added, so RLS denies writes; content is managed via service_role.

create table if not exists "public"."help_categories" (
    "slug" character varying(255) not null,
    "locale" character varying not null,
    "title" text not null,
    "icon" text,
    "sort_order" integer not null default 0,
    "is_translated" boolean not null default false,
    "updated_at" timestamp with time zone not null default now(),
    constraint help_categories_pkey primary key ("slug", "locale"),
    constraint help_categories_locale_fkey
        foreign key ("locale") references "public"."supported_locales" ("locale")
);

create table if not exists "public"."help_articles" (
    "slug" character varying(255) not null,
    "locale" character varying not null,
    "category_slug" character varying(255) not null,
    "title" text not null,
    "body" text not null,
    "sort_order" integer not null default 0,
    "is_translated" boolean not null default false,
    "updated_at" timestamp with time zone not null default now(),
    constraint help_articles_pkey primary key ("slug", "locale"),
    constraint help_articles_locale_fkey
        foreign key ("locale") references "public"."supported_locales" ("locale")
);

create index if not exists help_articles_category_slug_idx
    on "public"."help_articles" ("category_slug");
create index if not exists help_categories_locale_idx
    on "public"."help_categories" ("locale");
create index if not exists help_articles_locale_idx
    on "public"."help_articles" ("locale");

-- RLS: public SELECT, no write policies → writes blocked (service_role bypasses RLS).
alter table "public"."help_categories" enable row level security;
alter table "public"."help_articles" enable row level security;

drop policy if exists "help_categories_public_select" on "public"."help_categories";
create policy "help_categories_public_select" on "public"."help_categories"
    for select
    using (true);

drop policy if exists "help_articles_public_select" on "public"."help_articles";
create policy "help_articles_public_select" on "public"."help_articles"
    for select
    using (true);

-- Grants: public read; writes only via service_role (seeding + translation pipeline).
grant select on "public"."help_categories" to anon, authenticated;
grant select on "public"."help_articles" to anon, authenticated;
grant select, insert, update, delete on "public"."help_categories" to service_role;
grant select, insert, update, delete on "public"."help_articles" to service_role;
