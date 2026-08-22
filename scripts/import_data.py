#!/usr/bin/env python3
"""
Importa i dati nel NUOVO progetto Supabase di Estetica Premium.

Uso:
  SUPABASE_URL=https://XXXX.supabase.co \
  SUPABASE_SERVICE_KEY=<service_role> \
  CSV=~/crm-backups/ghl-opportunities-*.csv \
  python3 scripts/import_data.py

Crea: stage (8, incluso CLOSED), 163 lead con tutte le note,
account auth per Giovanni e per l'admin.
Idempotente: si può rilanciare, non duplica.
"""
import csv, json, os, re, subprocess, sys, urllib.request

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_KEY"]
CSV_PATH = os.environ.get("CSV") or "/Users/ettoreandrosoni/Downloads/opportunities (29).csv"
BASE = URL + "/rest/v1"

# password iniziali (da cambiare al primo accesso)
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "nocode.ector@gmail.com")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "Estetika!2026")
GIOV_EMAIL = os.environ.get("GIOV_EMAIL", "estetika017@gmail.com")
GIOV_PASS = os.environ.get("GIOV_PASS", "Estetika!2026")

H = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json",
     "Prefer": "return=representation"}

def api(method, path, data=None):
    req = urllib.request.Request(BASE + path, method=method, headers=H)
    body = json.dumps(data).encode() if data is not None else None
    try:
        with urllib.request.urlopen(req, body) as r:
            return json.loads(r.read() or b"[]")
    except urllib.error.HTTPError as e:
        print("ERRORE", method, path, e.code, e.read().decode()[:500])
        sys.exit(1)

# 1) clienti: trova Estetica Premium
cli = api("GET", "/clients?name=eq.Estetica%20Premium&select=id")
if not cli:
    cli = api("POST", "/clients", {"name": "Estetica Premium"})
CID = cli[0]["id"]
print("Cliente:", CID)

pipe = api("GET", f"/pipelines?client_id=eq.{CID}&select=id")
PID = pipe[0]["id"]

# 2) stage (ordine della pipeline GHL, CLOSED per ultimo)
STAGES = [
    ("NO ANSWER", 1, "#0f172a"),
    ("RECALL", 2, "#b45309"),
    ("DISCOVERY", 3, "#1d4ed8"),
    ("SETTING", 4, "#7c3aed"),
    ("NO SHOW", 5, "#be123c"),
    ("CLOSING", 6, "#0d9488"),
    ("LOST", 7, "#6b7280"),
    ("CLOSED", 8, "#16a34a"),
]
ex = api("GET", f"/stages?client_id=eq.{CID}&select=id,name")
exnames = {s["name"] for s in ex}
stage_map = {}
for name, pos, color in STAGES:
    if name in exnames:
        stage_map[name] = [s["id"] for s in ex if s["name"] == name][0]
    else:
        s = api("POST", "/stages", {
            "client_id": CID, "pipeline_id": PID, "name": name,
            "position": pos, "color": color, "is_entry": pos == 1})
        stage_map[name] = s[0]["id"]
print("Stage pronti:", list(stage_map.keys()))

# 3) lead dal CSV (salta il lead "Giovanni", test del venditore)
rows = [r for r in csv.DictReader(open(CSV_PATH, encoding="utf-8-sig"))
        if (r["Nome del contatto"] or "").strip().lower() != "giovanni"
        or (r["email"] or "").strip().lower() != "estetika017@gmail.com"]
print("Lead da importare:", len(rows))

def norm(s): return re.sub(r"\s+", " ", (s or "")).strip().lower()

existing = api("GET", f"/leads?client_id=eq.{CID}&select=ghl_opportunity_id")
have = {l["ghl_opportunity_id"] for l in existing if l.get("ghl_opportunity_id")}
batch = []
for r in rows:
    gid = r["ID opportunità"].strip()
    if gid in have:
        continue
    nota = (r["Note"] or "").strip()
    reply = (r["Risposta Instantly Outreach"] or "").strip()
    parti = [nota] if nota else []
    if reply:
        parti.append("=== RISPOSTA ALLA COLD EMAIL ===\n" + reply)
    batch.append({
        "client_id": CID, "pipeline_id": PID,
        "stage_id": stage_map[r["fase"].strip()],
        "name": (r["Nome del contatto"] or r["Nome opportunità"] or "").strip(),
        "phone": (r["telefono"] or "").strip(),
        "email": (r["email"] or "").strip(),
        "source": (r["fonte"] or "Instantly").strip(),
        "assigned_to": (r["assegnata"] or "").strip(),
        "value": (r["Valore di lead"] or "0").strip(),
        "notes": "\n\n".join(parti),
        "ghl_opportunity_id": gid,
        "ghl_contact_id": (r["ID contatto"] or "").strip(),
        "created_at": r["Creato il"] or None,
    })
print("Nuovi da inserire:", len(batch))
for i in range(0, len(batch), 50):
    api("POST", "/leads", batch[i:i + 50])
    print(f"  inseriti {min(i + 50, len(batch))}/{len(batch)}")

# 4) account auth: Giovanni (venditore) + admin
auth = URL + "/auth/v1/admin/users"
def create_user(email, password, role, client_id, full_name):
    req = urllib.request.Request(auth, method="POST", headers=H,
                                 data=json.dumps({"email": email, "password": password,
                                                  "email_confirm": True}).encode())
    try:
        with urllib.request.urlopen(req) as r:
            u = json.loads(r.read())
    except urllib.error.HTTPError as e:
        err = json.loads(e.read() or b"{}")
        if "already been registered" in err.get("msg", "") or err.get("code") == 422:
            # utente già esistente: lo cerca
            req2 = urllib.request.Request(auth + "?per_page=100", headers=H)
            with urllib.request.urlopen(req2) as r2:
                users = json.loads(r2.read()).get("users", [])
            u = next((x for x in users if x.get("email") == email), None)
            if not u:
                print("Utente", email, "non trovato"); return
        else:
            print("ERR utente", email, err); return
    uid = u["id"]
    prof = api("GET", f"/profiles?id=eq.{uid}&select=id")
    if not prof:
        api("POST", "/profiles", {"id": uid, "role": role,
                                  "client_id": client_id, "full_name": full_name})
        print(f"Profilo {role} creato: {email}")
    else:
        print(f"Profilo già esistente: {email}")

create_user(GIOV_EMAIL, GIOV_PASS, "venditore", CID, "Giovanni D'agosta")
create_user(ADMIN_EMAIL, ADMIN_PASS, "admin", None, "Titolare")

total = api("GET", f"/leads?client_id=eq.{CID}&select=id")
print("\nFATTO. Lead totali:", len(total))
