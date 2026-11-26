import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const client = "00000000-0000-0000-0000-000000000001";
const lead = "00000000-0000-0000-0000-000000000002";
const account = "00000000-0000-0000-0000-000000000003";
const discovery = "00000000-0000-0000-0000-000000000004";
const demo = "00000000-0000-0000-0000-000000000005";
const standalone = "00000000-0000-0000-0000-000000000006";
const reply = "00000000-0000-0000-0000-000000000007";
const date = "2020-11-13T11:00:00Z";
await db.exec(`
  create role anon; create role authenticated; create schema auth;
  create table auth.users(id uuid primary key);
  create table clients(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select '${account}'::uuid$$;
  create function public.my_client_id() returns uuid language sql as $$select '${client}'::uuid$$;
  create function public.my_full_name() returns text language sql as $$select current_setting('test.actor')$$;
  create function public.is_admin() returns boolean language sql as $$select false$$;
  set test.actor='Giovanni';
  create table leads(id uuid primary key, client_id uuid, pipeline_id uuid, assigned_to text, next_action_date date);
  create table sales_tasks(id uuid primary key, client_id uuid, lead_id uuid, title text, description text,
    due_at timestamptz, assigned_to text, created_by text, appointment_type text, appointment_status text,
    audience text, duration_minutes int, completed_at timestamptz, completed_by text, google_event_id text,
    created_at timestamptz default clock_timestamp(), updated_at timestamptz default clock_timestamp());
  create function touch_task() returns trigger language plpgsql as $$begin new.updated_at=clock_timestamp(); return new; end$$;
  create trigger touch before update on sales_tasks for each row execute function touch_task();
  create table lead_activities(id uuid default gen_random_uuid(), lead_id uuid not null, client_id uuid, pipeline_id uuid,
    activity_type text, event_type text, channel text, call_type text, outcome text, occurred_at timestamptz,
    scheduled_at timestamptz, duration_minutes int, note text, created_by text, details jsonb, event_key text,
    unique(client_id, event_key), check(note is distinct from 'fallimento simulato'));
  create table sales_outreach_events(id uuid primary key, client_id uuid, lead_id uuid, event_type text,
    quantity int, occurred_at timestamptz);
  create table sales_revenue_events(id uuid default gen_random_uuid(), client_id uuid, lead_id uuid, occurred_at timestamptz);
  insert into leads values ('${lead}', '${client}', null, 'Giovanni', null);
  insert into sales_outreach_events values ('${reply}','${client}','${lead}','reply',1,'2020-11-12T11:00:00Z');
  alter table sales_tasks enable row level security;
  create policy task_scope on sales_tasks to authenticated using (client_id=my_client_id() and assigned_to=my_full_name());
  grant usage on schema auth to authenticated;
  grant select, update on leads to authenticated;
  grant select on sales_outreach_events to authenticated;
  grant select, insert, update on sales_tasks, lead_activities, sales_revenue_events to authenticated;
`);
const migration = readFileSync("supabase/upgrade_sales_appointment_workflow.sql", "utf8");
await db.exec(migration);
await db.exec(migration);
const settingMigration = readFileSync("supabase/upgrade_setting_appointments.sql", "utf8");
await db.exec(settingMigration);
await db.exec(settingMigration);
const settingHostMigration = readFileSync("supabase/upgrade_setting_booking_host.sql", "utf8");
await db.exec(settingHostMigration);
await db.exec(settingHostMigration);
await db.exec(readFileSync("supabase/upgrade_google_sales.sql", "utf8"));
const earlyNoShow = readFileSync("supabase/upgrade_early_no_show.sql", "utf8");
await db.exec(earlyNoShow);
await db.exec(earlyNoShow);
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const book = (id, type, forLead = lead, source = null, replyId = null, note = null, minutes = type === "setting" ? 15 : 30) => scalar(
  "select to_jsonb(book_sales_appointment($1,$2,$3,$4,'lead','Centro Test',$5,$9,$6,$6,$7,$8,null))",
  [id, client, forLead, type, date, note, source, replyId, minutes],
);
const outcome = (task, value, minutes = null, note = null) => scalar(
  "select to_jsonb(save_sales_appointment_outcome($1,$2,$3,$4,$5,null))",
  [task.id, task.updated_at, value, minutes, note],
);
await db.exec("set role authenticated");
const first = await book(discovery, "discovery", lead, null, reply);
assert.equal(first.appointment_status, "scheduled");
assert.equal((await book(discovery, "discovery", lead, null, reply)).id, first.id);
assert.equal(await scalar("select count(*)::int from lead_activities"), 1);
await assert.rejects(() => book(standalone, "discovery"), /già un appuntamento/);
await assert.rejects(() => outcome(first, "qualified", 12, "fallimento simulato"));
assert.equal(await scalar("select appointment_status from sales_tasks where id=$1", [first.id]), "scheduled");
const held = await outcome(first, "qualified", 12);
assert.equal((await outcome(first, "qualified", 12)).updated_at, held.updated_at);
await assert.rejects(() => outcome(first, "no_answer"), /aggiornato/);
const demoRow = await book(demo, "demo", lead, `appointment:${discovery}:outcome`);
assert.equal(demoRow.assigned_to, "Giovanni");
assert.equal(await scalar("select details->>'source_outcome_key' from lead_activities where event_type='demo_booked'"), `appointment:${discovery}:outcome`);
await outcome(demoRow, "held", 41);
await db.query("insert into sales_revenue_events(client_id,lead_id,occurred_at,sale_appointment_id) values ($1,$2,now(),$3)", [client, lead, demo]);
await assert.rejects(() => db.query("insert into sales_revenue_events(client_id,lead_id,occurred_at,sale_appointment_id) values ($1,$2,now(),$3)", [client, lead, discovery]), /closing svolta/);
const external = await book(standalone, "demo", null);
await outcome(external, "no_show");
assert.equal(await scalar("select appointment_outcome from sales_tasks where id=$1", [standalone]), "no_show");
assert.equal(await scalar("select count(*)::int from lead_activities"), 4);
const settingId = "00000000-0000-0000-0000-000000000010";
const nextSettingId = "00000000-0000-0000-0000-000000000011";
const linkedDiscoveryId = "00000000-0000-0000-0000-000000000012";
await assert.rejects(() => book(settingId, "setting", null), /lead prospect/);
await assert.rejects(() => book(settingId, "setting", lead, null, null, null, 30), /Dati appuntamento/);
const setting = await book(settingId, "setting");
assert.equal(setting.duration_minutes, 15);
assert.equal((await book(settingId, "setting")).id, settingId);
await assert.rejects(() => book(nextSettingId, "setting"), /già un appuntamento/);
const movedTo = "2020-11-14T12:30:00Z";
await db.query("select reschedule_crm_appointment($1,$2,'Setting telefonico — Centro Test',$3,null,15)", [settingId, setting.updated_at, movedTo]);
const moved = await scalar("select to_jsonb(t) from sales_tasks t where id=$1", [settingId]);
assert.equal(Date.parse(moved.due_at), Date.parse(movedTo));
assert.equal(await scalar("select count(*)::int from lead_activities where event_type='setting_booked'"), 1);
await assert.rejects(() => outcome(moved, "qualified"), /Esito non valido/);
const noAnswer = await outcome(moved, "no_answer");
assert.equal(noAnswer.appointment_status, "no_show");
const answered = await outcome(noAnswer, "answered");
assert.equal(answered.outcome_minutes, null);
const result = await scalar("select to_jsonb(a) from lead_activities a where event_type='setting_call'");
assert.equal(result.outcome, "answered");
assert.equal(result.call_type, "outbound");
assert.equal(Date.parse(result.occurred_at), Date.parse(movedTo));
assert.equal(await scalar("select count(*)::int from lead_activities where event_type='setting_call'"), 1);
const linked = await book(linkedDiscoveryId, "discovery", lead, `appointment:${settingId}:outcome`);
assert.equal(linked.id, linkedDiscoveryId);
assert.equal(await scalar("select details->>'source_outcome_key' from lead_activities where event_key=$1", [`appointment:${linkedDiscoveryId}:booked`]), `appointment:${settingId}:outcome`);
await outcome(linked, "no_answer");
const future = new Date(Date.now() + 86_400_000).toISOString();
for (const [index, type, rejected] of [[20, "setting", "no_answer"], [21, "discovery", "qualified"], [22, "demo", "held"]]) {
  const id = `00000000-0000-0000-0000-0000000000${index}`;
  const task = await scalar("select to_jsonb(book_sales_appointment($1,$2,$3,$4,'lead','Test',$5,$6,null,null,null,null,null))",
    [id, client, lead, type, future, type === "setting" ? 15 : 30]);
  await assert.rejects(() => outcome(task, rejected), /solo un no-show/);
  const missed = await outcome(task, "no_show");
  assert.equal(missed.appointment_status, "no_show");
  assert.equal(missed.outcome_minutes, null);
  assert.equal((await outcome(task, "no_show")).updated_at, missed.updated_at);
  const saved = await scalar("select to_jsonb(a) from lead_activities a where event_key=$1", [`appointment:${id}:outcome`]);
  assert.equal(saved.outcome, "no_show");
  assert.equal(Date.parse(saved.scheduled_at), Date.parse(future));
}
await db.exec("set test.actor='Altro venditore'");
await assert.rejects(() => outcome(held, "no_answer"), /accessibile/);
const personalSetting = await book("00000000-0000-0000-0000-000000000040", "setting");
assert.equal(personalSetting.appointment_host, "Altro venditore");
assert.equal(personalSetting.assigned_to, "Altro venditore");
assert.equal(await scalar("select assigned_to from leads where id=$1", [lead]), "Giovanni");
await db.exec("reset role");
const discoveryForAssignedLead = await book("00000000-0000-0000-0000-000000000041", "discovery");
assert.equal(discoveryForAssignedLead.appointment_host, "Giovanni");
assert.equal(discoveryForAssignedLead.assigned_to, "Giovanni");
assert.equal(await scalar("select has_function_privilege('anon','save_sales_appointment_outcome(uuid,timestamptz,text,integer,text,boolean)','execute')"), false);
console.log("SQL OK: migrazione idempotente, retry, scritture atomiche, esito concorrente, collegamenti, senza lead, RLS");
await db.exec(readFileSync("supabase/upgrade_confirmation_calls.sql", "utf8"));
const confirmationMigration = readFileSync("supabase/upgrade_confirmation_call_outcomes.sql", "utf8");
await db.exec(confirmationMigration);
await db.exec(confirmationMigration);
const confirmationId = "00000000-0000-0000-0000-000000000042";
await db.exec("set test.actor='Giovanni'; set role authenticated");
const confirmation = await scalar("select to_jsonb(book_confirmation_call($1,$2,$3,'Centro Test',null))",
  [confirmationId, demo, future]);
const saveConfirmation = (task, value) => scalar("select to_jsonb(save_confirmation_call_outcome($1,$2,$3))",
  [task.id, task.updated_at, value]);
await assert.rejects(() => saveConfirmation(confirmation, "held"), /solo un no-show/);
await assert.rejects(() => saveConfirmation(confirmation, "lost"), /Esito non valido/);
await assert.rejects(() => saveConfirmation(demoRow, "no_show"), /non accessibile/);
const missedConfirmation = await saveConfirmation(confirmation, "no_show");
assert.equal(missedConfirmation.appointment_status, "no_show");
assert.equal((await saveConfirmation(confirmation, "no_show")).updated_at, missedConfirmation.updated_at);
await db.query("update sales_tasks set due_at=$2 where id=$1", [confirmationId, date]);
const pastConfirmation = await scalar("select to_jsonb(t) from sales_tasks t where id=$1", [confirmationId]);
await assert.rejects(() => saveConfirmation(confirmation, "held"), /aggiornato/);
const heldConfirmation = await saveConfirmation(pastConfirmation, "held");
assert.equal(heldConfirmation.appointment_status, "held");
assert.equal(heldConfirmation.appointment_outcome, "held");
assert.equal(heldConfirmation.appointment_type, null);
assert.equal(heldConfirmation.commercial_tracked, false);
assert.equal(await scalar("select count(*)::int from lead_activities where details->>'task_id'=$1", [confirmationId]), 0);
await db.exec("set test.actor='Altro venditore'");
await assert.rejects(() => saveConfirmation(heldConfirmation, "no_show"), /non accessibile/);
assert.equal(await scalar("select has_function_privilege('anon','save_confirmation_call_outcome(uuid,timestamptz,text)','execute')"), false);
console.log("SQL OK: esiti delle conferme, correzioni, retry e permessi");
await db.exec("reset role");
const pipelineId = "00000000-0000-0000-0000-000000000043";
const closingStageId = "00000000-0000-0000-0000-000000000044";
const lostStageId = "00000000-0000-0000-0000-000000000045";
await db.exec(`
  create table stages(id uuid, client_id uuid, pipeline_id uuid, name text, position int);
  alter table leads add column stage_id uuid, add column position int, add column lost_reason text;
  insert into stages values
    ('${closingStageId}', '${client}', '${pipelineId}', 'CLOSING', 1),
    ('${lostStageId}', '${client}', '${pipelineId}', 'LOST', 2);
  update leads set stage_id='${closingStageId}', pipeline_id='${pipelineId}' where id='${lead}';
  grant select on stages to authenticated;
`);
const lostMigration = readFileSync("supabase/upgrade_confirmation_call_lost.sql", "utf8");
await db.exec(lostMigration);
await db.exec(lostMigration);
await db.exec("set test.actor='Giovanni'; set role authenticated");
const closeFromConfirmation = (task, stage) => scalar(
  "select to_jsonb(save_confirmation_call_outcome_and_close_lead($1,$2,'no_show',$3))",
  [task.id, task.updated_at, stage],
);
await assert.rejects(() => closeFromConfirmation(heldConfirmation, lostStageId), /fase del lead è cambiata/);
assert.equal(await scalar("select appointment_outcome from sales_tasks where id=$1", [confirmationId]), "held");
const closed = await closeFromConfirmation(heldConfirmation, closingStageId);
assert.equal(closed.appointment_outcome, "no_show");
assert.equal(await scalar("select stage_id from leads where id=$1", [lead]), lostStageId);
assert.equal(await scalar("select lost_reason from leads where id=$1", [lead]), "Non interessato più");
await closeFromConfirmation(heldConfirmation, closingStageId);
assert.equal(await scalar("select count(*)::int from lead_activities where event_key=$1", [`confirmation:${confirmationId}:not-interested`]), 1);
await db.exec("set test.actor='Altro venditore'");
await assert.rejects(() => closeFromConfirmation(closed, closingStageId), /non accessibile/);
console.log("SQL OK: no-show e chiusura lead atomici, correzioni e retry");
await db.close();
