-- Apply after upgrade_closing_refused_and_discovery.
begin;

do $migration$
declare
  definition text := pg_get_functiondef('public.save_sales_appointment_outcome(uuid,timestamptz,text,integer,text,boolean)'::regprocedure);
  allowed_before text := $body$task.appointment_type = 'demo' and p_outcome in ('held', 'lost', 'no_show')$body$;
  allowed_after text := $body$task.appointment_type = 'demo' and p_outcome in ('held', 'won', 'lost', 'no_show')$body$;
  proposal_before text := $body$result_proposal := case when task.appointment_type = 'demo' and p_outcome = 'lost' then true$body$;
  proposal_after text := $body$result_proposal := case when task.appointment_type = 'demo' and p_outcome in ('won', 'lost') then true$body$;
begin
  if strpos(definition, allowed_after) = 0 then
    if strpos(definition, allowed_before) = 0 then raise exception 'Convalida esiti closing da verificare'; end if;
    definition := replace(definition, allowed_before, allowed_after);
  end if;
  if strpos(definition, proposal_after) = 0 then
    if strpos(definition, proposal_before) = 0 then raise exception 'Registrazione proposta da verificare'; end if;
    definition := replace(definition, proposal_before, proposal_after);
  end if;
  execute definition;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
