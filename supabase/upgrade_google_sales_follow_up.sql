-- Follow-up calls after a closing keep their own appointment type.
-- Existing records, ownership and revenue permissions are unchanged.
begin;
alter table public.google_sales_appointments
  drop constraint if exists google_sales_appointments_appointment_type_check;
alter table public.google_sales_appointments
  add constraint google_sales_appointments_appointment_type_check
  check (appointment_type in ('discovery', 'demo', 'follow_up'));
commit;
