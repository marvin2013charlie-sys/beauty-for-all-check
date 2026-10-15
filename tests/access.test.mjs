import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailConfig, sendSmtp, validDob } from '../access.mjs';
import { createApp } from '../server.mjs';

const profile = { name: 'Ada Lovelace', email: 'owner@example.com', dob: '1990-04-12' };

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
function cookieOf(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

test('mailbox settings reject port 25 and keep a saved password', () => {
  assert.throws(() => mailConfig({ enabled: true, host: 'smtp.example.com', port: 25, username: 'salon', password: 'secret', from: 'desk@example.com' }), /465 or 587/);
  const saved = mailConfig({ enabled: true, host: 'smtp.example.com', port: '587', username: 'salon', password: '', from: 'Desk@Example.com' }, { password: 'kept-secret' });
  assert.equal(saved.password, 'kept-secret');
  assert.equal(saved.port, 587);
  assert.equal(saved.from, 'desk@example.com');
  assert.equal(validDob('2026-10-08', Date.parse('2026-10-07T11:00:00Z')), false);
  assert.equal(validDob('2026-02-31', Date.parse('2026-10-07T11:00:00Z')), false);
  assert.equal(validDob('1899-01-01', Date.parse('2026-10-07T11:00:00Z')), false);
});

test('sendSmtp delivers a message on an injected connection', async () => {
  const received = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.write('220 ready\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        if (line.startsWith('EHLO')) socket.write('250 hello\r\n');
        else if (line.startsWith('AUTH')) socket.write('235 ok\r\n');
        else if (line.startsWith('MAIL')) socket.write('250 ok\r\n');
        else if (line.startsWith('RCPT')) socket.write('250 ok\r\n');
        else if (line === 'DATA') socket.write('354 go\r\n');
        else if (line === '.') socket.write('250 queued\r\n');
        else if (line === 'QUIT') socket.end();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = net.connect({ port: server.address().port, host: '127.0.0.1' });
  await once(socket, 'connect');
  await sendSmtp({ host: '127.0.0.1', port: 465, username: 'salon', password: 'secret-pass', from: 'desk@example.com', to: 'owner@example.com', subject: 'Reset your Beauty For All admin PIN', text: 'Open this link\n.not a command', socket });
  await new Promise(resolve => server.close(resolve));
  assert.ok(received.some(line => line === 'MAIL FROM:<desk@example.com>'));
  assert.ok(received.some(line => line === 'RCPT TO:<owner@example.com>'));
  assert.ok(received.some(line => line === '..not a command'));
  assert.equal(received.some(line => line.includes('secret-pass')), false);
});

test('admin can reset the staff PIN and recover their own PIN by email', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bfa-access-test-'));
  let time = Date.parse('2026-10-07T11:00:00Z');
  const sent = [];
  let failSend = false;
  const mailer = { async send(message) { sent.push(message); if (failSend) throw new Error('mailbox refused'); } };
  const server = await createApp({ dataDir, suppliedPins: { admin: '0937', staff: '5826' }, now: () => time, mailer });
  const base = await listen(server);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const login = (role, pin) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pin }) });
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  let adminCookie;
  let otherAdmin;
  let staffCookie;

  await t.test('recovery pages stay public and private files stay hidden', async () => {
    const home = await (await get('/')).text();
    assert.equal((home.match(/class="pin-input"/g) || []).length, 8);
    assert.match(home, /href="\/recover"/);
    assert.match(home, /Ask an admin to set a new one in Settings/);
    const admin = await login('admin', '0937');
    adminCookie = cookieOf(admin);
    otherAdmin = cookieOf(await login('admin', '0937'));
    staffCookie = cookieOf(await login('staff', '5826'));
    assert.equal((await get('/recover', adminCookie)).status, 200);
    assert.equal((await get('/recover/reset', adminCookie)).status, 200);
    for (const path of ['/.local/recovery.json', '/.local/mail.json', '/.local/credentials.json', '/access.mjs']) assert.equal((await get(path)).status, 404);
    const staffState = await (await get('/api/workspace', staffCookie)).json();
    assert.equal(Object.hasOwn(staffState, 'access'), false);
    assert.equal(Object.hasOwn(staffState, 'audit'), false);
  });

  await t.test('only an admin can replace the staff PIN, and old staff sessions end', async () => {
    assert.equal((await post('/api/access/staff-pin', { pin: '4444', confirm: '4444' }, staffCookie)).status, 403);
    assert.equal((await post('/api/access/staff-pin', { pin: '0937', confirm: '0937' }, adminCookie)).status, 400);
    const saved = await post('/api/access/staff-pin', { pin: '4444', confirm: '4444' }, adminCookie);
    assert.equal(saved.status, 200);
    assert.equal((await get('/api/session', staffCookie)).status, 401);
    assert.equal((await login('staff', '5826')).status, 401);
    staffCookie = cookieOf(await login('staff', '4444'));
    assert.equal((await get('/api/session', staffCookie)).status, 200);
    assert.equal((await login('admin', '0937')).status, 200);
  });

  await t.test('changing the admin PIN keeps this session and drops the other', async () => {
    const wrong = await post('/api/access/admin-pin', { current: '0000', pin: '1212', confirm: '1212' }, adminCookie);
    assert.equal(wrong.status, 400);
    assert.equal((await get('/api/session', adminCookie)).status, 200);
    assert.equal((await post('/api/access/admin-pin', { current: '0937', pin: '4444', confirm: '4444' }, adminCookie)).status, 400);
    const changed = await post('/api/access/admin-pin', { current: '0937', pin: '1212', confirm: '1212' }, adminCookie);
    assert.equal(changed.status, 200);
    assert.equal((await get('/api/session', adminCookie)).status, 200);
    assert.equal((await get('/api/session', otherAdmin)).status, 401);
    assert.equal((await login('admin', '0937')).status, 401);
    assert.equal((await login('admin', '1212')).status, 200);
  });

  await t.test('recovery matches the saved profile and emails only the registered address', async () => {
    const missing = await (await post('/api/recover', profile)).json();
    assert.equal(missing.status, 'missing');
    assert.match(missing.message, /not been saved yet/);
    assert.equal((await post('/api/access/recovery', { ...profile, dob: '2026-10-08' }, adminCookie)).status, 400);
    const saved = await post('/api/access/recovery', profile, adminCookie);
    assert.equal(saved.status, 200);
    const access = await saved.json();
    assert.equal(access.recoveryEmail, 'o***@example.com');
    assert.equal(access.recoveryRegistered, true);
    assert.equal(Object.hasOwn(access, 'password'), false);
    const stored = await readFile(join(dataDir, 'recovery.json'), 'utf8');
    assert.equal((await stat(join(dataDir, 'recovery.json'))).mode & 0o777, 0o600);
    assert.match(stored, /owner@example.com/);
    assert.doesNotMatch(stored, /Lovelace|1990-04-12/);
    const mismatch = await (await post('/api/recover', { ...profile, dob: '1990-04-13' })).json();
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(sent.length, 0);
    const matched = await (await post('/api/recover', { name: 'ada   lovelace', email: 'Owner@Example.com', dob: profile.dob })).json();
    assert.equal(matched.status, 'sent');
    assert.doesNotMatch(JSON.stringify(matched), /token|1212|4444|6565/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@example.com');
    assert.match(sent[0].text, /salon computer/);
    assert.match(sent[0].text, /^http:\/\/127\.0\.0\.1:\d+\/recover\/reset\?token=[0-9a-f]{64}$/m);
    assert.doesNotMatch(sent[0].text.replace(/token=[0-9a-f]{64}/, ''), /1212|4444|6565/);
    const token = sent[0].text.match(/token=([0-9a-f]{64})/)[1];
    const reset = await post('/api/recover/reset', { token, pin: '6565', confirm: '6565' });
    assert.equal(reset.status, 200);
    assert.equal((await post('/api/recover/reset', { token, pin: '6565', confirm: '6565' })).status, 400);
    assert.equal((await get('/api/session', adminCookie)).status, 401);
    assert.equal((await login('admin', '1212')).status, 401);
    adminCookie = cookieOf(await login('admin', '6565'));
    assert.equal((await login('staff', '4444')).status, 200);
  });

  await t.test('a failed email removes the reset link', async () => {
    failSend = true;
    const failed = await (await post('/api/recover', profile)).json();
    assert.equal(failed.status, 'send_failed');
    assert.match(failed.message, /could not be sent/);
    const leaked = sent.at(-1).text.match(/token=([0-9a-f]{64})/)[1];
    assert.equal((await post('/api/recover/reset', { token: leaked, pin: '3434', confirm: '3434' })).status, 400);
    assert.equal((await login('admin', '6565')).status, 200);
    failSend = false;
  });

  await t.test('an expired link cannot set a PIN', async () => {
    const matched = await (await post('/api/recover', profile)).json();
    assert.equal(matched.status, 'sent');
    const token = sent.at(-1).text.match(/token=([0-9a-f]{64})/)[1];
    time += 21 * 60 * 1000;
    assert.equal((await post('/api/recover/reset', { token, pin: '3434', confirm: '3434' })).status, 400);
    assert.equal((await login('admin', '6565')).status, 200);
  });

  await t.test('the mailbox password is saved privately and recovery is rate limited', async () => {
    time += 11 * 60 * 1000;
    const mail = await post('/api/access/mail', { enabled: true, host: 'smtp.example.com', port: 587, username: 'salon', password: 'mailbox-secret', from: 'desk@example.com' }, adminCookie);
    assert.equal(mail.status, 200);
    const status = await mail.json();
    assert.equal(status.mailConfigured, true);
    assert.equal(Object.hasOwn(status, 'password'), false);
    const workspace = await (await get('/api/workspace', adminCookie)).json();
    assert.equal(workspace.access.mailHost, 'smtp.example.com');
    assert.doesNotMatch(JSON.stringify(workspace), /mailbox-secret|6565|4444|owner@example.com|1990-04-12/);
    const mailFile = await readFile(join(dataDir, 'mail.json'), 'utf8');
    assert.match(mailFile, /mailbox-secret/);
    assert.equal((await stat(join(dataDir, 'mail.json'))).mode & 0o777, 0o600);
    for (let attempt = 0; attempt < 8; attempt += 1) assert.equal((await post('/api/recover', { name: 'No Match', email: 'no@example.com', dob: '1990-04-12' })).status, 200);
    const limited = await post('/api/recover', profile);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '600');
  });

  await t.test('audit records the changes without secrets', async () => {
    const workspace = await (await get('/api/workspace', adminCookie)).json();
    const actions = workspace.audit.map(row => row.action);
    for (const action of ['staff_pin_reset', 'admin_pin_changed', 'admin_recovery_updated', 'admin_recovery_requested', 'admin_recovery_rejected', 'admin_pin_reset', 'mail_settings_updated']) assert.ok(actions.includes(action), action);
    const text = JSON.stringify(workspace.audit);
    assert.doesNotMatch(text, /0937|5826|4444|1212|6565|3434|mailbox-secret|owner@example.com|1990-04-12|token=/);
  });
});

test('matched recovery does not claim an email was sent when no mailbox is connected', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bfa-access-nomail-'));
  const server = await createApp({ dataDir, suppliedPins: { admin: '0937', staff: '5826' }, now: () => Date.parse('2026-10-07T11:00:00Z') });
  const base = await listen(server);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const admin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin', pin: '0937' }) });
  const cookie = cookieOf(admin);
  const saved = await fetch(`${base}/api/access/recovery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(profile) });
  assert.equal(saved.status, 200);
  const result = await (await fetch(`${base}/api/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) })).json();
  assert.equal(result.status, 'no_mail');
  assert.match(result.message, /nothing was sent/);
  assert.equal(Object.hasOwn(result, 'token'), false);
});
