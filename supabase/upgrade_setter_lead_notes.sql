begin;

create table if not exists public.setter_lead_notes (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  database_contact_id uuid references public.database_leads(id) on delete cascade,
  author_id uuid not null,
  author_name text not null,
  body text not null check (char_length(trim(body)) between 1 and 3000),
  created_at timestamptz not null default now(),
  check (num_nonnulls(lead_id,database_contact_id)=1)
);

create index if not exists setter_notes_lead_idx on public.setter_lead_notes(lead_id,created_at desc) where lead_id is not null;
create index if not exists setter_notes_database_contact_idx on public.setter_lead_notes(database_contact_id,created_at desc) where database_contact_id is not null;
alter table public.setter_lead_notes enable row level security;
revoke all on public.setter_lead_notes from public, anon, authenticated;

create or replace function public.get_setter_lead_notes(p_client_id uuid, p_contact_id uuid, p_database_contact boolean)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  caller public.profiles;
  notes jsonb;
begin
  select * into caller from public.profiles where id=auth.uid();
  if not found or p_database_contact is null or (caller.role <> 'admin' and
     (caller.role <> 'setter' or caller.client_id is distinct from p_client_id)) then
    raise exception 'Note del lead non accessibili';
  end if;

  if p_database_contact then
    if not exists(select 1 from public.database_leads d where d.id=p_contact_id and d.client_id=p_client_id
      and (caller.role='admin' or (d.handed_off_at is null and d.setter_id=caller.id))) then
      raise exception 'Note del lead non accessibili';
    end if;
  elsif not exists(select 1 from public.setter_assignments a where a.lead_id=p_contact_id and a.client_id=p_client_id
    and (caller.role='admin' or a.setter_id=caller.id)) then
    raise exception 'Note del lead non accessibili';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'author_name',n.author_name,'body',n.body,'created_at',n.created_at)
    order by n.created_at desc,n.id desc),'[]'::jsonb) into notes from public.setter_lead_notes n
  where n.client_id=p_client_id and ((p_database_contact and n.database_contact_id=p_contact_id)
    or (not p_database_contact and (n.lead_id=p_contact_id or n.database_contact_id in (
      select d.id from public.database_leads d where d.lead_id=p_contact_id and d.client_id=p_client_id
    ))));
  return notes;
end;
$$;

create or replace function public.add_setter_lead_note(p_client_id uuid, p_contact_id uuid, p_database_contact boolean, p_request_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  caller public.profiles;
  note public.setter_lead_notes;
  clean_body text := btrim(p_body, E' \n\r\t');
  lead_ref uuid;
  contact_ref uuid;
begin
  select * into caller from public.profiles where id=auth.uid() and role='setter' and client_id=p_client_id;
  if not found then raise exception 'Solo il setter assegnato può scrivere una nota'; end if;
  if p_database_contact is null or p_request_id is null or coalesce(char_length(clean_body),0) not between 1 and 3000 then
    raise exception 'Scrivi una nota da 1 a 3000 caratteri';
  end if;

  if p_database_contact then
    select d.id into contact_ref from public.database_leads d where d.id=p_contact_id and d.client_id=p_client_id
      and d.setter_id=caller.id and d.handed_off_at is null for share;
  else
    select a.lead_id into lead_ref from public.setter_assignments a where a.lead_id=p_contact_id and a.client_id=p_client_id
      and a.setter_id=caller.id for share;
  end if;
  if not found then raise exception 'Lead non accessibile. Riapri la scheda aggiornata'; end if;

  insert into public.setter_lead_notes(id,client_id,lead_id,database_contact_id,author_id,author_name,body)
    values(p_request_id,p_client_id,lead_ref,contact_ref,caller.id,coalesce(nullif(trim(caller.full_name),''),'Setter'),clean_body)
    on conflict (id) do nothing returning * into note;
  if not found then
    select n.* into note from public.setter_lead_notes n where n.id=p_request_id and n.client_id=p_client_id and n.author_id=caller.id
      and n.lead_id is not distinct from lead_ref and n.database_contact_id is not distinct from contact_ref and n.body=clean_body;
    if not found then raise exception 'Questa nota ha già un salvataggio diverso'; end if;
  end if;
  return jsonb_build_object('id',note.id,'author_name',note.author_name,'body',note.body,'created_at',note.created_at);
end;
$$;

revoke all on function public.get_setter_lead_notes(uuid,uuid,boolean),public.add_setter_lead_note(uuid,uuid,boolean,uuid,text) from public, anon;
grant execute on function public.get_setter_lead_notes(uuid,uuid,boolean),public.add_setter_lead_note(uuid,uuid,boolean,uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
