/** Team contracts retain their party roles in the shared signing and PDF flow. */
export function isTeamContract(body: string | null | undefined) {
  return /^ESTETICA PREMIUM\nACCORDO DI COLLABORAZIONE\nConsulente Telefonico\n/.test(body ?? "");
}
export const TEAM_FIELDS = ["Nome e cognome", "Luogo di nascita", "Data di nascita", "Residenza", "Codice fiscale", "Partita IVA", "Luogo di firma"];
export const TEAM_DEPARTMENTS = ["sales", "marketing", "delivery"] as const;
export type TeamDepartment = typeof TEAM_DEPARTMENTS[number];

export const TEAM_FISCAL_FIELD = "Partita IVA oppure codice fiscale";
export const TEAM_TAX_CODE_FIELD = "Codice fiscale";

export function teamFiscalField(fields: string[]) {
  if (fields.includes(TEAM_FISCAL_FIELD)) return TEAM_FISCAL_FIELD;
  if (fields.includes(TEAM_TAX_CODE_FIELD) && !fields.includes("Partita IVA")) return TEAM_TAX_CODE_FIELD;
  return "Partita IVA";
}
/** Format check only; does not determine the collaborator's fiscal regime. */
export function teamFiscalError(fields: string[], values: Record<string, string>): string | null {
  const field = teamFiscalField(fields);
  const value = (values[field] || "").trim().toUpperCase();
  if (field === TEAM_TAX_CODE_FIELD) {
    return /^[A-Z0-9]{16}$/.test(value) ? null : "Inserisci il codice fiscale di 16 caratteri.";
  }
  if (field === TEAM_FISCAL_FIELD) {
    return /^(?:\d{11}|[A-Z0-9]{16})$/.test(value)
      ? null : "Inserisci una Partita IVA di 11 cifre oppure un codice fiscale di 16 caratteri.";
  }
  return /^\d{11}$/.test(value)
    ? null : "Inserisci la Partita IVA corretta del consulente: 11 cifre.";
}
