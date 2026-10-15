import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
import {receiptBytes, testSlipBytes, sendEthernet} from '../hardware.mjs';

const pulse = Buffer.from([0x1b, 0x07, 0x14, 0x14, 0x07]);

async function app(sent, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bfa-hardware-'));
  const server = await createApp({dataDir, suppliedPins:{admin:'0937', staff:'5826'}, hardwareTransport:async (config, bytes) => sent.push({config, bytes:Buffer.from(bytes)}), now:() => Date.parse('2026-10-07T12:00:00Z'), ...extra});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (role, pin) => (await fetch(base + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role, pin})})).headers.get('set-cookie').split(';')[0];
  return {dataDir, server, base, admin:await login('admin', '0937'), staff:await login('staff', '5826')};
}

test('Star printer receipt, drawer pulse and saved connection', async t => {
  const sent = [];
  const {dataDir, server, base, admin, staff} = await app(sent);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, {recursive:true, force:true}); });
  const post = async (path, body, cookie = admin) => {
    const response = await fetch(base + path, {method:'POST', headers:{'Content-Type':'application/json', Cookie:cookie}, body:JSON.stringify(body)});
    return {status:response.status, data:await response.json()};
  };
  const workspace = async cookie => (await fetch(base + '/api/workspace', {headers:{Cookie:cookie}})).json();
  const saved = await post('/api/hardware', {enabled:true, connection:'ethernet', host:'192.168.1.50'});
  assert.equal(saved.status, 200);
  assert.equal(saved.data.printer, 'Star TSP143IV UE');
  assert.equal(saved.data.drawer, '14×16 in. printer-driven cash drawer');
  assert.equal(saved.data.host, '192.168.1.50');
  assert.equal(saved.data.port, 9100);
  assert.equal((await workspace(staff)).hardware.host, undefined);
  assert.equal((await workspace(staff)).drawer_connected, true);
  assert.equal((await post('/api/hardware', {enabled:true, connection:'ethernet', host:'8.8.8.8'})).status, 400);
  assert.equal((await post('/api/hardware', {enabled:true, connection:'ethernet', host:'192.168.1.50'}, staff)).status, 403);
  assert.equal((await post('/api/hardware/test-connection', {enabled:false, connection:'ethernet', host:'192.168.1.50'})).status, 400);
  assert.equal((await post('/api/hardware/test-print', {enabled:true, connection:'ethernet', host:'10.0.0.8'})).status, 200);
  assert.equal(sent.at(-1).bytes.includes(pulse), false);
  assert.equal((await post('/api/hardware/test-connection', {enabled:true, connection:'usb', usbQueue:'Star_TSP143'})).status, 200);
  assert.equal(sent.at(-1).config.connection, 'usb');
  const staffMember = (await post('/api/records/staff', {name:'TEST A'})).data;
  const service = (await post('/api/records/services', {name:'TEST Service', price:'20', duration:45})).data;
  const customer = (await post('/api/records/customers', {name:'TEST Customer'}, staff)).data;
  const saleBody = {date:'2026-10-07', staff_id:staffMember.id, customer_id:customer.id, items:[{kind:'services', id:service.id, quantity:1, staff_id:staffMember.id}], method:'cash', tendered:'20', request_key:randomUUID()};
  const before = sent.length;
  const sale = await post('/api/records/sales', saleBody, staff);
  assert.equal(sale.status, 200, JSON.stringify(sale.data));
  assert.equal(sale.data.drawer_status, 'command_sent');
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).bytes.includes(pulse), true);
  assert.equal(sent.at(-1).config.host, '192.168.1.50');
  const replay = await post('/api/records/sales', saleBody, staff);
  assert.equal(replay.data.replayed, true);
  assert.equal(sent.length, before + 1);
  const card = await post('/api/records/sales', {...saleBody, method:'card', card_confirmed:true, request_key:randomUUID()}, staff);
  assert.equal(card.status, 200);
  assert.equal(sent.length, before + 1);
  const printed = await post('/api/hardware/print', {id:sale.data.id}, staff);
  assert.equal(printed.status, 200);
  assert.equal(sent.at(-1).bytes.includes(Buffer.from(sale.data.receipt_number)), true);
  assert.equal(sent.at(-1).bytes.includes(pulse), false);
  assert.equal((await fetch(base + '/api/hardware/print', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})).status, 401);
  const queues = await fetch(base + '/api/hardware/queues', {headers:{Cookie:admin}});
  assert.equal(queues.status, 200);
  assert.ok(Array.isArray((await queues.json()).queues));
  assert.equal((await fetch(base + '/api/hardware/queues', {headers:{Cookie:staff}})).status, 403);
});

test('an unconfigured printer does not open the till or accept a receipt', async t => {
  const sent = [];
  const {dataDir, server, base, admin, staff} = await app(sent);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, {recursive:true, force:true}); });
  const post = async (path, body, cookie = admin) => {
    const response = await fetch(base + path, {method:'POST', headers:{'Content-Type':'application/json', Cookie:cookie}, body:JSON.stringify(body)});
    return {status:response.status, data:await response.json()};
  };
  const state = await (await fetch(base + '/api/workspace', {headers:{Cookie:admin}})).json();
  assert.equal(state.drawer_connected, false);
  assert.equal(state.hardware.enabled, false);
  const staffMember = (await post('/api/records/staff', {name:'TEST A'})).data;
  const service = (await post('/api/records/services', {name:'TEST Service', price:'20', duration:45})).data;
  const sale = await post('/api/records/sales', {date:'2026-10-07', staff_id:staffMember.id, items:[{kind:'services', id:service.id, quantity:1, staff_id:staffMember.id}], method:'cash', tendered:'20', request_key:randomUUID()}, staff);
  assert.equal(sale.status, 200, JSON.stringify(sale.data));
  assert.equal(sale.data.drawer_status, 'not_connected');
  assert.equal(sent.length, 0);
  assert.equal((await post('/api/hardware/print', {id:sale.data.id}, staff)).status, 409);
});

test('receipt bytes use StarPRNT and the ethernet sender delivers them', async t => {
  const receipt = receiptBytes({receipt_number:'BFA-00000042', at:'2026-10-07T11:00:00Z', staff_name:'TEST A', customer_name:'TEST Customer', items:[{name:'Cut', quantity:1, price:2000, staff_name:'TEST A'}], gross_total:2000, total:2000, method:'cash', cash:2000, tendered:2000, change:0}, {name:'Beauty For All', address:'277 Blagreaves Lane\nDE23 1PT'});
  assert.equal(receipt.includes(Buffer.from([0x1b, 0x40, 0x18])), true);
  assert.equal(receipt.includes(Buffer.from([0x1b, 0x52, 0x03])), true);
  assert.equal(receipt.includes(Buffer.from('BFA-00000042')), true);
  assert.equal(receipt.includes(Buffer.from('Beauty For All')), true);
  assert.equal(receipt.includes(pulse), false);
  assert.deepEqual(receipt.subarray(-3), Buffer.from([0x1b, 0x64, 0x01]));
  assert.equal(testSlipBytes().includes(pulse), false);
  const received = [];
  const printer = net.createServer(socket => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
  });
  await new Promise(resolve => printer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => printer.close(resolve)));
  await sendEthernet('127.0.0.1', printer.address().port, pulse);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], pulse);
});
