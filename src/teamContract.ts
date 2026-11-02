/** Team contracts retain their party roles in the shared signing and PDF flow. */
export function isTeamContract(body: string | null | undefined) {
  return /^ESTETICA PREMIUM\nACCORDO DI COLLABORAZIONE\nConsulente Telefonico\n/.test(body ?? "");
}
export const TEAM_FIELDS = ["Nome e cognome", "Luogo di nascita", "Data di nascita", "Residenza", "Codice fiscale", "Partita IVA", "Luogo di firma"];
export const TEAM_DEPARTMENTS = ["sales", "marketing", "delivery"] as const;
export type TeamDepartment = typeof TEAM_DEPARTMENTS[number];

export const TEAM_FISCAL_FIELD = "Partita IVA oppure codice fiscale";
/** Format check only; does not determine the collaborator's fiscal regime. */
export function teamFiscalError(fields: string[], values: Record<string, string>): string | null {
  if (fields.includes(TEAM_FISCAL_FIELD)) {
    const value = (values[TEAM_FISCAL_FIELD] || "").trim().toUpperCase();
    return /^(?:\d{11}|[A-Z0-9]{16})$/.test(value)
      ? null : "Inserisci una Partita IVA di 11 cifre oppure un codice fiscale di 16 caratteri.";
  }
  return /^\d{11}$/.test((values["Partita IVA"] || "").trim())
    ? null : "Inserisci la Partita IVA corretta del consulente: 11 cifre.";
}
