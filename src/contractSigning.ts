export type ContractLinkState = "available" | "expired" | "revoked" | "not_found";

export function contractLinkMessage(state: unknown): string {
  if (state === "expired") return "Il link è scaduto. Chiedi a Estetica Premium un nuovo link per firmare.";
  if (state === "revoked") return "Questo link è stato disattivato. Contatta Estetica Premium per ricevere il documento aggiornato.";
  return "Il link non è valido o il documento non esiste. Controlla di aver aperto il link completo oppure contatta Estetica Premium.";
}

export function isVerifiedSignedContract(doc: {
  status?: string;
  signed_at?: string | null;
  signed_name?: string | null;
  signature_data?: string | null;
} | null | undefined): boolean {
  return Boolean(doc?.status === "signed" && doc.signed_at && doc.signed_name?.trim() && doc.signature_data?.startsWith("data:image/png;base64,"));
}
