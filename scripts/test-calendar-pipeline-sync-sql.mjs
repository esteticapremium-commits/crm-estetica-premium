import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const id = value => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
const client = id(1), pipeline = id(2), otherPipeline = id(3);
const setting = id(4), discovery = id(5), closing = id(6), lost = id(7), noShow = id(8);
const axiom = id(21), google = id(22), finished = id(23), other = id(24), newest = id(25);
const startsAt = "2030-11-22T23:30:00Z";

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create table public.stages(id uuid primary key, client_id uuid, pipeline_id uuid, name text, position integer);
    create table public.leads(id uuid primary key, client_id uuid, pipeline_id uuid, stage_id uuid, position integer, next_action_date date);
    create table public.sales_tasks(id uuid primary key default gen_random_uuid(), client_id uuid, lead_id uuid,
      appointment_type text, appointment_status text, audience text, due_at timestamptz);
    create table public.google_sales_appointments(id uuid primary key default gen_random_uuid(),client_id uuid,lead_id uuid,
      appointment_type text,outcome text,revenue_type text,starts_at timestamptz,next_action_at timestamptz);
    insert into public.stages values
      ('${setting}','${client}','${pipeline}','SETTING',1),('${discovery}','${client}','${pipeline}','DISCOVERY',2),
      ('${closing}','${client}','${pipeline}','CLOSING',3),('${lost}','${client}','${pipeline}','LOST',4),
      ('${noShow}','${client}','${pipeline}','NO SHOW',5),('${id(9)}','${client}','${otherPipeline}','SETTING',1);
    insert into public.leads values
      ('${axiom}','${client}','${pipeline}','${setting}',0,null),('${google}','${client}','${pipeline}','${noShow}',0,null),
      ('${finished}','${client}','${pipeline}','${lost}',0,null),('${other}','${client}','${otherPipeline}','${id(9)}',0,null),
      ('${newest}','${client}','${pipeline}','${setting}',0,null);
  `);
  const migration = readFileSync("supabase/upgrade_calendar_pipeline_sync.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
  const state = async lead => (await db.query("select stage_id,position,next_action_date::text from public.leads where id=$1",[lead])).rows[0];
  const crm = (lead, type, audience = "lead", status = "scheduled") => db.query(
    "insert into public.sales_tasks(client_id,lead_id,appointment_type,appointment_status,audience,due_at) values($1,$2,$3,$4,$5,$6)",
    [client,lead,type,status,audience,startsAt]);
  const external = async (lead, type, outcome = "pending", revenue = "new") => (await db.query(
    "insert into public.google_sales_appointments(client_id,lead_id,appointment_type,outcome,revenue_type,starts_at) values($1,$2,$3,$4,$5,$6) returning id",
    [client,lead,type,outcome,revenue,startsAt])).rows[0].id;

  await crm(axiom,"demo");
  assert.deepEqual(await state(axiom),{stage_id:closing,position:-1,next_action_date:"2030-11-23"});
  await crm(axiom,"discovery");
  assert.equal((await state(axiom)).stage_id,closing);
  await crm(finished,"demo");
  assert.equal((await state(finished)).stage_id,lost);
  await crm(newest,"demo","client");
  await crm(newest,"demo","lead","cancelled");
  assert.equal((await state(newest)).stage_id,setting);
  await crm(newest,"demo");
  assert.equal((await state(newest)).position,-2);

  const reference = await external(null,"discovery");
  assert.equal((await state(google)).stage_id,noShow);
  await external(google,"demo","pending","renewal");
  await external(google,"discovery","excluded");
  assert.equal((await state(google)).stage_id,noShow);
  await db.query("update public.google_sales_appointments set lead_id=$1 where id=$2",[google,reference]);
  assert.equal((await state(google)).stage_id,discovery);
  await db.query("update public.google_sales_appointments set outcome='closing_booked', next_action_at=$1 where id=$2",["2030-11-24T12:00:00Z",reference]);
  assert.deepEqual(await state(google),{stage_id:closing,position:-3,next_action_date:"2030-11-24"});

  await assert.rejects(() => crm(other,"demo"),/CLOSING/);
  assert.equal((await db.query("select count(*)::int as n from public.sales_tasks where lead_id=$1",[other])).rows[0].n,0);
  assert.equal((await state(other)).stage_id,id(9));
  assert.equal((await db.query("select has_function_privilege('authenticated','public.sync_calendar_lead_stage(uuid,uuid,text,timestamptz)','execute') as allowed")).rows[0].allowed,false);
  console.log("SQL OK: Calendario CRM, collegamento Google, Closing diretta, protezione fasi terminali, rollback e permessi");
} finally {
  await db.close();
}
