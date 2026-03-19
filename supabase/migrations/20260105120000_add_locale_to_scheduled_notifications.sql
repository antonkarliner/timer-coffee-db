-- Add required locale to scheduled notifications (default 'en')
alter table service.scheduled_notifications
  add column if not exists locale text;

update service.scheduled_notifications
  set locale = 'en'
  where locale is null;

alter table service.scheduled_notifications
  alter column locale set default 'en',
  alter column locale set not null;

alter table service.scheduled_notifications
  add constraint scheduled_notifications_locale_length
  check (char_length(locale) between 2 and 10);
