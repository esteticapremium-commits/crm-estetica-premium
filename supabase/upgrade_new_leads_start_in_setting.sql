-- Tutti i nuovi lead acquisiti tramite l'integrazione entrano in SETTING.
-- I lead gia presenti non vengono modificati.
create or replace function public.upsert_lead(
  p_name text, p_phone text, p_email text, p_source text, p_assigned text
) returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_client uuid := 'fae0d66c-0e93-4e5e-b6f1-82ad0c47674c';
  v_pipe uuid; v_stage uuid; v_id uuid;
begin
  if p_name is null or length(trim(p_name)) = 0 then return null; end if;
  if p_phone is null or length(trim(p_phone)) = 0 then return null; end if;

  select id into v_pipe
  from pipelines
  where client_id = v_client
  order by created_at
  limit 1;

  select id into v_stage
  from stages
  where pipeline_id = v_pipe and name = 'SETTING'
  order by position
  limit 1;

  if v_pipe is null or v_stage is null then
    raise exception 'Pipeline o fase SETTING non trovata';
  end if;

  insert into leads (
    client_id, pipeline_id, stage_id, name, phone, email, source, assigned_to, position
  ) values (
    v_client, v_pipe, v_stage, trim(p_name), trim(p_phone),
    nullif(trim(coalesce(p_email, '')), ''),
    coalesce(nullif(trim(p_source), ''), 'Instantly'),
    nullif(trim(coalesce(p_assigned, '')), ''),
    0
  )
  on conflict (phone) do update set
    name = excluded.name,
    email = coalesce(excluded.email, leads.email)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.upsert_lead(text, text, text, text, text)
to anon, authenticated;
