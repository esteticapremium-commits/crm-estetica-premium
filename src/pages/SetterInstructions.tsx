import { useRef, useState } from "react";
import { withTimeout } from "../async";
import { supabase } from "../supabaseClient";

export default function SetterInstructions({ clientId, small = false }: { clientId: string; small?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const loading = useRef(false);
  const [script, setScript] = useState("");
  const [error, setError] = useState("");

  async function load() {
    if (loading.current || script) return;
    loading.current = true;
    setError("");
    try {
      const { data, error } = await withTimeout(supabase.rpc("get_setter_instructions", { p_client_id: clientId }));
      if (error || typeof data !== "string" || !data.trim()) throw new Error("Istruzioni non disponibili.");
      setScript(data);
    } catch {
      setError("Non è stato possibile caricare le istruzioni.");
    } finally {
      loading.current = false;
    }
  }

  function open() {
    dialog.current?.showModal();
    if (script && dialog.current) dialog.current.scrollTop = 0;
    void load();
  }

  return <>
    <button className={small ? "btn small" : "btn"} type="button" aria-haspopup="dialog" onClick={open}>Istruzioni</button>
    <dialog ref={dialog} className="setter-instructions" aria-label="Istruzioni Setter">
      <header>
        <h2>Istruzioni Setter</h2>
        <button className="btn" type="button" onClick={() => dialog.current?.close()}>Chiudi</button>
      </header>
      <div className="setter-instruction-text">
        {error ? <div role="alert"><p>{error}</p><button className="btn" type="button" onClick={() => void load()}>Riprova</button></div>
          : script ? script.split("\n\n").map((paragraph, index) => paragraph.startsWith("**") && paragraph.endsWith("**")
            ? <h3 key={index}>{paragraph.slice(2, -2)}</h3>
            : <p key={index}>{paragraph}</p>)
          : <p role="status">Caricamento istruzioni…</p>}
      </div>
    </dialog>
  </>;
}
