import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { openStore } from '../store.mjs';

const hours = () => Array(7).fill({start:'08:00', end:'20:00'});

test('services, stock, unsent texts, audit names and deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bfa-catalogue-'));
  let clock = Date.parse('2026-10-06T08:00:00.000Z');
  const db = openStore(dir, () => clock);
  try {
    const save = (kind, body, role = 'admin') => db.mutate(kind, body, role);
    const stylist = save('staff', {name:'TEST Stylist'});
    save('hours', {staff_id:stylist.id, days:hours()});
    const renamed = save('staff', {...stylist, name:'TEST Stylist'});
    const customer = save('customers', {name:'TEST Nia', phone:'07123456789'});
    const service = save('services', {name:'TEST Cut', category:'Hair', price:'25.00', duration:30, active:true});
    assert.equal(service.category, 'Hair');
    assert.equal(service.price, 2500);
    assert.equal(service.duration, 30);
    assert.equal(service.active, true);
    const plain = save('services', {name:'TEST Plain', price:'10.00', duration:20});
    assert.equal(plain.category, '');
    assert.equal(plain.active, true);
    const sunbed = save('services', {name:'TEST Sunbed 3 minutes', category:'Sunbed', price:'1.50', duration:3});
    assert.equal(sunbed.price, 150);
    assert.equal(sunbed.duration, 3);
    assert.throws(() => save('services', {name:'TEST Too short', price:'1.00', duration:2}), /Duration/);
    const retired = save('services', {name:'TEST Retired', category:'Hair', price:'15.00', duration:20, active:false});
    assert.throws(() => save('appointments', {customer_id:customer.id, staff_id:stylist.id, service_ids:[retired.id], date:'2026-10-08', time:'11:00', status:'booked'}), /inactive/);

    const product = save('products', {name:'TEST Oil', category:'Retail', price:'12.50', cost:'4.00', stock:5, reorder:2, supplier:'TEST Supplier', active:true});
    assert.equal(product.cost, 400);
    assert.equal(product.supplier, 'TEST Supplier');
    const plainProduct = save('products', {name:'TEST Plain Product', price:'1.00', cost:'', stock:1, reorder:0});
    assert.equal(plainProduct.cost, 0);
    assert.equal(plainProduct.category, '');
    assert.equal(plainProduct.supplier, '');
    assert.equal(plainProduct.active, true);
    const hidden = save('products', {name:'TEST Hidden', price:'3.00', stock:4, reorder:1, active:'false'});
    assert.equal(hidden.active, false);
    assert.throws(() => save('sales', {date:'2026-10-06', staff_id:stylist.id, customer_id:customer.id, items:[{kind:'products', id:hidden.id, quantity:1}], method:'cash', tendered:'3.00', request_key:randomUUID()}), /inactive/);

    const appointment = save('appointments', {customer_id:customer.id, staff_id:stylist.id, service_ids:[service.id], date:'2026-10-08', time:'10:00', status:'booked', mobile:'07123456789'});
    const edited = save('services', {...service, category:'Colour', price:'25.00', duration:30, active:true});
    save('services', {...edited, price:'25.00', duration:30, active:false});
    const arrived = save('appointments', {...appointment, status:'arrived'});
    assert.equal(arrived.status, 'arrived');
    assert.throws(() => save('appointments', {...arrived, service_ids:[retired.id], status:'booked'}), /inactive/);

    let state = db.state('admin');
    assert.equal(state.smsConnected, false);
    assert.equal(db.state('staff').sms, undefined);
    assert.equal(state.sms.some(message => message.status === 'sent'), false);
    const messages = state.sms.filter(message => message.appointment_id === appointment.id);
    assert.equal(messages.length, 2);
    const confirmation = messages.find(message => message.kind === 'confirmation');
    const reminder = messages.find(message => message.kind === 'reminder');
    assert.equal(confirmation.status, 'not_connected');
    assert.equal(reminder.scheduled_for, '2026-10-07T09:00:00.000Z');
    for (const message of [confirmation, reminder]) {
      assert.match(message.body, /Beauty For All/);
      assert.match(message.body, /TEST Nia/);
      assert.match(message.body, /8 October 2026/);
      assert.match(message.body, /10:00/);
      assert.match(message.body, /TEST Cut/);
      assert.match(message.body, /TEST Stylist/);
      assert.match(message.body, /277 Blagreaves Lane/);
      assert.match(message.body, /cancel or reschedule/i);
    }
    assert.match(confirmation.body, /confirmed/);
    assert.match(reminder.body, /tomorrow/);
    assert.equal(state.appointments.find(item => item.id === appointment.id).sms, 'not_connected');
    assert.equal(db.state('staff').appointments.find(item => item.id === appointment.id).sms, 'not_connected');
    assert.ok(state.audit.some(row => row.action === 'appointment_created' && row.actor === 'admin'));
    assert.ok(state.audit.some(row => row.action === 'appointment_edited' && row.record_id === appointment.id));
    assert.ok(state.audit.some(row => row.action === 'service_created'));
    assert.ok(state.audit.some(row => row.action === 'service_edited'));
    assert.ok(state.audit.some(row => row.action === 'staff_created'));
    assert.ok(state.audit.some(row => row.action === 'staff_edited' && row.record_id === renamed.id));

    clock = Date.parse('2026-10-07T11:00:00.000Z');
    const todayBooking = save('appointments', {customer_id:customer.id, staff_id:stylist.id, service_ids:[plain.id], date:'2026-10-07', time:'15:00', status:'booked'});
    assert.equal(db.state('admin').sms.filter(message => message.appointment_id === todayBooking.id).map(message => message.kind).join(','), 'confirmation');
    save('appointments', {...todayBooking, status:'cancelled'});
    state = db.state('admin');
    assert.ok(state.audit.some(row => row.action === 'appointment_cancelled' && row.record_id === todayBooking.id));
    assert.ok(state.sms.filter(message => message.appointment_id === todayBooking.id).every(message => message.status === 'cancelled'));

    const noPhone = save('customers', {name:'TEST No Phone'});
    const quiet = save('appointments', {customer_id:noPhone.id, staff_id:stylist.id, service_ids:[plain.id], date:'2026-10-09', time:'12:00', status:'booked', mobile:''});
    assert.equal(db.state('admin').appointments.find(item => item.id === quiet.id).sms, 'missing_number');
    save('appointments', {id:quiet.id, version:quiet.version, action:'delete'}, 'staff');
    state = db.state('admin');
    assert.equal(state.appointments.some(item => item.id === quiet.id), false);
    assert.ok(state.customers.some(item => item.id === noPhone.id));
    assert.ok(state.audit.some(row => row.action === 'appointment_deleted' && row.record_id === quiet.id && row.actor === 'staff'));
    assert.ok(state.sms.filter(message => message.appointment_id === quiet.id).every(message => message.status === 'cancelled'));
    const removedAppointment = db.customerHistory(noPhone.id).appointments[0];
    assert.equal(removedAppointment.deleted, true);
    assert.equal(db.customerHistory(noPhone.id).customer.name, 'TEST No Phone');

    const sale = save('sales', {date:'2026-10-07', staff_id:stylist.id, customer_id:customer.id, appointment_id:appointment.id, items:[{kind:'services', id:service.id, quantity:1}, {kind:'products', id:product.id, quantity:2}], method:'cash', tendered:'50.00', request_key:randomUUID()}, 'staff');
    assert.equal(db.state('admin').products.find(item => item.id === product.id).stock, 3);
    assert.equal(db.state('admin').appointments.find(item => item.id === appointment.id).status, 'paid');
    assert.ok(db.state('admin').audit.some(row => row.action === 'sale_created' && row.record_id === sale.id));
    save('refunds', {sale_id:sale.id, date:'2026-10-07', amount:'1.00', method:'cash', confirmed:true, notes:'TEST partial'});
    assert.ok(db.state('admin').audit.some(row => row.action === 'refund_recorded'));
    assert.throws(() => save('sales', {id:sale.id, version:sale.version, action:'delete'}), /retained/);

    const walkIn = save('sales', {date:'2026-10-07', staff_id:stylist.id, customer_id:customer.id, items:[{kind:'products', id:product.id, quantity:1}], method:'card', card_confirmed:true, request_key:randomUUID()});
    assert.ok(walkIn.receipt_number > sale.receipt_number);
    assert.equal(db.state('admin').products.find(item => item.id === product.id).stock, 2);
    save('sales', {id:walkIn.id, version:walkIn.version, action:'delete'});
    state = db.state('admin');
    assert.equal(state.products.find(item => item.id === product.id).stock, 3);
    assert.equal(state.sales.some(item => item.id === walkIn.id), false);
    assert.ok(state.sales.some(item => item.id === sale.id));
    assert.equal(db.customerHistory(customer.id).payments.find(item => item.id === walkIn.id).deleted, true);
    assert.ok(state.audit.some(row => row.action === 'sale_deleted' && row.record_id === walkIn.id && row.before.receipt_number === walkIn.receipt_number));
    const again = save('sales', {date:'2026-10-07', staff_id:stylist.id, customer_id:customer.id, items:[{kind:'products', id:product.id, quantity:1}], method:'card', card_confirmed:true, request_key:randomUUID()});
    assert.notEqual(again.receipt_number, walkIn.receipt_number);
    assert.ok(again.receipt_number > walkIn.receipt_number);

    const book = save('appointments', {customer_id:customer.id, staff_id:stylist.id, service_ids:[plain.id], date:'2026-10-09', time:'16:00', status:'booked'});
    const checkout = save('sales', {date:'2026-10-07', staff_id:stylist.id, customer_id:customer.id, appointment_id:book.id, items:[{kind:'services', id:plain.id, quantity:1}], method:'card', card_confirmed:true, request_key:randomUUID()});
    assert.equal(db.state('admin').appointments.find(item => item.id === book.id).paid, true);
    save('sales', {id:checkout.id, version:checkout.version, action:'delete'});
    state = db.state('admin');
    assert.equal(state.appointments.find(item => item.id === book.id).status, 'booked');
    assert.equal(state.appointments.find(item => item.id === book.id).paid, false);
    assert.equal(state.sales.some(item => item.id === checkout.id), false);
    assert.equal(db.customerHistory(customer.id).payments.find(item => item.id === checkout.id).deleted, true);
    assert.equal(db.customerHistory(customer.id).customer.id, customer.id);
    const cashup = save('cashups', {date:'2026-10-06', opening:'10.00', counted:'10.00'});
    assert.ok(db.state('admin').audit.some(row => row.action === 'cashup_recorded' && row.record_id === cashup.id));
    assert.equal(db.state('admin').sms.some(message => message.status === 'sent'), false);
  } finally {
    db.close();
    await rm(dir, {recursive:true, force:true});
  }
});

test('sms stays unsent until a provider is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bfa-sms-'));
  const clock = Date.parse('2026-10-06T08:00:00.000Z');
  const sent = [];
  const db = openStore(dir, () => clock, {send(message) { sent.push(message); }});
  try {
    const stylist = db.mutate('staff', {name:'TEST Stylist'}, 'admin');
    db.mutate('hours', {staff_id:stylist.id, days:hours()}, 'admin');
    const customer = db.mutate('customers', {name:'TEST Nia', phone:'07123456789'}, 'admin');
    const service = db.mutate('services', {name:'TEST Cut', price:'10.00', duration:30}, 'admin');
    const appointment = db.mutate('appointments', {customer_id:customer.id, staff_id:stylist.id, service_ids:[service.id], date:'2026-10-08', time:'10:00', status:'booked'}, 'admin');
    const state = db.state('admin');
    const messages = state.sms.filter(message => message.appointment_id === appointment.id);
    assert.equal(state.smsConnected, true);
    assert.equal(messages.find(message => message.kind === 'confirmation').status, 'sent');
    assert.equal(messages.find(message => message.kind === 'reminder').status, 'scheduled');
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Beauty For All/);
    assert.equal(sent[0].phone, '07123456789');
  } finally {
    db.close();
    await rm(dir, {recursive:true, force:true});
  }
});

test('a provider failure keeps the booking and records the text as failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bfa-sms-fail-'));
  const db = openStore(dir, () => Date.parse('2026-10-06T08:00:00.000Z'), {send() { throw new Error('provider down'); }});
  try {
    const stylist = db.mutate('staff', {name:'TEST Stylist'}, 'admin');
    db.mutate('hours', {staff_id:stylist.id, days:hours()}, 'admin');
    const customer = db.mutate('customers', {name:'TEST Nia', phone:'07123456789'}, 'admin');
    const service = db.mutate('services', {name:'TEST Cut', price:'10.00', duration:30}, 'admin');
    const appointment = db.mutate('appointments', {customer_id:customer.id, staff_id:stylist.id, service_ids:[service.id], date:'2026-10-08', time:'11:00', status:'booked'}, 'admin');
    const state = db.state('admin');
    assert.equal(state.appointments[0].id, appointment.id);
    assert.equal(state.sms.find(message => message.kind === 'confirmation').status, 'failed');
    assert.equal(state.sms.find(message => message.kind === 'reminder').status, 'scheduled');
  } finally {
    db.close();
    await rm(dir, {recursive:true, force:true});
  }
});

test('sign-in security is audited without storing the PIN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bfa-security-'));
  const server = await createApp({dataDir:dir, suppliedPins:{admin:'2468', staff:'1357'}, now:() => Date.parse('2026-10-07T10:00:00.000Z')});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await fetch(base + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role:'admin', pin:'0000'})});
    assert.equal(bad.status, 401);
    const good = await fetch(base + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role:'admin', pin:'2468'})});
    assert.equal(good.status, 200);
    const cookie = good.headers.get('set-cookie').split(';')[0];
    const left = await fetch(base + '/api/logout', {method:'POST', headers:{'Content-Type':'application/json', Cookie:cookie}, body:'{}'});
    assert.equal(left.status, 200);
    const again = await fetch(base + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role:'admin', pin:'2468'})});
    const cookie2 = again.headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(base + '/api/workspace', {headers:{Cookie:cookie2}})).json();
    const security = state.audit.filter(row => row.kind === 'security');
    assert.ok(security.some(row => row.action === 'sign_in_rejected' && row.after.detail === 'Rejected sign-in.'));
    assert.ok(security.some(row => row.action === 'sign_in' && row.actor === 'admin'));
    assert.ok(security.some(row => row.action === 'sign_out' && row.actor === 'admin'));
    const dumped = JSON.stringify(security);
    assert.equal(dumped.includes('2468'), false);
    assert.equal(dumped.includes('0000'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive:true, force:true});
  }
});
