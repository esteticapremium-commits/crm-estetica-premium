import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
const ep = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const admin = "00000000-0000-4000-8000-000000000003";
const regular = "00000000-0000-4000-8000-000000000004";
const applicant = "00000000-0000-4000-8000-000000000005";
const read = async (sql, values = []) => Object.values((await db.query(sql, values)).rows[0])[0];

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('fixture.uid',true),'')::uuid$$;
    create table auth.users(id uuid primary key,email text unique,raw_app_meta_data jsonb,raw_user_meta_data jsonb,deleted_at timestamptz);
    create table public.clients(id uuid primary key,name text);
    create table public.profiles(id uuid references auth.users primary key,role text,client_id uuid,full_name text);
    create function public.is_admin() returns boolean language sql stable security definer as
      $$select exists(select 1 from public.profiles where id=auth.uid() and role='admin')$$;
    insert into auth.users values ('${admin}','owner@example.test',null,null,null), ('${regular}','seller@example.test',null,null,null);
    insert into public.clients values ('${ep}','Estetica Premium'), ('${other}','Altro tenant');
    insert into public.profiles values ('${admin}','admin',null,'Titolare'), ('${regular}','venditore','${ep}','Venditore');
  `);
  const sql = readFileSync("supabase/upgrade_setter_registration.sql", "utf8");
  await db.exec(sql);
  await db.exec(sql);
  const actor = id => db.query("select set_config('fixture.uid',$1,false)", [id]);
  const portal = (action, id = null, clientId = ep) => read("select public.setter_registration_portal($1,$2,$3)",[clientId, action, id]);
  const submit = (link, name, email) => db.query("select public.submit_setter_registration($1,$2,$3)",[link,name,email]);
  const resolve = token => read("select public.resolve_setter_activation($1)", [token]);
  await db.exec("set role authenticated");
  await actor(regular);
  await assert.rejects(() => portal("read"), /non autorizzato/);
  await actor(admin);
  await assert.rejects(() => portal("new_link", null, other), /non autorizzato/);
  const first = (await portal("new_link")).link;
  const link = (await portal("new_link")).link;

  await db.exec("set role anon");
  await actor("");
  await assert.rejects(() => submit(first.id,"Setter candidato","user@example.test"),/non è valido/);
  await assert.rejects(() => submit(link.id,"Setter candidato","email non valida"),/indirizzo email/);
  await submit(link.id,"Setter candidato","User@Example.test");
  await submit(link.id,"Duplicato","user@example.test");
  await assert.rejects(() => portal("read"),/permission denied/);
  await assert.rejects(() => resolve(link.id),/permission denied/);
  await assert.rejects(() => db.query("select * from public.setter_registration_requests"),/permission denied/);

  await db.exec("set role authenticated");
  await actor(admin);
  const pending = (await portal("read")).requests;
  assert.equal(pending.length,1);
  assert.equal(pending[0].status,"pending");
  assert.equal(pending[0].email,"user@example.test");
  assert.ok(!("activation_hash" in pending[0]));
  const request = pending[0];
  const oldToken = (await portal("approve",request.id)).activation;
  const token = (await portal("approve",request.id)).activation;
  await db.exec("set role service_role");
  assert.equal(await resolve(oldToken),null);
  assert.deepEqual(await resolve(token),{id:request.id,email:request.email});
  await db.exec("reset role");
  assert.equal(await read("select count(*)::int from public.profiles where role='setter'"),0);

  const hash = await read("select encode(sha256(convert_to($1,'UTF8')),'hex')",[token]);
  const meta = JSON.stringify({ep_setter_request:request.id,ep_setter_activation:hash,provider:"email"});
  await db.query("insert into auth.users values ($1,'untrusted@example.test',null,$2,null)",[other,meta]);
  assert.equal(await read("select count(*)::int from public.profiles where role='setter'"),0);
  await assert.rejects(() => db.query("insert into auth.users values ($1,'wrong@example.test',$2,null,null)",[applicant,meta]),/non disponibile/);
  await db.query("insert into auth.users values ($1,$2,$3,null,null)",[applicant,request.email,meta]);
  assert.equal(await read("select role from public.profiles where id=$1 and client_id=$2",[applicant,ep]),"setter");
  assert.deepEqual(await read("select raw_app_meta_data from auth.users where id=$1",[applicant]),{provider:"email"});
  assert.equal(await resolve(token),null);
  assert.equal(await read("select status from public.setter_registration_requests where id=$1",[request.id]),"activated");
  console.log("SQL OK: richieste anonime isolate, approvazione admin, token privato a uso unico, creazione profilo Setter atomica");
} finally {
  await db.close();
}
