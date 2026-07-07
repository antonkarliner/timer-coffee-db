-- Recipe collections: server-curated, read-only groupings of recipes that cut
-- across brewing methods (e.g. "Iced coffee", "Quick brews").
--
-- Three tables mirror the recipes / recipe_localization / steps pattern:
--   recipe_collections                  parent rows (one per collection)
--   recipe_collection_localization      localized name + description per locale
--   recipe_collection_members           many-to-many membership with sort order
--
-- Clients are read-only: SELECT is permitted only when the parent collection
-- has is_published = TRUE. No INSERT/UPDATE/DELETE policies are added, so RLS
-- denies writes by default.

create table if not exists "public"."recipe_collections" (
    "id" character varying(255) not null,
    "emoji" text not null,
    "display_order" integer not null default 0,
    "is_published" boolean not null default false,
    "last_modified" timestamp with time zone not null default now(),
    constraint recipe_collections_pkey primary key ("id")
);

create table if not exists "public"."recipe_collection_localization" (
    "id" serial primary key,
    "collection_id" character varying(255) not null,
    "locale" character varying not null,
    "name" text not null,
    "description" text,
    constraint recipe_collection_localization_collection_id_fkey
        foreign key ("collection_id") references "public"."recipe_collections" ("id") on delete cascade,
    constraint recipe_collection_localization_locale_fkey
        foreign key ("locale") references "public"."supported_locales" ("locale"),
    constraint recipe_collection_localization_collection_locale_unique
        unique ("collection_id", "locale")
);

create table if not exists "public"."recipe_collection_members" (
    "collection_id" character varying(255) not null,
    "recipe_id" character varying(255) not null,
    "sort_order" integer not null default 0,
    constraint recipe_collection_members_pkey primary key ("collection_id", "recipe_id"),
    constraint recipe_collection_members_collection_id_fkey
        foreign key ("collection_id") references "public"."recipe_collections" ("id") on delete cascade,
    constraint recipe_collection_members_recipe_id_fkey
        foreign key ("recipe_id") references "public"."recipes" ("id") on delete cascade
);

create index if not exists recipe_collection_localization_collection_id_idx
    on "public"."recipe_collection_localization" ("collection_id");
create index if not exists recipe_collection_members_collection_id_idx
    on "public"."recipe_collection_members" ("collection_id");
create index if not exists recipe_collection_members_recipe_id_idx
    on "public"."recipe_collection_members" ("recipe_id");

-- RLS: SELECT only for published collections. No write policies → writes blocked.
alter table "public"."recipe_collections" enable row level security;
alter table "public"."recipe_collection_localization" enable row level security;
alter table "public"."recipe_collection_members" enable row level security;

drop policy if exists "recipe_collections_public_select" on "public"."recipe_collections";
create policy "recipe_collections_public_select" on "public"."recipe_collections"
    for select
    using ("is_published" = true);

drop policy if exists "recipe_collection_localization_public_select" on "public"."recipe_collection_localization";
create policy "recipe_collection_localization_public_select" on "public"."recipe_collection_localization"
    for select
    using (
        exists (
            select 1 from "public"."recipe_collections" c
            where c."id" = "recipe_collection_localization"."collection_id"
              and c."is_published" = true
        )
    );

drop policy if exists "recipe_collection_members_public_select" on "public"."recipe_collection_members";
create policy "recipe_collection_members_public_select" on "public"."recipe_collection_members"
    for select
    using (
        exists (
            select 1 from "public"."recipe_collections" c
            where c."id" = "recipe_collection_members"."collection_id"
              and c."is_published" = true
        )
    );

-- Grants: mirror what other public-read tables use (anon + authenticated SELECT).
grant select on "public"."recipe_collections" to anon, authenticated;
grant select on "public"."recipe_collection_localization" to anon, authenticated;
grant select on "public"."recipe_collection_members" to anon, authenticated;
