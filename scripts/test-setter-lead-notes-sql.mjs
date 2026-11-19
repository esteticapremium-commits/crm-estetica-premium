import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [client, admin, setter, otherSetter, seller, lead, stock, regularNote, stockNote, secondNote] =
  Array.from({length:10}, (_, index) => uuid(index + 1));

try {
  await db.exec(`
    create role authenticated;
    create role anon;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create table public.clients(id uuid primary key);
    create table public.profiles(id uuid primary key, client_id uuid, role text, full_name text);
    create table public.leads(id uuid primary key, client_id uuid);
    create table public.database_leads(id uuid primary key, client_id uuid, setter_id uuid, lead_id uuid, handed_off_at timestamptz);
    create table public.setter_assignments(lead_id uuid primary key, client_id uuid, setter_id uuid, state text);
    insert into public.clients values('${client}');
    insert into public.profiles values ('${admin}','${client}','admin','Titolare'), ('${setter}','${client}','setter','Setter A'),
      ('${otherSetter}','${client}','setter','Setter B'), ('${seller}','${client}','venditore','Venditore');
    insert into public.leads values('${lead}','${client}');
    insert into public.setter_assignments values('${lead}','${client}','${setter}','booked');
    insert into public.database_leads values('${stock}','${client}','${setter}',null,null);
  `);
  const migration = readFileSync("supabase/upgrade_setter_lead_notes.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
  const scalar = async (sql, args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
  const actor = id => db.query("select set_config('test.uid',$1,false)",[id]);
  const get = (target, database = false) => scalar("select public.get_setter_lead_notes($1,$2,$3)",[client,target,database]);
  const add = (target, database, id, text) => scalar("select public.add_setter_lead_note($1,$2,$3,$4,$5)",[client,target,database,id,text]);

  await db.exec("set role authenticated");
  await actor(setter);
  const first = await add(lead,false,regularNote,"Nota su una discovery già fissata\nSeconda riga");
  assert.equal(first.author_name,"Setter A");
  assert.equal(first.body,"Nota su una discovery già fissata\nSeconda riga");
  assert.deepEqual(await add(lead,false,regularNote,first.body),first);
  await assert.rejects(() => add(lead,false,regularNote,"Testo diverso"),/già un salvataggio diverso/);
  await assert.rejects(() => add(lead,false,secondNote," \n\t "),/1 a 3000/);
  await add(lead,false,secondNote,"Nota seguente");
  assert.deepEqual((await get(lead)).map(note => note.id).sort(),[regularNote,secondNote].sort());
  assert.equal((await add(stock,true,stockNote,"Nota prima del passaggio")).body,"Nota prima del passaggio");
  assert.equal((await get(stock,true)).length,1);
  await assert.rejects(() => db.query("select * from public.setter_lead_notes"),/permission denied/);

  await actor(otherSetter);
  await assert.rejects(() => get(lead),/non accessibili/);
  await assert.rejects(() => add(stock,true,uuid(11),"Nota non autorizzata"),/non accessibile/);
  await actor(seller);
  await assert.rejects(() => get(stock,true),/non accessibili/);
  await actor(admin);
  assert.equal((await get(lead)).length,2);
  await assert.rejects(() => add(lead,false,uuid(12),"Nota del titolare"),/Solo il setter/);

  await db.exec("reset role");
  await db.query("update public.database_leads set lead_id=$1,handed_off_at=now() where id=$2",[lead,stock]);
  assert.equal(await scalar("select state from public.setter_assignments where lead_id=$1",[lead]),"booked");
  await db.exec("set role authenticated");
  await actor(setter);
  assert.deepEqual((await get(lead)).map(note => note.id).sort(),[regularNote,stockNote,secondNote].sort());
  await assert.rejects(() => add(stock,true,uuid(13),"Scheda precedente"),/Riapri la scheda/);
  await db.exec("reset role");
  assert.equal(await scalar("select has_function_privilege('anon','public.get_setter_lead_notes(uuid,uuid,boolean)','execute')"),false);
  console.log("SQL OK: note separate, retry, accesso del setter assegnato e storico preservato dopo il passaggio alla vendita");
} finally {
  await db.close();
}
