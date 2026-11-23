begin;

-- For setting calls only, the appointment belongs to the chosen host or the booker.
-- Keep the lead assignment and the installed booking validations unchanged.
do $migration$
declare
  definition text := pg_get_functiondef('public.book_sales_appointment(uuid,uuid,uuid,text,text,text,timestamptz,integer,text,text,text,uuid,text)'::regprocedure);
  before_values text := $before$    coalesce(nullif(target_lead.assigned_to, ''), nullif(author, ''), 'Venditore'), author,
    p_type, 'scheduled', p_audience, p_minutes, true,
    coalesce(nullif(trim(p_host), ''), nullif(target_lead.assigned_to, ''), author))$before$;
  after_values text := $after$    case when p_type = 'setting' then coalesce(nullif(trim(p_host), ''), nullif(author, ''), 'Venditore')
      else coalesce(nullif(target_lead.assigned_to, ''), nullif(author, ''), 'Venditore') end, author,
    p_type, 'scheduled', p_audience, p_minutes, true,
    coalesce(nullif(trim(p_host), ''), case when p_type <> 'setting' then nullif(target_lead.assigned_to, '') end, author))$after$;
begin
  if strpos(definition, after_values) > 0 then return; end if;
  if length(definition) - length(replace(definition, before_values, '')) <> length(before_values) then
    raise exception 'La definizione della prenotazione è cambiata: impossibile aggiornare il default della setting';
  end if;
  execute replace(definition, before_values, after_values);
end;
$migration$;

commit;
