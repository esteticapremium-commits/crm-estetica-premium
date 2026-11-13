-- Eseguire SOLO dopo upgrade_lead_sequences.sql e deploy delle Edge Function.
-- Prepara in Supabase Vault (interfaccia dashboard):
-- sequence_runner_url = https://<progetto>.supabase.co/functions/v1/sequence-runner
-- sequence_runner_secret = stesso valore di SEQUENCE_RUNNER_SECRET
-- Non inserire segreti nel repository. SEQUENCE_LIVE=false mantiene gli invii bloccati.
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
 if not exists(select 1 from vault.decrypted_secrets where name='sequence_runner_url') or
 not exists(select 1 from vault.decrypted_secrets where name='sequence_runner_secret') then
 raise exception 'Configurare prima URL e segreto in Vault'; end if;
 if exists(select 1 from cron.job where jobname='lead-sequences-runner') then perform cron.unschedule('lead-sequences-runner'); end if;
end $$;
select cron.schedule('lead-sequences-runner','* * * * *',$cron$
 select net.http_post(
 url := (select decrypted_secret from vault.decrypted_secrets where name='sequence_runner_url' limit 1),
 headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='sequence_runner_secret' limit 1)),
 body := '{}'::jsonb, timeout_milliseconds := 120000
 );
$cron$);
