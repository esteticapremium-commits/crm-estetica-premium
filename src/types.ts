export type Role = "admin" | "venditore";

export interface Profile {
  id: string;
  role: Role;
  client_id: string | null;
  full_name: string | null;
}

export interface Client {
  id: string;
  name: string;
  ingest_token: string;
  ghl_pipeline_id: string | null;
  meta_page_id: string | null;
  meta_form_id: string | null;
  meta_ad_account_id: string | null;
  created_at: string;
}

export interface Pipeline {
  id: string;
  client_id: string;
  name: string;
  position: number;
  meta_form_id: string | null;
  meta_ad_account_id: string | null;
  created_at: string;
}

export interface Stage {
  id: string;
  client_id: string;
  pipeline_id: string;
  name: string;
  position: number;
  color: string | null;
  is_entry: boolean;
  ghl_stage_id: string | null;
}

export interface Lead {
  id: string;
  client_id: string;
  pipeline_id: string | null;
  stage_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  assigned_to: string | null;
  value: number | null;
  notes: string | null;
  next_action_date: string | null;
  closing_date: string | null;
  lost_reason: string | null;
  tags: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}
