import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const id = n => "00000000-0000-0000-0000-" + String(n).padStart(12, "0");
const [client, otherClient, leader, setter, otherSetter, seller, outsider, lead, hidden, pipeline, start, discovery, request, contact] =
  Array.from({length:14}, (_, i) => id(i + 1));
const actor = uid => db.query("select set_config('fixture.uid',$1,false)", [uid]);
const scalar = async (sql,args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];

try {
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create function auth.uid() returns uuid language sql as $$select current_setting('fixture.uid',true)::uuid$$;
    create table auth.users(id uuid primary key, email text);
    create table public.clients(id uuid primary key);
    create table public.profiles(id uuid primary key, role text check(role in ('admin','venditore')), client_id uuid, full_name text);
    create function public.is_admin() returns boolean language sql stable security definer as
      $$select coalesce((select role = 'admin' from public.profiles where id=auth.uid()), false)$$;
    create function public.my_client_id() returns uuid language sql stable security definer as $$select client_id from public.profiles where id=auth.uid()$$;
    create table public.leads(id uuid primary key, client_id uuid, pipeline_id uuid, stage_id uuid,
      name text, phone text, email text, source text, assigned_to text, value int, position int, next_action_date date);
    create table public.stages(id uuid, client_id uuid, pipeline_id uuid, name text, position int);
    create table public.sales_tasks(id uuid primary key, client_id uuid, lead_id uuid, title text, description text,
      due_at timestamptz, assigned_to text, created_by text, appointment_type text, appointment_status text,
      duration_minutes int, audience text, commercial_tracked boolean, appointment_host text, created_at timestamptz default now());
    create table public.lead_activities(client_id uuid, lead_id uuid, pipeline_id uuid, activity_type text, event_type text,
      channel text, call_type text, outcome text, occurred_at timestamptz, scheduled_at timestamptz, duration_minutes int,
      note text, created_by text, details jsonb, event_key text, unique(client_id,event_key));
    create table public.sales_revenue_events(client_id uuid, amount int);
    alter table public.leads enable row level security;
    alter table public.sales_tasks enable row level security;
    alter table public.sales_revenue_events enable row level security;
    alter table public.profiles enable row level security;
    create policy tenant_leads on public.leads for select to authenticated using (is_admin() or client_id=my_client_id());
    create policy tenant_tasks on public.sales_tasks for select to authenticated using (is_admin() or client_id=my_client_id());
    create policy tenant_revenue on public.sales_revenue_events for select to authenticated using (is_admin() or client_id=my_client_id());
    create policy profiles_select on public.profiles for select to authenticated using (id=auth.uid() or is_admin());
    create policy profiles_update on public.profiles for update to authenticated using (id=auth.uid() or is_admin()) with check (id=auth.uid() or is_admin());
    grant usage on schema auth to authenticated;
    grant select on public.leads,public.sales_revenue_events,public.sales_tasks to authenticated;
    grant select,update on public.profiles to authenticated;
    insert into public.clients values('${client}'), ('${otherClient}');
    insert into public.leads values
      ('${lead}','${client}','${pipeline}','${start}','A','111','a@example.test','Cold call','Prima',2990,0,null),
      ('${hidden}','${client}','${pipeline}','${start}','Segreto','222','b@example.test','Cold call','Prima',2990,1,null);
    insert into public.sales_revenue_events values('${client}',500);
    insert into public.stages values('${start}','${client}','${pipeline}','SETTING',1), ('${discovery}','${client}','${pipeline}','DISCOVERY',2);
  `);
  const migration = readFileSync("supabase/upgrade_setter_workspace.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(`insert into public.profiles values
    ('${leader}','admin',null,'Titolare'), ('${setter}','setter','${client}','Setter A'),
    ('${otherSetter}','setter','${client}','Setter B'), ('${seller}','venditore','${client}','Giovanni'),
    ('${outsider}','setter','${otherClient}','Altro cliente');`);

  const workspace = (staff = null, start = "2020-01-01", end = "2020-12-31") => scalar(
    "select public.get_setter_workspace($1,$2,$3,$4)", [client, staff, start, end]);
  const assign = (contactId, staff = setter) => db.query("select public.assign_setter_lead($1,$2,$3)", [contactId, staff, seller]);
  await actor(leader);
  await db.exec("set role authenticated");
  await assert.rejects(() => assign(lead, outsider), /stessa azienda/);
  await assign(lead);
  await assign(hidden, otherSetter);
  assert.equal((await workspace()).queue.length, 2);
  await actor(setter);
  assert.equal(await scalar("select count(*)::int from public.leads"), 0, "raw lead table stays private");
  assert.equal(await scalar("select count(*)::int from public.sales_revenue_events"), 0, "cash stays private");
  await assert.rejects(() => db.query("update public.profiles set role='admin' where id=$1", [setter]), /Solo il titolare/);
  await assert.rejects(() => workspace(otherSetter), /non accessibile/);
  await assert.rejects(() => assign(hidden), /Solo il titolare/);
  const mine = await workspace();
  assert.equal(mine.queue.length, 1);
  assert.equal(mine.queue[0].lead_id, lead);
  assert.ok(!("value" in mine.queue[0]));
  const mark = leadId => db.query("select public.record_setter_contact($1,$2,'answered','Nota del setter',null)", [leadId, contact]);
  await assert.rejects(() => mark(hidden), /Lead non accessibile/);
  await mark(lead);
  await mark(lead);
  const due = new Date(Date.now() + 2 * 3600_000).toISOString();
  const book = () => scalar("select public.book_setter_discovery($1,$2,$3,null)", [lead,request,due]);
  assert.equal(await book(), request);
  assert.equal(await book(), request);
  const day = new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const after = await workspace(null,day,day);
  assert.equal(after.queue[0].state,"booked");
  assert.deepEqual(after.totals,{contacts:1,answered:1,booked:1,held:0});
  await actor(seller);
  await assert.rejects(() => workspace(), /non accessibile/);
  assert.deepEqual((await db.query("select assigned_to,duration_minutes,description from public.sales_tasks")).rows,
    [{assigned_to:"Giovanni",duration_minutes:30,description:"Nota del setter"}]);
  await actor(leader);
  assert.equal(await scalar("select assigned_to from public.leads where id=$1",[lead]),"Giovanni");
  assert.equal(await scalar("select stage_id from public.leads where id=$1",[lead]),discovery);
  await db.exec("reset role");
  assert.equal(await scalar("select count(*)::int from public.lead_activities"),2);
  assert.equal(await scalar("select has_function_privilege('anon','public.get_setter_workspace(uuid,uuid,date,date)','execute')"),false);
  console.log("SQL OK: ruoli isolati, assegnazioni, tentativo idempotente, passaggio a Giovanni e KPI");
} finally {
  await db.close();
}
