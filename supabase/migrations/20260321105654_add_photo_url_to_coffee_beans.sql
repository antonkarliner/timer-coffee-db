-- Add photo_url column to user_coffee_beans for storing bean label photo references
alter table "public"."user_coffee_beans" add column "photo_url" text;

-- Create private bean-photos storage bucket
insert into storage.buckets (id, name, public)
values ('bean-photos', 'bean-photos', false)
on conflict (id) do nothing;

-- RLS policies: users can only access their own bean photos
create policy "Users can upload their own bean photos"
on "storage"."objects"
as permissive
for insert
to authenticated
with check (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

create policy "Users can read their own bean photos"
on "storage"."objects"
as permissive
for select
to authenticated
using (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

create policy "Users can update their own bean photos"
on "storage"."objects"
as permissive
for update
to authenticated
using (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

create policy "Users can delete their own bean photos"
on "storage"."objects"
as permissive
for delete
to authenticated
using (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
