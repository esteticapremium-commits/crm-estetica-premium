/** Team contracts retain their party roles in the shared signing and PDF flow. */
export function isTeamContract(body: string | null | undefined) {
  return /^ESTETICA PREMIUM\nACCORDO DI COLLABORAZIONE\nConsulente Telefonico\n/.test(body ?? "");
}
export const TEAM_FIELDS = ["Nome e cognome", "Luogo di nascita", "Data di nascita", "Residenza", "Codice fiscale", "Partita IVA", "Luogo di firma"];
export const TEAM_DEPARTMENTS = ["sales", "marketing", "delivery"] as const;
export type TeamDepartment = typeof TEAM_DEPARTMENTS[number];
