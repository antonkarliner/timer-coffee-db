-- Cache table for OpenAI-generated bean review translations.
-- Keyed by (review_id, target_locale): every (review, locale) pair is paid for at most once.
create table public.bean_review_translations (
  review_id uuid not null references public.bean_reviews(id) on delete cascade,
  target_locale text not null,
  source_locale text not null,
  translated_text text not null,
  model text not null,
  created_at timestamptz not null default now(),
  primary key (review_id, target_locale)
);

create index bean_review_translations_review_id_idx
  on public.bean_review_translations (review_id);

alter table public.bean_review_translations enable row level security;

-- Read policy: any authenticated user can read translations (reviews themselves are public).
create policy "translations_select_authenticated"
  on public.bean_review_translations for select
  to authenticated
  using (true);

-- No insert/update/delete policy is created on purpose: only the service-role
-- key (used by the translate-bean-review edge function) bypasses RLS to write.

-- Detected source locale is cached on the review row to short-circuit
-- subsequent same-language reads without re-calling OpenAI.
alter table public.bean_reviews
  add column detected_source_locale text;

-- Invalidate cached translations when a review's text changes.
-- Deletion of the review itself is already handled by the FK ON DELETE CASCADE.
create or replace function public.invalidate_bean_review_translations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.review_text is distinct from old.review_text then
    delete from public.bean_review_translations where review_id = old.id;
    new.detected_source_locale := null;
  end if;
  return new;
end;
$$;

create trigger bean_reviews_invalidate_translations
  before update on public.bean_reviews
  for each row
  execute function public.invalidate_bean_review_translations();

-- Re-issue get_roaster_reviews so the client receives detected_source_locale.
-- Body is otherwise identical to the previous definition in
-- 20260406000001_bean_reviews_extended_fields.sql.
create or replace function public.get_roaster_reviews(
  p_roaster_profile_id uuid,
  p_offset integer default 0,
  p_limit integer default 20
)
returns json language sql stable security definer as $function$
  select json_agg(t)
  from (
    select
      br.id,
      br.user_id,
      br.roaster_profile_id,
      br.bean_name,
      br.rating,
      br.review_text,
      br.sweetness,
      br.acidity,
      br.fruitiness,
      br.body,
      br.brewing_method_id,
      br.would_buy_again,
      br.flavor_tags,
      br.bitterness,
      br.aftertaste,
      br.detected_source_locale,
      br.created_at,
      br.updated_at,
      rr.reply_text,
      rr.created_at as reply_created_at,
      upp.display_name         as reviewer_display_name,
      upp.profile_picture_url  as reviewer_avatar_url,
      ucb.origin               as bean_origin,
      ucb.roast_date           as bean_roast_date,
      bm.brewing_method        as brewing_method_name
    from public.bean_reviews br
    left join public.review_replies rr
           on rr.review_id = br.id
    left join public.user_public_profiles upp
           on upp.user_id = br.user_id
    left join public.user_coffee_beans ucb
           on ucb.beans_uuid = br.coffee_beans_uuid
          and ucb.user_id    = br.user_id
    left join public.brewing_methods bm
           on bm.brewing_method_id = br.brewing_method_id
    where br.roaster_profile_id = p_roaster_profile_id
      and br.is_public = true
    order by br.created_at desc
    offset p_offset
    limit p_limit
  ) t;
$function$;
