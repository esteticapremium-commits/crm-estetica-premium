// Edge Function "admin-user" — gestione utenti del CRM Estetica Premium.
// Solo l'ADMIN autenticato può usarla: la service role vive SOLO qui
// (segreto lato server), mai nel frontend.
//
// Azioni: list_users, create_venditore, set_password, delete_user.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return json({ error: "Variabili d'ambiente mancanti." }, 500);
  }

  // 1) Chi sta chiamando? (con la chiave anon, come farebbe l'app)
  const authHeader = req.headers.get("Authorization") ?? "";
  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return json({ error: "Non autenticato" }, 401);

  // 2) Solo admin
  const { data: profile } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return json({ error: "Solo l'amministratore può gestire gli accessi." }, 403);
  }

  // 3) Operazioni con la service role (lato server)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido." }, 400);
  }

  switch (body.action) {
    case "list_users": {
      const { data: users, error } = await admin.auth.admin.listUsers({ perPage: 200 });
      if (error) return json({ error: error.message }, 500);
      const { data: profiles } = await admin.from("profiles").select("id, role, client_id, full_name");
      const pmap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const out = (users?.users ?? []).map((u) => {
        const p = pmap.get(u.id);
        return {
          id: u.id,
          email: u.email,
          role: p?.role ?? "venditore",
          client_id: p?.client_id ?? null,
          full_name: p?.full_name ?? null,
        };
      });
      return json({ users: out });
    }
    case "create_venditore": {
      const email = String(body.email ?? "").trim();
      const password = String(body.password ?? "");
      const clientId = (body.client_id as string) ?? null;
      const fullName = body.full_name ? String(body.full_name).trim() : null;
      if (!email || !password || !clientId) {
        return json({ error: "Compila email, password e cliente." }, 400);
      }
      const { data: u, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) return json({ error: error.message }, 400);
      const { error: perr } = await admin.from("profiles").insert({
        id: u.user.id,
        role: "venditore",
        client_id: clientId,
        full_name: fullName,
      });
      if (perr) return json({ error: perr.message }, 500);
      return json({ ok: true, user_id: u.user.id });
    }
    case "set_password": {
      const userId = body.user_id as string;
      const password = String(body.password ?? "");
      if (!userId || !password) return json({ error: "Dati mancanti." }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    case "delete_user": {
      const userId = body.user_id as string;
      if (!userId) return json({ error: "Dati mancanti." }, 400);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    default:
      return json({ error: "Azione sconosciuta." }, 400);
  }
});
