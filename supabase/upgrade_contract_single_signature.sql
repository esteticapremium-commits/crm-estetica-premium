-- Una sola firma grafica del Committente viene richiamata anche nel blocco
-- di approvazione specifica. Aggiorna i modelli già salvati nel gestionale.
update public.contract_templates
set body = regexp_replace(
  body,
  E'Firma specifica del Committente:[^\\n\\r]*',
  '',
  'gi'
)
where body ~* 'Firma specifica del Committente:';

-- Rimuove anche la frase transitoria eventualmente salvata durante
-- l'aggiornamento: il richiamo viene mostrato nel riquadro strutturato.
update public.contract_templates
set body = regexp_replace(
  body,
  E'La firma del Committente apposta nel presente documento si riferisce anche alla presente approvazione specifica\\.\\s*',
  '',
  'gi'
)
where body ~* 'La firma del Committente apposta nel presente documento';
