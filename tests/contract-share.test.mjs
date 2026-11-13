import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/contract-share.js';

test('share metadata uses the actual title, escapes HTML, and opens the same signing token', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {...process.env};
  const token = '3dd57bc1-946a-4354-bc4a-76dca62f3ab0';
  const response = () => ({headers:{}, setHeader(k,v){this.headers[k]=v;}, status(v){this.code=v;return this;}, send(v){this.body=v;return this;}});
  let calls = 0;
  process.env.VITE_SUPABASE_URL='https://example.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY='public-test-key';
  try {
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url,'https://example.supabase.co/rest/v1/rpc/get_contract_by_token?select=title');
      assert.deepEqual(JSON.parse(init.body),{p_token:token});
      return {ok:true,json:async()=>[{title:'Setter — Elisabetta <script> & "test"',body:'PRIVATE BODY',signature_data:'PRIVATE SIGNATURE'}]};
    };
    const res = response();
    await handler({method:'GET',query:{token}},res);
    assert.equal(res.code,200);
    assert.ok(res.body.includes('content="Setter — Elisabetta &lt;script&gt; &amp; &quot;test&quot;"'));
    assert.ok(res.body.includes(`window.location.replace("/#/firma/${token}")`));
    assert.ok(res.body.includes('og:image'));
    assert.ok(!res.body.includes('PRIVATE'));
    assert.ok(!res.body.includes('record_contract_view'));
    assert.equal(res.headers['Cache-Control'],'private, no-store');
    const invalid=response();
    await handler({method:'GET',query:{token:'bad-token'}},invalid);
    assert.equal(invalid.code,404); assert.equal(calls,1);
    globalThis.fetch = async () => ({ok:true,json:async()=>[]});
    const revoked=response();
    await handler({method:'GET',query:{token}},revoked);
    assert.equal(revoked.code,404); assert.ok(!revoked.body.includes('Elisabetta'));
    globalThis.fetch = async () => {throw new Error('offline');};
    const unavailable=response();
    await handler({method:'GET',query:{token}},unavailable);
    assert.equal(unavailable.code,503);
  } finally {
    globalThis.fetch=previousFetch;
    for(const key of ['VITE_SUPABASE_URL','VITE_SUPABASE_ANON_KEY']) {
      if(previousEnv[key]===undefined) delete process.env[key]; else process.env[key]=previousEnv[key];
    }
  }
});
