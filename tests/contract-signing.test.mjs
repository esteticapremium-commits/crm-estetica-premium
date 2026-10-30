import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function compile(source, modules, globals = {}) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: (name) => modules[name], console, ...globals });
  return exports;
}

const helpers = compile(readFileSync(new URL('../src/contractSigning.ts', import.meta.url), 'utf8'), {});
const signed = { status: 'signed', signed_name: 'Cliente', signed_at: '2026-10-16T09:00:00Z', signature_data: 'data:image/png;base64,AAAA', body: '', client_data: '{}', client_fields: '' };

test('la copia firmata richiede stato, nome, data e immagine salvati', () => {
  assert.equal(helpers.isVerifiedSignedContract(signed), true);
  for (const field of ['signed_name', 'signed_at', 'signature_data']) {
    assert.equal(helpers.isVerifiedSignedContract({ ...signed, [field]: null }), false);
  }
  assert.equal(helpers.isVerifiedSignedContract({ ...signed, status: 'sent' }), false);
});

test('link scaduto, revocato e inesistente hanno messaggi distinti', () => {
  assert.match(helpers.contractLinkMessage('expired'), /scaduto/);
  assert.match(helpers.contractLinkMessage('revoked'), /disattivato/);
  assert.match(helpers.contractLinkMessage('not_found'), /non è valido/);
});

// Esegue le vere funzioni del componente senza montare la UI o contattare
// produzione. Solo il return JSX viene sostituito con un'interfaccia di test.
function signingHarness(rpc) {
  const state = [], refs = [];
  let stateIndex = 0, refIndex = 0;
  const react = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef(initial) {
      const index = refIndex++;
      return refs[index] ??= { current: initial };
    },
    useEffect() {},
  };
  const source = readFileSync(new URL('../src/pages/FirmaPage.tsx', import.meta.url), 'utf8')
    .replace('return (\n    <div className="firma-page">', 'return { sign, verifySignature, setDoc, setName, setValues, canvasRef, hasInk, setupCanvas, down, move, endPointer, clear, ok, busy, err, confirmationPending, doc };\n  return (\n    <div className="firma-page">');
  const component = compile(source, {
    react,
    '../supabaseClient': { supabase: { rpc } },
    '../contractSigning': helpers,
    '../contractPdf': { isPrivateDeed: () => false, fillBody: () => '', splitContractClosing: () => ({ main: '', approval: '' }) },
  }, { window: { devicePixelRatio: 2 } }).default;
  const render = () => { stateIndex = refIndex = 0; return component({ token: 'test-token' }); };
  let api = render();
  api.setDoc({ ...signed, status: 'sent', signature_data: null });
  api.setName('Cliente');
  api.canvasRef.current = { toDataURL: () => signed.signature_data };
  api.hasInk.current = true;
  return render;
}

test('RPC false non produce una falsa conferma', async () => {
  const render = signingHarness(async (name) => name === 'sign_contract'
    ? { data: false, error: null }
    : { data: [{ ...signed, status: 'sent' }], error: null });
  await render().sign();
  assert.equal(render().ok, false);
  assert.match(render().err, /non risulta registrata/);
});

test('RPC true senza rilettura verificata resta in attesa, senza fallback locale', async () => {
  const render = signingHarness(async (name) => name === 'sign_contract'
    ? { data: true, error: null }
    : { data: null, error: { message: 'network' } });
  await render().sign();
  assert.equal(render().ok, false);
  assert.equal(render().confirmationPending, true);
  assert.equal(render().doc.signature_data, null);
});

test('solo la copia firmata riletta dal database abilita il successo', async () => {
  const render = signingHarness(async (name) => name === 'sign_contract'
    ? { data: true, error: null } : { data: [signed], error: null });
  await render().sign();
  assert.equal(render().ok, true);
  assert.equal(render().doc.signed_at, signed.signed_at);
});

test('errori tecnici non vengono esposti e un nuovo invio attende la verifica', async () => {
  let calls = 0;
  const render = signingHarness(async () => { calls++; return { data: null, error: { message: 'function digest(text, unknown) does not exist' } }; });
  await render().sign();
  assert.doesNotMatch(render().err, /digest/);
  await render().sign();
  assert.equal(calls, 1);
  assert.equal(render().busy, false);
});

test('risposta persa recuperabile con verifica successiva, senza seconda firma', async () => {
  let signCalls = 0;
  const render = signingHarness(async (name) => {
    if (name === 'sign_contract') { signCalls++; throw new Error('network'); }
    return { data: [signed], error: null };
  });
  await render().sign();
  assert.equal(render().confirmationPending, true);
  await render().verifySignature();
  assert.equal(render().ok, true);
  assert.equal(signCalls, 1);
});

test('popup PDF bloccato restituisce false e chiama il messaggio della pagina', () => {
  const pdf = compile(readFileSync(new URL('../src/contractPdf.ts', import.meta.url), 'utf8'), {}, {
    window: { location: { origin: 'https://test.invalid' }, open: () => null },
  });
  let blocked = 0;
  assert.equal(pdf.openSignedContractPdf({ ...signed, title: 'Contratto' }, { onBlocked: () => blocked++ }), false);
  assert.equal(blocked, 1);
});

test('apertura PDF riuscita mantiene impaginazione e firma nel documento', () => {
  let html = '';
  const pdf = compile(readFileSync(new URL('../src/contractPdf.ts', import.meta.url), 'utf8'), {}, {
    window: { location: { origin: 'https://test.invalid' }, open: () => ({ document: { open() {}, write(value) { html = value; }, close() {} } }) },
  });
  assert.equal(pdf.openSignedContractPdf({ ...signed, title: 'Contratto' }), true);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.match(html, /window.print/);
});

test('date italiane stabili oltre la mezzanotte UTC e al cambio di ora', () => {
  const pdf = compile(readFileSync(new URL('../src/contractPdf.ts', import.meta.url), 'utf8'), {});
  assert.equal(pdf.contractSignatureDate('2026-10-28T23:30:00Z'), '29/10/2026');
  assert.equal(pdf.contractSignatureDate('2026-07-01T22:30:00Z'), '02/07/2026');
  assert.equal(pdf.contractSignatureDate(null), '');
  assert.equal(pdf.contractSignatureDate('invalid'), '');
});

test('PDF: tutti i campi compilati, caratteri speciali, data originale e firma anche specifica', () => {
  let html = '';
  const pdf = compile(readFileSync(new URL('../src/contractPdf.ts', import.meta.url), 'utf8'), {}, {
    window: { location: { origin: 'https://test.invalid' }, open: () => ({ document: { open() {}, write(value) { html = value; }, close() {} } }) },
  });
  const values = { 'Ragione sociale del committente': 'Centro & Benessere <test>', 'Sede legale': 'Via Città 1', 'PEC': 'test@pec.example' };
  pdf.openSignedContractPdf({ ...signed, signed_at: '2026-10-28T23:30:00Z', title: '<Titolo>', client_fields: Object.keys(values).join('\n'), client_data: JSON.stringify(values), body: 'Cliente {{ragione_sociale_del_committente}}; sede {{sede_legale}}; PEC {{pec}}\n\nAi sensi degli artt. 1341 e 1342 il cliente approva specificamente le clausole.' });
  assert.doesNotMatch(html, /\{\{|<Titolo>|Centro & Benessere <test>/);
  assert.match(html, /Centro &amp; Benessere &lt;test&gt;/);
  assert.match(html, /Via Città 1/);
  assert.match(html, /test@pec.example/);
  assert.match(html, /29\/10\/2026/);
  assert.equal((html.match(/data:image\/png;base64,AAAA/g) ?? []).length, 2);
});

test('PDF non interpola markup nell’immagine della firma', () => {
  let html = '';
  const pdf = compile(readFileSync(new URL('../src/contractPdf.ts', import.meta.url), 'utf8'), {}, {
    window: { location: { origin: 'https://test.invalid' }, open: () => ({ document: { open() {}, write(value) { html = value; }, close() {} } }) },
  });
  pdf.openSignedContractPdf({ ...signed, title: 'Test', signature_data: 'x" onerror="alert(1)' });
  assert.doesNotMatch(html, /onerror/);
});


test('nome e disegno restano necessari anche con dati aziendali facoltativi', async () => {
  let calls = 0;
  const render = signingHarness(async () => { calls++; return { data: true, error: null }; });
  render().setName('   ');
  await render().sign();
  assert.match(render().err, /nome e cognome/);
  render().setName('Cliente');
  render().setDoc({ ...signed, status: 'sent', client_fields: 'PEC' });
  render().hasInk.current = false;
  await render().sign();
  assert.match(render().err, /Disegna la firma/);
  assert.equal(calls, 0);
});

test('i dati e la firma inviati sono quelli compilati dal cliente', async () => {
  let payload;
  const render = signingHarness(async (name, args) => {
    if (name === 'sign_contract') { payload = args; return { data: true, error: null }; }
    return { data: [signed], error: null };
  });
  render().setDoc({ ...signed, status: 'sent', client_fields: 'PEC' });
  render().setValues({ PEC: 'test@pec.example' });
  render().setName('  Cliente Test  ');
  await render().sign();
  assert.equal(payload.p_name, 'Cliente Test');
  assert.equal(payload.p_sig, signed.signature_data);
  assert.equal(JSON.parse(payload.p_data).PEC, 'test@pec.example');
});

function drawingHarness() {
  const render = signingHarness(async () => ({ data: false }));
  const listeners = {}, strokes = [];
  const ctx = { scale() {}, getTransform: () => ({ a: 2, d: 2 }),
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo: (x, y) => strokes.push([x, y]), stroke() {} };
  const canvas = { clientWidth: 400, width: 0, height: 0, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 80 }),
    addEventListener: (name, handler, options) => { assert.equal(options.passive, false); listeners[name] = handler; },
    setPointerCapture() { throw new Error('capture unsupported'); } };
  render().hasInk.current = false;
  render().setupCanvas(canvas);
  const touch = (type, x, y, identifier = 1) => {
    let prevented = false;
    listeners[type]({ type, changedTouches: [{ identifier, clientX: x, clientY: y }], preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  };
  return { render, touch, strokes };
}

test('touch mobile disegna con coordinate corrette anche dopo resize e salva la presenza di inchiostro', () => {
  const { render, touch, strokes } = drawingHarness();
  touch('touchstart', 10, 10);
  assert.equal(render().hasInk.current, false);
  touch('touchmove', 30, 20);
  assert.deepEqual(strokes[0], [60, 40]);
  assert.equal(render().hasInk.current, true);
  touch('touchend', 40, 25);
  render().clear();
  assert.equal(render().hasInk.current, false);
});

test('pointercancel touch non interrompe la firma nativa; secondo dito ignorato', () => {
  const { render, touch, strokes } = drawingHarness();
  touch('touchstart', 10, 10);
  render().endPointer({ pointerType: 'touch' });
  touch('touchmove', 20, 20, 2);
  assert.equal(strokes.length, 0);
  touch('touchmove', 20, 20);
  assert.equal(render().hasInk.current, true);
  touch('touchcancel', 20, 20);
  const count = strokes.length;
  touch('touchmove', 40, 40);
  assert.equal(strokes.length, count);
});

test('mouse continua a disegnare anche se setPointerCapture fallisce', () => {
  const { render, strokes } = drawingHarness();
  render().down({ pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, pointerId: 1, preventDefault() {} });
  render().move({ pointerType: 'mouse', clientX: 30, clientY: 20 });
  assert.equal(strokes.length, 1);
  assert.equal(render().hasInk.current, true);
});

test('browser mobile con soli Pointer Events: il dito disegna senza Touch Events', () => {
  const { render, strokes } = drawingHarness();
  render().down({ pointerType: 'touch', button: 0, clientX: 10, clientY: 10, pointerId: 1, preventDefault() {} });
  render().move({ pointerType: 'touch', clientX: 30, clientY: 20 });
  assert.equal(strokes.length, 1);
  assert.equal(render().hasInk.current, true);
  render().endPointer({ pointerType: 'touch' });
  render().move({ pointerType: 'touch', clientX: 40, clientY: 30 });
  assert.equal(strokes.length, 1);
});

test('dati aziendali vuoti non bloccano la firma e non vengono inventati', async () => {
  let payload;
  const render = signingHarness(async (name, args) => {
    if (name === 'sign_contract') { payload = args; return { data: true, error: null }; }
    return { data: [signed], error: null };
  });
  render().setDoc({ ...signed, status: 'sent', client_fields: 'PEC\nPartita IVA\nSede legale' });
  render().setValues({});
  await render().sign();
  assert.equal(render().ok, true);
  assert.equal(JSON.parse(payload.p_data).PEC, undefined);
});
