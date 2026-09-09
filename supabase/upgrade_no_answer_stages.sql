-- Divide la lavorazione dei tentativi senza risposta in due fasi consecutive.
-- I lead già presenti restano nella fase esistente, che viene solo rinominata.
do $$
declare
  v_stage public.stages%rowtype;
  v_second_stage uuid;
begin
  select s.* into v_stage
  from public.stages s
  join public.pipelines p on p.id = s.pipeline_id
  where p.name = 'Pipeline Sales'
    and s.name in ('NO ANSWER', 'NO ANSWER 1-3')
  order by case when s.name = 'NO ANSWER' then 0 else 1 end
  limit 1;

  if v_stage.id is null then
    raise exception 'Fase NO ANSWER non trovata nella Pipeline Sales';
  end if;

  update public.stages
  set name = 'NO ANSWER 1-3'
  where id = v_stage.id;

  select id into v_second_stage
  from public.stages
  where pipeline_id = v_stage.pipeline_id
    and name = 'NO ANSWER 4-5'
  limit 1;

  if v_second_stage is null then
    update public.stages
    set position = position + 1
    where pipeline_id = v_stage.pipeline_id
      and position > v_stage.position;

    insert into public.stages (
      client_id,
      pipeline_id,
      name,
      position,
      color,
      is_entry,
      probability
    ) values (
      v_stage.client_id,
      v_stage.pipeline_id,
      'NO ANSWER 4-5',
      v_stage.position + 1,
      '#334155',
      false,
      coalesce(v_stage.probability, 5)
    );
  end if;
end
$$;

-- Mantiene funzionante l'ingresso automatico: ogni nuovo lead parte da SETTING.
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
  select id into v_pipe from pipelines where client_id = v_client limit 1;
  select id into v_stage from stages
    where pipeline_id = v_pipe and name = 'SETTING'
    order by position limit 1;
  insert into leads (client_id, pipeline_id, stage_id, name, phone, email, source, assigned_to, position)
  values (v_client, v_pipe, v_stage, trim(p_name), trim(p_phone),
          nullif(trim(coalesce(p_email,'')),''), coalesce(nullif(trim(p_source),''),'Instantly'),
          nullif(trim(coalesce(p_assigned,'')),''), 0)
  on conflict (phone) do update set
    name = excluded.name,
    email = coalesce(excluded.email, leads.email)
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.upsert_lead(text, text, text, text, text)
to anon, authenticated;
