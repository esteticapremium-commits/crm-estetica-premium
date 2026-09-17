const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Impedisce che una richiesta di rete lasci una schermata in caricamento
 * all'infinito. Accetta anche i builder "thenable" di Supabase.
 */
export function withTimeout<T>(
  request: PromiseLike<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  message = "La richiesta sta impiegando troppo tempo. Controlla la connessione e riprova."
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(request).then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

