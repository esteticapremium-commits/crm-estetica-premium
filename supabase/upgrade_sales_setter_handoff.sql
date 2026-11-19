begin;

create or replace function public.get_sales_setter_handoff(p_client_id uuid, p_lead_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  caller public.profiles;
  sales_owner text;
  setter_name text;
  outcome_note text;
  discovery_status text;
  notes jsonb;
begin
  select * into caller from public.profiles where id=auth.uid() and role in ('admin','venditore');
  if not found or (caller.role='venditore' and caller.client_id is distinct from p_client_id) then
    return null;
  end if;
  select l.assigned_to, coalesce(nullif(trim(s.full_name),''),'Setter'), a.note, t.appointment_status
    into sales_owner,setter_name,outcome_note,discovery_status
    from public.setter_assignments a
    join public.leads l on l.id=a.lead_id and l.client_id=a.client_id
    left join public.profiles s on s.id=a.setter_id
    left join public.sales_tasks t on t.id=a.discovery_task_id and t.lead_id=a.lead_id and t.client_id=a.client_id
    where a.client_id=p_client_id and a.lead_id=p_lead_id and a.state='booked'
      and (caller.role='admin' or l.assigned_to=public.my_full_name());
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'author_name',n.author_name,'body',n.body,'created_at',n.created_at)
    order by n.created_at desc,n.id desc),'[]'::jsonb) into notes from public.setter_lead_notes n
    where n.client_id=p_client_id and (n.lead_id=p_lead_id or n.database_contact_id in (
      select d.id from public.database_leads d where d.lead_id=p_lead_id and d.client_id=p_client_id and d.handed_off_at is not null
    ));
  return jsonb_build_object('setter_name',setter_name,'sales_owner',sales_owner,'discovery_status',discovery_status,
    'outcome_note',outcome_note,'notes',notes);
end;
$$;

revoke all on function public.get_sales_setter_handoff(uuid,uuid) from public, anon;
grant execute on function public.get_sales_setter_handoff(uuid,uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
