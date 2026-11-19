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
    create table public.clients(id uuid primary key, name text);
    create table public.pipelines(id uuid primary key, client_id uuid not null, position integer not null default 0, created_at timestamptz default now());
    create table public.profiles(id uuid primary key, role text check(role in ('admin','venditore')), client_id uuid, full_name text);
    create function public.is_admin() returns boolean language sql stable security definer as
      $$select coalesce((select role = 'admin' from public.profiles where id=auth.uid()), false)$$;
    create function public.my_client_id() returns uuid language sql stable security definer as $$select client_id from public.profiles where id=auth.uid()$$;
    create function public.my_full_name() returns text language sql stable security definer set search_path=public as
      $$select full_name from public.profiles where id=auth.uid()$$;
    create table public.leads(id uuid primary key, client_id uuid, pipeline_id uuid, stage_id uuid,
      name text, phone text, email text, source text, assigned_to text, value int, position int, next_action_date date);
    create table public.stages(id uuid, client_id uuid, pipeline_id uuid, name text, position int);
    create table public.sales_tasks(id uuid primary key, client_id uuid, lead_id uuid, title text, description text,
      due_at timestamptz, assigned_to text, created_by text, appointment_type text, appointment_status text,
      duration_minutes int, audience text, commercial_tracked boolean, appointment_host text, created_at timestamptz default now(),
      appointment_outcome text, outcome_minutes int, outcome_note text, proposal_made boolean,
      completed_at timestamptz, completed_by text, updated_at timestamptz default now());
    create table public.lead_activities(client_id uuid, lead_id uuid, pipeline_id uuid, activity_type text, event_type text,
      channel text, call_type text, outcome text, occurred_at timestamptz, scheduled_at timestamptz, duration_minutes int,
      note text, created_by text, details jsonb, event_key text, unique(client_id,event_key));
    create table public.sales_revenue_events(client_id uuid, amount int);
    create table public.sales_outreach_events(id uuid primary key, client_id uuid, lead_id uuid,
      event_type text, quantity int, occurred_at timestamptz);
    alter table public.leads enable row level security;
    alter table public.sales_tasks enable row level security;
    alter table public.sales_revenue_events enable row level security;
    alter table public.profiles enable row level security;
    create policy tenant_leads on public.leads for select to authenticated using (is_admin() or client_id=my_client_id());
    create policy tenant_tasks on public.sales_tasks for select to authenticated using (is_admin() or client_id=my_client_id());
    create policy tenant_tasks_write on public.sales_tasks for all to authenticated
      using (is_admin() or (client_id=my_client_id() and assigned_to=my_full_name()));
    create policy tenant_revenue on public.sales_revenue_events for select to authenticated using (is_admin() or client_id=my_client_id());
    create policy profiles_select on public.profiles for select to authenticated using (id=auth.uid() or is_admin());
    create policy profiles_update on public.profiles for update to authenticated using (id=auth.uid() or is_admin()) with check (id=auth.uid() or is_admin());
    grant usage on schema auth to authenticated;
    grant select on public.leads,public.sales_revenue_events,public.sales_tasks to authenticated;
    grant insert, update on public.sales_tasks to authenticated;
    grant select, insert, update on public.lead_activities to authenticated;
    grant select on public.sales_outreach_events to authenticated;
    grant select,update on public.profiles to authenticated;
    insert into public.clients values('${client}','Estetica Premium'), ('${otherClient}','Altro cliente');
    insert into public.pipelines(id,client_id) values('${pipeline}','${client}');
    insert into public.leads values
      ('${lead}','${client}','${pipeline}','${start}','A','111','a@example.test','Cold call','Prima',2990,0,null),
      ('${hidden}','${client}','${pipeline}','${start}','Segreto','222','b@example.test','Cold call','Prima',2990,1,null);
    insert into public.sales_revenue_events values('${client}',500);
    insert into public.stages values('${start}','${client}','${pipeline}','SETTING',1), ('${discovery}','${client}','${pipeline}','DISCOVERY',2);
  `);
  const migration = readFileSync("supabase/upgrade_setter_workspace.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
  const instructionsMigration = readFileSync("supabase/upgrade_setter_instructions.sql", "utf8");
  await db.exec(instructionsMigration);
  await db.exec(instructionsMigration);
  await db.exec(readFileSync("supabase/upgrade_setting_appointments.sql", "utf8"));
  const flowMigration = readFileSync("supabase/upgrade_setter_discovery_flow.sql", "utf8");
  await db.exec(flowMigration);
  await db.exec(flowMigration);
  await db.exec(`insert into public.profiles values
    ('${leader}','admin',null,'Titolare'), ('${setter}','setter','${client}','Setter A'),
    ('${otherSetter}','setter','${client}','Setter B'), ('${seller}','venditore','${client}','Giovanni'),
    ('${outsider}','setter','${otherClient}','Altro cliente');`);

  const workspace = (staff = null, start = "2020-01-01", end = "2020-12-31") => scalar(
    "select public.get_setter_workspace($1,$2,$3,$4)", [client, staff, start, end]);
  const assign = (contactId, staff = setter) => db.query("select public.assign_setter_lead($1,$2,$3)", [contactId, staff, seller]);
  await actor(leader);
  await db.exec("set role authenticated");
  const instructions = staffClient => scalar("select public.get_setter_instructions($1)", [staffClient]);
  const adminInstructions = await instructions(client);
  assert.match(adminInstructions, /INVIA MAX 50 MESS WHATSAPP A FREDDO AL GIORNO/);
  assert.match(adminInstructions, /ma posiamo valutare tutto/);
  await assert.rejects(() => instructions(otherClient), /non accessibili/);
  await assert.rejects(() => assign(lead, outsider), /stessa azienda/);
  await assign(lead);
  await assign(hidden, otherSetter);
  assert.equal((await workspace()).queue.length, 2);
  await actor(setter);
  assert.equal(await instructions(client), adminInstructions);
  await assert.rejects(() => instructions(otherClient), /non accessibili/);
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
  const saveBooking = (leadId, bookingId, dueAt, recordCall) => scalar(
    "select public.save_setter_discovery($1,$2,$3,null,$4)",[leadId,bookingId,dueAt,recordCall]);
  const book = () => saveBooking(lead,request,due,false);
  assert.equal(await book(), request);
  assert.equal(await book(), request);
  const day = new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const after = await workspace(null,day,day);
  assert.equal(after.queue[0].state,"booked");
  assert.deepEqual(after.totals,{contacts:1,answered:1,booked:1,held:0});
  await actor(seller);
  await assert.rejects(() => workspace(), /non accessibile/);
  await assert.rejects(() => instructions(client), /non accessibili/);
  assert.deepEqual((await db.query("select assigned_to,duration_minutes,description from public.sales_tasks")).rows,
    [{assigned_to:"Giovanni",duration_minutes:30,description:"Nota del setter"}]);
  await actor(leader);
  assert.equal(await scalar("select assigned_to from public.leads where id=$1",[lead]),"Giovanni");
  assert.equal(await scalar("select stage_id from public.leads where id=$1",[lead]),discovery);
  await db.exec("reset role");
  assert.equal(await scalar("select count(*)::int from public.lead_activities"),2);
  assert.equal(await scalar("select title from public.sales_tasks where id=$1",[request]),"A — Discovery");

  await actor(otherSetter);
  await db.exec("set role authenticated");
  const combinedId = id(24);
  const past = new Date(Date.now() - 3600_000).toISOString();
  await assert.rejects(() => saveBooking(lead,id(25),due,true), /Lead non accessibile/);
  await assert.rejects(() => saveBooking(hidden,combinedId,past,true), /future/);
  assert.deepEqual((await workspace(null,day,day)).totals,{contacts:0,answered:0,booked:0,held:0});
  assert.equal(await saveBooking(hidden,combinedId,due,true),combinedId);
  assert.equal(await saveBooking(hidden,combinedId,due,true),combinedId);
  assert.deepEqual((await workspace(null,day,day)).totals,{contacts:1,answered:1,booked:1,held:0});
  await db.exec("reset role");
  await db.query("update public.sales_tasks set due_at=$2 where id=$1",[request,past]);

  await actor(seller);
  await db.exec("set role authenticated");
  const version = taskId => scalar("select updated_at from public.sales_tasks where id=$1",[taskId]);
  const record = async (taskId,value) => scalar("select to_jsonb(save_sales_appointment_outcome($1,$2,$3,null,null,null))",
    [taskId,await version(taskId),value]);
  assert.equal((await record(request,"no_answer")).appointment_status,"no_show");
  const replacement = id(26);
  const bookAgain = (bookingId,origin) => scalar(
    "select to_jsonb(book_sales_appointment($1,$2,$3,'discovery','lead','Discovery successiva',$4,30,null,null,$5,null,null))",
    [bookingId,client,lead,past,`appointment:${origin}:outcome`]);
  assert.equal((await bookAgain(replacement,request)).id,replacement);
  assert.equal((await bookAgain(replacement,request)).id,replacement);
  assert.equal(await scalar("select setter_id from public.sales_tasks where id=$1",[replacement]),setter);
  assert.equal(await scalar("select details ? 'setter_id' from public.lead_activities where event_key=$1",[`appointment:${replacement}:booked`]),false);
  assert.equal((await record(replacement,"no_answer")).appointment_status,"no_show");
  const third = id(27);
  assert.equal((await bookAgain(third,replacement)).id,third);
  assert.equal((await record(third,"qualified")).appointment_status,"held");
  await actor(setter);
  const previousDay = new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(past));
  const tracked = await workspace(null,previousDay,day);
  assert.deepEqual(tracked.totals,{contacts:1,answered:1,booked:1,held:1});
  assert.equal(tracked.queue[0].discovery_status,"held");
  await db.exec("reset role");
  assert.equal(await scalar("select has_function_privilege('anon','public.get_setter_workspace(uuid,uuid,date,date)','execute')"),false);
  assert.equal(await scalar("select has_function_privilege('anon','public.get_setter_instructions(uuid)','execute')"),false);
  assert.equal(await scalar("select has_function_privilege('anon','public.save_setter_discovery(uuid,uuid,timestamptz,text,boolean)','execute')"),false);
  const databaseLeadsMigration = readFileSync("supabase/upgrade_database_leads.sql", "utf8");
  await db.exec(databaseLeadsMigration);
  await db.exec(databaseLeadsMigration);
  const autoPipelineMigration = readFileSync("supabase/upgrade_database_leads_auto_pipeline.sql", "utf8");
  await db.exec(autoPipelineMigration);
  await db.query("insert into public.pipelines(id,client_id,position) values ($1,$3,-1),($2,$3,1)", [id(28),id(29),client]);
  await db.query("insert into public.stages(id,client_id,pipeline_id,name,position) values ($1,$3,$4,'SETTING',1),($2,$3,$4,'DISCOVERY',2)",
    [id(35),id(36),client,id(29)]);
  const stock = id(31);
  const prebooked = id(32);
  await db.query(`insert into public.database_leads(id,client_id,name,phone,source,source_row,state)
    values($1,$3,'Centro privato','+390212340000','Cold call',2,'new'),($2,$3,'Già prenotato','+390212340001','Cold call',3,'booked')`, [stock,prebooked,client]);
  const assignStock = (ids, receiver = setter) => scalar("select public.assign_database_leads($1,$2,$3,$4,$5)", [client,ids,receiver,seller,pipeline]);
  const autoAssign = () => scalar("select public.assign_database_leads_to_setter($1,$2,$3,$4)", [client,[stock],setter,seller]);
  const completeWorkspace = () => scalar("select public.get_complete_setter_workspace($1,null,$2,$2)", [client,day]);
  const stockContact = () => scalar("select public.record_database_setter_contact($1,$2,'no_answer',null,null)", [stock,id(33)]);
  const stockBooking = () => scalar("select public.book_database_setter_discovery($1,$2,$3,null,false)", [stock,id(34),due]);
  await actor(leader);
  await db.exec("set role authenticated");
  assert.equal(await scalar("select count(*)::int from public.database_leads"),2);
  await assert.rejects(() => assignStock([stock,prebooked]), /disponibilità/);
  assert.equal(await autoAssign(),1);
  assert.equal(await scalar("select pipeline_id from public.database_leads where id=$1",[stock]),pipeline);
  assert.equal(await autoAssign(),1);
  await assert.rejects(() => assignStock([stock],otherSetter), /disponibilità/);
  assert.equal(await scalar("select count(*)::int from public.leads where name='Centro privato'"),0);
  await actor(seller);
  assert.equal(await scalar("select count(*)::int from public.database_leads"),0);
  await assert.rejects(completeWorkspace, /non accessibile/);
  await assert.rejects(autoAssign, /Solo il titolare/);
  await actor(otherSetter);
  assert.equal((await completeWorkspace()).queue.some(item => item.lead_id === stock),false);
  await assert.rejects(stockContact, /non accessibile/);
  await actor(setter);
  const beforeStockCall = await completeWorkspace();
  assert.equal(beforeStockCall.queue.find(item => item.lead_id === stock).phone,"+390212340000");
  assert.equal(beforeStockCall.queue.find(item => item.lead_id === stock).source,undefined);
  await stockContact();
  await stockContact();
  assert.equal((await completeWorkspace()).totals.contacts,beforeStockCall.totals.contacts+1);
  assert.equal(await stockBooking(),id(34));
  assert.equal(await stockBooking(),id(34));
  const afterStockBooking = await completeWorkspace();
  assert.equal(afterStockBooking.totals.booked,beforeStockCall.totals.booked+1);
  assert.equal(afterStockBooking.totals.contacts,beforeStockCall.totals.contacts+1);
  assert.equal(afterStockBooking.queue.some(item => item.lead_id === stock),false);
  await db.exec("reset role");
  assert.equal(await scalar("select stage_id from public.leads where name='Centro privato'"),discovery);
  assert.equal(await scalar("select count(*)::int from public.lead_activities where event_key=$1",[`database-setter-contact:${id(33)}`]),1);
  console.log("SQL OK: chiamata e prenotazione atomiche, retry, rebooking, KPI setter e ruoli isolati");
} finally {
  await db.close();
}
