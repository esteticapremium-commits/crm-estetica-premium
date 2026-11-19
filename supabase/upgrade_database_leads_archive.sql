begin;

alter table public.database_leads add column if not exists archived_at timestamptz;
alter table public.database_leads add column if not exists archive_reason text;

do $$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.database_leads'::regclass and conname='database_leads_archive_unassigned') then
    alter table public.database_leads add constraint database_leads_archive_unassigned check (
      (archived_at is null and archive_reason is null) or
      (archived_at is not null and nullif(trim(archive_reason),'') is not null and setter_id is null and handed_off_at is null)
    );
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='database_leads' and policyname='database_leads_active_read') then
    create policy database_leads_active_read on public.database_leads as restrictive
      for select to authenticated using (archived_at is null);
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
