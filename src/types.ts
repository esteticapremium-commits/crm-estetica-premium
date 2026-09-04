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
  probability: number | null;
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

export interface LeadActivity {
  id: string;
  lead_id: string;
  client_id: string;
  activity_type: string;
  outcome: string | null;
  note: string | null;
  next_action_date: string | null;
  created_by: string | null;
  created_at: string;
}

export interface SalesTask {
  id: string;
  client_id: string;
  lead_id: string | null;
  title: string;
  description: string | null;
  due_at: string;
  assigned_to: string;
  created_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
}

export type PersonalTaskStatus = "backlog" | "next" | "doing" | "waiting" | "done";
export interface PersonalTask {
  id: string;
  owner_id: string;
  title: string;
  notes: string | null;
  status: PersonalTaskStatus;
  position: number;
  created_at: string;
  updated_at: string;
}

export type EditorialStatus = "idea" | "in_production" | "review" | "scheduled" | "published";

export interface EditorialContent {
  id: string;
  client_id: string;
  title: string;
  channel: string;
  format: string | null;
  status: EditorialStatus;
  scheduled_for: string | null;
  owner: string | null;
  pillar: string | null;
  cta: string | null;
  notes: string | null;
  asset_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contract {
  id: string;
  client_id: string;
  lead_id: string | null;
  template_id: string | null;
  client_fields: string | null;
  client_data: string | null;
  title: string;
  body: string | null;
  status: "draft" | "sent" | "signed";
  sign_token: string;
  sent_to: string | null;
  sent_at: string | null;
  signed_name: string | null;
  signature_data: string | null;
  signed_at: string | null;
  created_by: string | null;
  created_at: string;
  expires_at?: string | null;
  revoked_at?: string | null;
  revoked_by?: string | null;
  signed_document_hash?: string | null;
  viewed_at?: string | null;
  view_count?: number | null;
}

export interface ContractEvent {
  id: string;
  contract_id: string;
  action: string;
  actor: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface ContractTemplate {
  id: string;
  client_id: string;
  name: string;
  body: string | null;
  client_fields: string | null;
  created_at: string;
}
