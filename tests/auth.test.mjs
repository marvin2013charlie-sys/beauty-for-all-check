import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

test('PIN authentication, roles, expiry, throttling and logout',async t => {
  const dataDir = await mkdtemp(join(tmpdir(),'bfa-auth-test-'));
  let time = Date.now();
  const server = await createApp({dataDir,suppliedPins:{admin:'0937',staff:'5826'},now:() => time});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir,{recursive:true,force:true}); });
  const get = (path,cookie) => fetch(base+path,{redirect:'manual',headers:cookie ? {Cookie:cookie} : {}});
  const login = (role,pin,extraHeaders={}) => fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',...extraHeaders},body:JSON.stringify({role,pin})});
  let adminCookie, staffCookie;
  await t.test('public login has two separate four-digit forms and private files are inaccessible',async () => {
    const html = await (await get('/')).text();
    assert.match(html,/data-login="admin"/); assert.match(html,/data-login="staff"/);
    assert.equal((html.match(/class="pin-input"/g)||[]).length,8);
    assert.equal((await get('/.local/credentials.json')).status,404);
    assert.equal((await get('/.local/LOCAL_ACCESS.txt')).status,404);
    assert.equal((await get('/server.mjs')).status,404);
    assert.equal((await get('/admin')).status,303);
    const stored = await readFile(join(dataDir,'credentials.json'),'utf8');
    assert.ok(!stored.includes('"0937"') && !stored.includes('"5826"'));
  });
  await t.test('malformed, incorrect, cross-role and cross-origin requests are rejected',async () => {
    for (const pin of ['123','12345','abcd']) assert.equal((await login('admin',pin)).status,400);
    assert.equal((await login('owner','0937')).status,400);
    assert.equal((await login('admin','5826')).status,401);
    assert.equal((await login('staff','0937')).status,401);
    assert.equal((await login('admin','0937',{Origin:'https://example.com'})).status,403);
  });
  await t.test('both roles sign in and authorization is checked by the server',async () => {
    const admin = await login('admin','0937'); assert.equal(admin.status,200);
    adminCookie = admin.headers.get('set-cookie').split(';')[0];
    assert.match(admin.headers.get('set-cookie'),/HttpOnly/); assert.match(admin.headers.get('set-cookie'),/SameSite=Strict/);
    assert.equal((await admin.json()).redirect,'/admin');
    const staff = await login('staff','5826'); assert.equal(staff.status,200);
    staffCookie = staff.headers.get('set-cookie').split(';')[0];
    assert.equal((await staff.json()).redirect,'/staff');
    assert.equal((await get('/admin',adminCookie)).status,200);
    assert.equal((await get('/admin/design',adminCookie)).status,303);
    assert.equal((await get('/staff',staffCookie)).status,200);
    assert.equal((await get('/admin',staffCookie)).status,403);
    assert.equal((await get('/reference/Dashboard.dc.html',staffCookie)).status,404);
    assert.equal((await get('/staff',adminCookie)).status,200);
  });
  await t.test('logout invalidates the server session',async () => {
    const response = await fetch(base+'/api/logout',{method:'POST',headers:{'Content-Type':'application/json',Cookie:adminCookie},body:'{}'});
    assert.equal(response.status,200);
    assert.equal((await get('/api/session',adminCookie)).status,401);
  });
  await t.test('repeated incorrect PINs are limited, recover after cooldown, and sessions expire',async () => {
    for(let i=0;i<5;i++) assert.equal((await login('admin','0000')).status,401);
    const locked = await login('admin','0937'); assert.equal(locked.status,429); assert.equal(locked.headers.get('retry-after'),'30');
    time += 31000; assert.equal((await login('admin','0937')).status,200);
    time += 4*60*60*1000; assert.equal((await get('/api/session',staffCookie)).status,401);
  });
  await t.test('Render https sign-in is accepted and the cookie is Secure',async () => {
    process.env.RENDER = 'true';
    try {
      const port = server.address().port;
      const ok = await login('admin','0937',{Origin:`https://127.0.0.1:${port}`,'X-Forwarded-Proto':'https'});
      assert.equal(ok.status,200);
      assert.match(ok.headers.get('set-cookie'),/Secure/);
      assert.equal((await login('admin','0937',{Origin:`http://127.0.0.1:${port}`,'X-Forwarded-Proto':'https'})).status,403);
    } finally {
      delete process.env.RENDER;
    }
  });
});
