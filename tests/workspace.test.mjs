import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { money,today } from '../store.mjs';

test('salon workflow, permissions, reconciliation and durable records',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'bfa-workspace-'));let server,base,admin,staff;
 async function start(){server=await createApp({dataDir,suppliedPins:{admin:'0937',staff:'5826'},now:()=>Date.parse('2026-10-07T11:00:00Z')});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;for(const [role,pin] of [['admin','0937'],['staff','5826']]){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,pin})});const cookie=r.headers.get('set-cookie').split(';')[0];if(role==='admin')admin=cookie;else staff=cookie;}}
 const post=async(kind,body,cookie=admin)=>{const r=await fetch(base+'/api/records/'+kind,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const create=async(kind,body,cookie=admin)=>{const r=await post(kind,body,cookie);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 const state=async(cookie=admin)=>{const r=await fetch(base+'/api/workspace',{headers:{Cookie:cookie}});return r.json();};
 await start();t.after(async()=>{await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true});});
 let customer,member,service,product,appointment,sale,cashup;
 await t.test('empty catalogues, authentication and server permissions',async()=>{
  assert.equal((await fetch(base+'/api/workspace')).status,401);assert.equal((await state()).sales.length,0);
  for(const kind of ['services','products','settings','audit'])assert.equal((await post(kind,{name:'FORBIDDEN'},staff)).status,kind==='audit'?404:403);
  assert.equal((await post('staff',{name:'TEST Sneak',active:true},staff)).status,403);
  assert.equal((await post('staff',{id:'missing',version:1,name:'FORBIDDEN'},staff)).status,403);
  assert.equal((await post('staff',{action:'delete'},staff)).status,403);
  assert.equal((await state(staff)).sales,undefined);assert.equal((await state(staff)).audit,undefined);assert.equal((await state(staff)).settings,undefined);
 });
 await t.test('staff can manage customers and appointments using approved catalogue',async()=>{
  customer=await create('customers',{name:'TEST Customer',phone:'0123456789'},staff);
  member=await create('staff',{name:'TEST Stylist',job:'Stylist'});
  await create('hours',{staff_id:member.id,days:Array(7).fill({start:'08:00',end:'20:00'})});
  service=await create('services',{name:'TEST Service',price:'30.25',duration:45});
  const desk=await create('staff',{name:'TEST Desk',active:true});
  const deskHours=(await state()).hours.find(row=>row.staff_id===desk.id);
  assert.ok(deskHours.days.every(day=>day.start==='09:00'&&day.end==='19:00'));
  assert.equal((await post('staff',{id:desk.id,version:desk.version,name:'TEST Desk renamed'},staff)).status,403);
  assert.equal((await post('staff',{id:desk.id,version:desk.version,action:'delete'},staff)).status,403);
  const walk=await create('customers',{name:'TEST Walk-up',phone:'07000900111'},staff);
  const quick=await create('appointments',{customer_id:walk.id,staff_id:desk.id,service_ids:[service.id],date:'2026-10-07',time:'15:00',status:'booked'},staff);
  assert.equal(quick.customer_name,'TEST Walk-up');assert.equal(quick.staff_name,'TEST Desk');assert.equal(quick.total,3025);
  assert.equal((await post('appointments',{customer_id:walk.id,staff_id:desk.id,service_ids:[service.id],date:'2026-10-07',time:'18:30',status:'booked'},staff)).status,409);
  product=await create('products',{name:'TEST Product',price:'9.75',stock:10,reorder:2});
  appointment=await create('appointments',{customer_id:customer.id,staff_id:member.id,service_ids:[service.id],date:'2026-10-07',time:'10:00',status:'booked'},staff);
  assert.equal(appointment.total,3025);assert.equal(appointment.duration,45);
  const extra=await create('services',{name:'TEST Extra',price:'5.00',duration:15});
  const added=await create('appointments',{...appointment,service_ids:[service.id,extra.id]},staff);
  assert.equal(added.total,3525);assert.equal(added.duration,60);assert.deepEqual(added.service_ids,[service.id,extra.id]);
  appointment=await create('appointments',{...added,service_ids:[service.id]},staff);
  assert.equal(appointment.total,3025);assert.equal(appointment.duration,45);assert.deepEqual(appointment.service_ids,[service.id]);
  assert.equal((await post('services',{id:service.id,version:service.version,name:'TEST Changed',price:'1.00',duration:45},staff)).status,403);
  assert.equal((await post('services',{id:service.id,version:service.version,action:'delete'},staff)).status,403);
  assert.equal((await post('services',{id:extra.id,version:extra.version,name:'TEST Extra changed',price:'9.00',duration:15},staff)).status,403);
  const kept=(await state()).services.find(row=>row.id===service.id);
  assert.equal(kept.name,'TEST Service');assert.equal(kept.price,3025);assert.equal(kept.duration,45);
  assert.equal((await state()).services.find(row=>row.id===extra.id).price,500);
  await create('services',{id:extra.id,version:extra.version,action:'delete'});
  assert.equal((await state()).services.some(row=>row.id===extra.id),false);
  assert.equal((await post('appointments',{...appointment,id:undefined,time:'10:30'},staff)).status,409);

  assert.equal((await post('products',{name:'Bad',price:'1.999',stock:1,reorder:1})).status,400);
 });
 const saleInput=()=>({date:'2026-10-07',staff_id:member.id,customer_id:customer.id,appointment_id:appointment.id,items:[{kind:'services',id:service.id,quantity:1},{kind:'products',id:product.id,quantity:2}],method:'split',cash:'20.00',tendered:'25.00',card_confirmed:true,request_key:randomUUID()});
 await t.test('staff payment is atomic, idempotent, attributed and reduces stock',async()=>{
  const input=saleInput();assert.equal((await post('sales',{...input,card_confirmed:false},staff)).status,400);
  sale=await create('sales',input,staff);assert.equal(sale.total,4975);assert.equal(sale.cash,2000);assert.equal(sale.card,2975);assert.equal(sale.change,500);
  assert.equal((await create('sales',input,staff)).id,sale.id);
  let s=await state();assert.equal(s.sales.length,1);assert.equal(s.products[0].stock,8);assert.equal(s.appointments[0].status,'paid');assert.equal(s.appointments[0].paid,true);
  assert.equal((await post('sales',saleInput(),staff)).status,409);
  assert.equal((await post('sales',{...saleInput(),id:sale.id,version:sale.version},staff)).status,403);
  assert.equal((await post('appointments',{...appointment,action:'delete'})).status,409);
 });
 await t.test('failed stock changes roll back and admin corrections recalculate stock',async()=>{
  const input={...saleInput(),id:sale.id,version:sale.version,items:[{kind:'services',id:service.id,quantity:1},{kind:'products',id:product.id,quantity:99}]};
  const before=(await state()).audit.length;assert.equal((await post('sales',input)).status,409);assert.equal((await state()).products[0].stock,8);assert.equal((await state()).audit.length,before);
  sale=await create('sales',{...saleInput(),id:sale.id,version:sale.version,items:[{kind:'services',id:service.id,quantity:1},{kind:'products',id:product.id,quantity:1}]});assert.equal(sale.total,4000);assert.equal((await state()).products[0].stock,9);
 });
 await t.test('cash-up reconciles and protects closed dates',async()=>{
  cashup=await create('cashups',{date:'2026-10-07',opening:'50.00',counted:'69.50',notes:'TEST count'});
  assert.equal(cashup.cash,2000);assert.equal(cashup.card,2000);assert.equal(cashup.expected,7000);assert.equal(cashup.difference,-50);
  assert.equal((await post('sales',{id:sale.id,version:sale.version,action:'delete'})).status,409);
  assert.equal((await post('cashups',{date:'2026-10-07',opening:'0',counted:'0'})).status,409);
  await create('cashups',{id:cashup.id,version:cashup.version,action:'delete'});
 });
 await t.test('deletion reverses stock, preserves audit and reopens appointment',async()=>{
  await create('sales',{id:sale.id,version:sale.version,action:'delete'});const s=await state();assert.equal(s.products[0].stock,10);assert.equal(s.sales.length,0);assert.equal(s.appointments[0].status,'booked');assert.ok(s.audit.some(x=>x.kind==='sales'&&x.action==='sale_deleted'&&x.before.total===4000));
  assert.equal((await post('audit',{action:'delete',id:1})).status,404);
 });
 await t.test('optimistic concurrency and persistence after server restart',async()=>{
  const updated=await create('customers',{...customer,name:'TEST Updated'});assert.equal((await post('customers',{...customer,name:'STALE'})).status,409);
  await create('settings',{name:'TEST Salon',phone:'',address:''});
  await new Promise(r=>server.close(r));await start();const s=await state();assert.equal(s.customers.find(row=>row.id===updated.id).name,updated.name);assert.equal(s.settings.name,'TEST Salon');assert.equal(s.products[0].stock,10);assert.ok(s.audit.length>0);
 });
 await t.test('money and UK date calculations are exact',()=>{assert.equal(money('0.29'),29);assert.equal(money('123.4'),12340);assert.equal(today(Date.parse('2026-07-01T23:30:00Z')),'2026-07-02');});
});
