import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../store.mjs';

test('customer history, booking fields, deposits and payment lifecycle persist accurately',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bfa-history-'));let db=openStore(dir);
 try{
 const save=(kind,b,role='admin')=>db.mutate(kind,b,role);
 const staff=save('staff',{name:'TEST Stylist',job:'Ignored'});assert.equal(staff.job,undefined);
 save('hours',{staff_id:staff.id,days:Array(7).fill({start:'08:00',end:'20:00'})});
 const c=save('customers',{name:'TEST Customer',phone:'07000000000',notes:'TEST note'});
 const service=save('services',{name:'TEST Service',price:'30',duration:45});
 const product=save('products',{name:'TEST Product',price:'5',stock:3,reorder:1});
 let a=save('appointments',{customer_id:c.id,staff_id:staff.id,date:'2026-10-07',time:'10:00',people:3,service_ids:[service.id],status:'booked'},'staff');
 assert.equal(a.people,3);assert.equal(a.mobile,c.phone);assert.equal(a.total,3000);assert.equal(a.duration,45);
 const fresh=save('customers',{name:'TEST Fresh',phone:''},'staff');
 const kept=save('appointments',{customer_id:fresh.id,staff_id:staff.id,date:'2026-10-08',time:'12:00',service_ids:[service.id],status:'booked',mobile:'07111222333',save_customer_phone:true},'staff');
 assert.equal(kept.customer_id,fresh.id);assert.equal(kept.customer_name,'TEST Fresh');assert.equal(kept.mobile,'07111222333');
 assert.equal(db.state('admin').customers.find(row=>row.id===fresh.id).phone,'07111222333');
 save('appointments',{...kept,status:'arrived',mobile:'07999888777'},'staff');
 assert.equal(db.state('admin').customers.find(row=>row.id===fresh.id).phone,'07111222333');
 const blank=save('customers',{name:'TEST Blank Phone',phone:''},'staff');
 save('appointments',{customer_id:blank.id,staff_id:staff.id,date:'2026-10-08',time:'14:00',service_ids:[service.id],status:'booked',mobile:'07000444555'},'staff');
 assert.equal(db.state('admin').customers.find(row=>row.id===blank.id).phone,'07000444555');
 const firstId=a.id;
 const pay={date:'2026-10-07',customer_id:c.id,staff_id:staff.id,appointment_id:a.id,method:'cash',tendered:'10',type:'deposit',deposit_amount:'10',request_key:randomUUID()};
 const deposit=save('sales',pay,'staff');assert.equal(deposit.cash,1000);assert.equal(save('sales',pay,'staff').id,deposit.id);
 let state=db.state('staff');a=state.appointments.find(row=>row.id===firstId);assert.equal(a.deposit,1000);assert.equal(a.remaining,2000);assert.equal(a.paid,false);
 assert.throws(()=>save('sales',{...pay,deposit_amount:'21',tendered:'21',request_key:randomUUID()},'staff'),/remaining balance/);
 assert.throws(()=>save('appointments',{...a,status:'paid'},'staff'),/checkout/);
 for(const status of ['arrived','in_progress','awaiting_payment','no_show','booked'])a=save('appointments',{...a,status},'staff');
 const checkout=save('sales',{...pay,type:'checkout',items:[{kind:'services',id:service.id,quantity:1},{kind:'products',id:product.id,quantity:1}],method:'card',card_confirmed:true,request_key:randomUUID()},'staff');
 assert.equal(checkout.total,2500);assert.equal(checkout.gross_total,3500);assert.equal(checkout.deposit_applied,1000);
 state=db.state('staff');a=state.appointments.find(row=>row.id===firstId);assert.equal(a.status,'paid');assert.equal(a.remaining,0);
 a=save('appointments',{...a,status:'completed',complete:true},'staff');assert.equal(a.status,'completed');
 assert.throws(()=>save('sales',{...deposit,action:'delete'}),/final checkout/);
 const history=db.customerHistory(c.id);assert.equal(history.appointments.length,1);assert.equal(history.payments.length,2);assert.equal(history.payments.reduce((n,p)=>n+p.total,0),3500);assert.equal(history.payments[0].items[1].kind,'products');assert.equal(state.sales,undefined);
 const cashup=save('cashups',{date:'2026-10-07',opening:'50',counted:'60'});assert.equal(cashup.cash,1000);assert.equal(cashup.card,2500);
 db.close();db=openStore(dir);assert.equal(db.customerHistory(c.id).payments.length,2);assert.equal(db.state('staff').appointments.find(row=>row.id===firstId).people,3);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
