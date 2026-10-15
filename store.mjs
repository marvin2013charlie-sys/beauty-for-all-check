import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planMessages } from './sms.mjs';

const kinds = ['customers','staff','services','products','appointments','sales','cashups','settings','hours','refunds'];
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
const text = (v,label,required=false,max=500) => { if (typeof v !== 'string' || v.length>max || (required&&!v.trim())) fail(`${label} is required and must be under ${max} characters.`); return v.trim(); };
const integer = (v,label,min=0,max=1000000) => { const n=Number(v); if(v===''||v==null||!Number.isSafeInteger(n)||n<min||n>max) fail(`${label} must be a whole number between ${min} and ${max}.`); return n; };
export const money = v => { if(!/^\d{1,7}(\.\d{1,2})?$/.test(String(v))) fail('Enter a valid amount with up to two decimal places.'); const [a,b='']=String(v).split('.'); return Number(a)*100+Number(b.padEnd(2,'0')); };
export const today = (now=Date.now()) => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const date = v => { if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v) fail('Enter a valid date.'); return v; };

const activeFlag = value => value !== false && value !== 'false';
const openingWeek = () => Array.from({length:7}, () => ({start:'09:00', end:'19:00'}));
const isOpeningWeek = days => Array.isArray(days) && days.length===7 && days.every(day => day && day.start==='09:00' && day.end==='19:00');
const namedAction = (kind, action, before, after) => {
  if (kind === 'appointments' && action === 'edit' && after?.status === 'cancelled' && before?.status !== 'cancelled') return 'appointment_cancelled';
  const names = {
    appointments:{create:'appointment_created',edit:'appointment_edited',delete:'appointment_deleted'},
    sales:{create:'sale_created',edit:'sale_edited',delete:'sale_deleted'},
    refunds:{create:'refund_recorded'},
    cashups:{create:'cashup_recorded',edit:'cashup_edited',delete:'cashup_deleted'},
    staff:{create:'staff_created',edit:'staff_edited',delete:'staff_deleted'},
    services:{create:'service_created',edit:'service_edited',delete:'service_deleted'},
    products:{create:'product_created',edit:'product_edited',delete:'product_deleted'},
  };
  return names[kind]?.[action] || action;
};
const smsRank = messages => {
  const open = messages.filter(message => message.status !== 'cancelled');
  if (!open.length) return messages.length ? 'cancelled' : 'none';
  if (open.some(message => message.status === 'missing_number')) return 'missing_number';
  if (open.some(message => message.status === 'not_connected')) return 'not_connected';
  if (open.some(message => message.status === 'failed')) return 'failed';
  if (open.some(message => message.status === 'scheduled')) return 'scheduled';
  if (open.some(message => message.status === 'sent')) return 'sent';
  return 'none';
};

export function openStore(dataDir,now=Date.now,smsProvider=null) {
  const db=new DatabaseSync(join(dataDir,'salon.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS records_kind ON records(kind,deleted); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,kind TEXT NOT NULL,record_id TEXT NOT NULL,before_data TEXT,after_data TEXT); CREATE TABLE IF NOT EXISTS receipt_numbers (number INTEGER PRIMARY KEY AUTOINCREMENT,sale_id TEXT UNIQUE NOT NULL); CREATE TABLE IF NOT EXISTS drawer_events (id TEXT PRIMARY KEY,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY,record_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sms_messages (id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,customer_name TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,phone TEXT NOT NULL,body TEXT NOT NULL,scheduled_for TEXT NOT NULL,created_at TEXT NOT NULL,cancelled_at TEXT);`);
  const decode = row => row ? {...JSON.parse(row.data),id:row.id,version:row.version} : null;
  const list = kind => db.prepare('SELECT * FROM records WHERE kind=? AND deleted=0 ORDER BY rowid DESC').all(kind).map(decode);
  const get = (kind,id) => decode(db.prepare('SELECT * FROM records WHERE kind=? AND id=? AND deleted=0').get(kind,String(id||'')));
  const photoDir=join(dataDir,'staff-photos');
  const photoTypes={jpg:'image/jpeg',png:'image/png',webp:'image/webp'};
  const photoFile=(id,ext)=>join(photoDir,`${id}.${ext}`);
  function clearStaffPhoto(id){for(const ext of Object.keys(photoTypes)){try{unlinkSync(photoFile(id,ext));}catch(error){if(error.code!=='ENOENT')throw error;}}}
  function decodeStaffPhoto(value){
    const match=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(value||''));
    if(!match)fail('Use a JPEG, PNG or WebP photo.');
    const ext=match[1]==='jpeg'?'jpg':match[1];
    const bytes=Buffer.from(match[2].replace(/\s/g,''),'base64');
    const signature=ext==='jpg'?bytes[0]===0xff&&bytes[1]===0xd8:ext==='png'?bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])):bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
    if(bytes.length<32||bytes.length>1500000||!signature)fail('Use a JPEG, PNG or WebP photo under 1.5 MB.');
    return {ext,bytes};
  }
  function commitStaffPhoto(id,photo){mkdirSync(photoDir,{recursive:true,mode:0o700});writeFileSync(photoFile(id,photo.ext),photo.bytes,{mode:0o600});for(const ext of Object.keys(photoTypes))if(ext!==photo.ext){try{unlinkSync(photoFile(id,ext));}catch(error){if(error.code!=='ENOENT')throw error;}}}
  function readStaffPhoto(id){if(!/^[0-9a-f-]{36}$/i.test(String(id||'')))return null;const member=get('staff',id);if(!member?.photo||!photoTypes[member.photo])return null;try{return {bytes:readFileSync(photoFile(id,member.photo)),type:photoTypes[member.photo]};}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  function staffProfile(b,old,actor){
    if(actor!=='admin')return {job_title:old?.job_title||'',phone:old?.phone||'',email:old?.email||'',dob:old?.dob||'',address:old?.address||'',notes:old?.notes||''};
    const email=text(b.email||'','Email',false,160);
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Enter a valid email.');
    const dob=String(b.dob||'').trim();
    if(dob){date(dob);if(dob>today(now())||dob<'1920-01-01')fail('Enter a valid date of birth.');}
    return {job_title:text(b.job_title||'','Job title',false,80),phone:text(b.phone||'','Mobile',false,40),email,dob,address:text(b.address||'','Address',false,300),notes:text(b.notes||'','Notes',false,1000)};
  }
  function required(kind,id) { const record=get(kind,id); if(!record) fail(`Select an available ${kind === 'staff'?'staff member':kind.replace(/s$/,'')}.`); return record; }
  function audit(actor,action,kind,id,before,after) { db.prepare('INSERT INTO audit(at,actor,action,kind,record_id,before_data,after_data) VALUES(?,?,?,?,?,?,?)').run(new Date(now()).toISOString(),actor,namedAction(kind,action,before,after),kind,id,before?JSON.stringify(before):null,after?JSON.stringify(after):null); }
  function write(kind,id,data,actor,before=null) {
    db.prepare('INSERT INTO records(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=records.version+1').run(id,kind,JSON.stringify(data));
    const after=get(kind,id); audit(actor,before?'edit':'create',kind,id,before,after);
    if(kind==='appointments') syncAppointmentSms(before,after);
    return after;
  }
  function ensureOpeningHours(staffId, actor) {
    const hoursId='hours:'+staffId;
    if(get('staff',staffId)&&!get('hours',hoursId)) write('hours',hoursId,{staff_id:staffId,days:openingWeek()},actor);
  }
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try {const result=fn();db.exec('COMMIT');return result;} catch(e){db.exec('ROLLBACK');throw e;} }
  function openDate(value) { if(list('cashups').some(x=>x.date===value)) fail('This day has been cashed up. Delete its cash-up to reopen it before changing sales.',409); }
  function stockChange(sale,direction,actor) {
    for(const item of sale.items.filter(x=>x.kind==='products')) {
      const product=required('products',item.id); const stock=product.stock+direction*item.quantity;
      if(stock<0) fail(`Not enough stock for ${product.name}.`,409);
      write('products',product.id,{...product,stock},actor,product);
    }
  }
  const receiptNumber=id=>{db.prepare('INSERT OR IGNORE INTO receipt_numbers(sale_id) VALUES(?)').run(id);return 'BFA-'+String(db.prepare('SELECT number FROM receipt_numbers WHERE sale_id=?').get(id).number).padStart(8,'0');};
  for(const row of db.prepare("SELECT id,data FROM records WHERE kind='sales' ORDER BY rowid").all()){const data=JSON.parse(row.data);if(!data.receipt_number){data.receipt_number=receiptNumber(row.id);db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),row.id);}}
  const depositTotal=id=>list('sales').filter(s=>s.appointment_id===id&&s.type==='deposit').reduce((sum,s)=>sum+s.total,0);
  function withinHours(days,a){const h=days[new Date(a.date+'T12:00:00Z').getUTCDay()];const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));return h&&a.start>=minutes(h.start)&&a.start+a.duration<=minutes(h.end);}
  function validate(kind,b,old,actor) {
    if(!b||typeof b!=='object'||Array.isArray(b)) fail('Invalid record.');
    if(kind==='hours'){
      const staff=required('staff',b.staff_id);if(!Array.isArray(b.days)||b.days.length!==7)fail('Provide all seven weekdays.');
      const days=b.days.map(d=>{if(d===null)return null;if(!d||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.end)||d.start>=d.end)fail('Working hours need a valid start and end time.');return {start:d.start,end:d.end};});
      if(list('appointments').some(a=>a.staff_id===staff.id&&a.date>=today(now())&&!['cancelled','completed','no_show'].includes(a.status)&&!withinHours(days,a)))fail('Working hours would exclude an existing appointment. Reschedule it first.',409);
      return {staff_id:staff.id,days};
    }
    if(kind==='refunds'){
      if(old)fail('Refund records cannot be edited.');const sale=required('sales',b.sale_id),day=date(b.date);openDate(day);if(day>today(now()))fail('Refund date cannot be in the future.');
      const amount=money(b.amount);if(!['cash','card'].includes(b.method)||amount<=0)fail('Choose cash or card and a positive refund.');
      const refunded=list('refunds').filter(r=>r.sale_id===sale.id&&r.method===b.method).reduce((n,r)=>n+r.amount,0);if(amount+refunded>sale[b.method])fail('Refund exceeds the original payment amount.');
      if(b.confirmed!==true)fail('Confirm the refund was actually returned to the customer.');
      return {sale_id:sale.id,receipt_number:sale.receipt_number,date:day,at:new Date(now()).toISOString(),amount,method:b.method,notes:text(b.notes,'Refund reason',true,1000)};
    }
    if(kind==='customers') return {name:text(b.name,'Customer name',true,120),phone:text(b.phone||'','Phone',false,40),email:text(b.email||'','Email',false,160),notes:text(b.notes||'','Notes',false,2000)};
    if(kind==='staff') {
      const active=b.active!==false&&b.active!=='false';
      if(!active&&old&&list('appointments').some(a=>a.staff_id===old.id&&!['cancelled','completed','no_show'].includes(a.status))) fail('Reschedule or cancel this staff member’s open appointments before making them inactive.',409);
      return {name:text(b.name,'Staff name',true,120),...staffProfile(b,old,actor),active,photo:['jpg','png','webp'].includes(old?.photo)?old.photo:''};
    }
    if(kind==='services') return {name:text(b.name,'Service name',true,120),category:text(b.category||'','Category',false,80),price:money(b.price),duration:integer(b.duration,'Duration',3,720),active:activeFlag(b.active)};
    if(kind==='products') return {name:text(b.name,'Product name',true,120),category:text(b.category||'','Category',false,80),price:money(b.price),cost:money(b.cost==null||String(b.cost).trim()===''?'0':b.cost),stock:integer(b.stock,'Stock'),reorder:integer(b.reorder,'Low stock level'),supplier:text(b.supplier||'','Supplier',false,120),active:activeFlag(b.active)};
    if(kind==='settings') return {name:text(b.name,'Business name',true,120),phone:text(b.phone||'','Phone',false,40),address:text(b.address||'','Address',false,500)};
    if(kind==='appointments') {
      if(old&&list('sales').some(x=>x.appointment_id===old.id&&x.type!=='deposit')) {
        if(b.status==='completed'&&old.status==='paid'&&b.complete===true)return {...old,status:'completed'};
        fail('This appointment has a payment. Correct or delete its sale before editing it.',409);
      }
      if(b.status==='paid')fail('Use checkout to record payment before marking an appointment paid.');
      const customer=required('customers',b.customer_id),staff=required('staff',b.staff_id);
      if(staff.active===false)fail('Select an active staff member.');
      if(old&&depositTotal(old.id)>0&&customer.id!==old.customer_id)fail('Keep the customer linked to the recorded deposit.');
      if(!Array.isArray(b.service_ids)||!b.service_ids.length||b.service_ids.length>30) fail('Select at least one service.');
      const services=[...new Set(b.service_ids)].map(id=>{const current=required('services',id);const booked=old?.services.find(s=>s.id===id);if(current.active===false&&!booked)fail(`${current.name} is inactive and cannot be booked.`);return booked?{...current,price:booked.price,duration:booked.duration}:current;});
      const people=integer(b.people??old?.people??1,'Number of people',1,100);
      const day=date(b.date); if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) fail('Enter a valid appointment time.');
      const start=Number(b.time.slice(0,2))*60+Number(b.time.slice(3)); const duration=services.reduce((s,x)=>s+x.duration,0);
      if(!['cancelled','no_show'].includes(b.status)&&(!old||old.staff_id!==staff.id||old.date!==day||old.start!==start||old.duration!==duration)){const hours=get('hours','hours:'+staff.id);if(!hours)fail('An admin must configure this staff member’s working hours before booking.');if(!withinHours(hours.days,{date:day,start,duration}))fail('Appointment is outside this staff member’s working hours.',409);}
      if(start+duration>1440) fail('The appointment must finish on the same day.');
      if(!['booked','arrived','in_progress','awaiting_payment','paid','completed','cancelled','no_show'].includes(b.status)) fail('Select a valid status.');
      if(!['cancelled','no_show'].includes(b.status)&&list('appointments').some(x=>x.id!==old?.id&&x.staff_id===staff.id&&x.date===day&&!['cancelled','no_show'].includes(x.status)&&start<x.start+x.duration&&start+duration>x.start)) fail('This staff member already has an appointment at that time.',409);
      if(old&&services.reduce((s,x)=>s+x.price,0)<depositTotal(old.id))fail('Appointment total cannot be less than its recorded deposit.');
      const mobile=text(b.mobile??customer.phone??'','Mobile',false,40);
      if(mobile&&(b.save_customer_phone===true||!String(customer.phone||'').trim())&&mobile!==String(customer.phone||'').trim()) write('customers',customer.id,{name:customer.name,phone:mobile,email:customer.email||'',notes:customer.notes||''},actor,customer);
      return {customer_id:customer.id,customer_name:customer.name,staff_id:staff.id,staff_name:staff.name,service_ids:services.map(x=>x.id),services:services.map(x=>({id:x.id,name:x.name,price:x.price,duration:x.duration})),mobile,people,date:day,time:b.time,start,duration,total:services.reduce((s,x)=>s+x.price,0),status:b.status,arrived_at:old?.arrived_at||(b.status==='arrived'?new Date(now()).toISOString():null),started_at:old?.started_at||(b.status==='in_progress'?new Date(now()).toISOString():null),notes:text(b.notes||'','Notes',false,2000)};
    }
    if(kind==='sales') {
      const day=date(b.date); if(day>today(now())) fail('Sales cannot be recorded in the future.'); openDate(day); if(old) openDate(old.date);
      const staff=required('staff',b.staff_id);if(staff.active===false&&!old)fail('Select an active staff member.');const customer=b.customer_id?required('customers',b.customer_id):null;
      const appointment=b.appointment_id?required('appointments',b.appointment_id):null;
      if(appointment&&(['cancelled','no_show'].includes(appointment.status)||appointment.customer_id!==customer?.id||appointment.staff_id!==staff.id)) fail('The sale must match the appointment customer and staff member.');
      if(appointment&&list('sales').some(x=>x.id!==old?.id&&x.appointment_id===appointment.id&&x.type!=='deposit')) fail('This appointment has already been paid.',409);
      if(old?.appointment_id&&b.appointment_id!==old.appointment_id) fail('Keep the original appointment linked to this sale.');
      const isDeposit=(old?(old.type||'checkout'):b.type)==='deposit';
      if(isDeposit&&!appointment)fail('A deposit must be linked to an appointment.');
      if(old?.type==='deposit'&&list('sales').some(s=>s.appointment_id===old.appointment_id&&s.type!=='deposit'))fail('Correct the final checkout before changing its deposit.',409);
      if(isDeposit)b={...b,items:[]};
      if(!Array.isArray(b.items)||(!isDeposit&&b.items.length<1)||b.items.length>50) fail('Add at least one service or product.');
      const items=b.items.map(item=>{
        if(!['services','products'].includes(item.kind)) fail('Invalid sale item.');
        const source=required(item.kind,item.id),quantity=integer(item.quantity,'Quantity',1,1000);
        const previous=old?.items.find(x=>x.kind===item.kind&&x.id===item.id);
        const booked=appointment?.services.find(x=>item.kind==='services'&&x.id===item.id);
        if(source.active===false&&!previous&&!booked)fail(`${source.name} is inactive.`);
        const performer=required('staff',item.staff_id||staff.id);if(performer.active===false&&!old)fail('Select active staff for every service.');
        return {staff_id:performer.id,staff_name:performer.name,kind:item.kind,id:source.id,name:source.name,price:previous?.price??booked?.price??source.price,quantity};
      });
      if(appointment&&!isDeposit&&appointment.service_ids.some(id=>!items.some(x=>x.kind==='services'&&x.id===id))) fail('Include all booked services in the appointment payment.');
      const gross_total=items.reduce((s,x)=>s+x.price*x.quantity,0);
      const deposit_applied=appointment&&!isDeposit?depositTotal(appointment.id):0;
      const discount=isDeposit?0:money(b.discount??'0');if(discount>gross_total)fail('Discount cannot exceed subtotal.');
      const total=isDeposit?money(b.deposit_amount):gross_total-discount-deposit_applied;
      if(isDeposit&&(total<=0||total+depositTotal(appointment.id)-(old?.total||0)>appointment.total))fail('Deposit must be greater than zero and cannot exceed the remaining balance.');
      if(total<0)fail('Sale total cannot be less than the recorded deposit.'); if(!Number.isSafeInteger(total)||total>999999999) fail('Sale total is too large.');
      if(!['cash','card','split'].includes(b.method)) fail('Choose cash, card or split payment.');
      const cash=b.method==='cash'?total:b.method==='card'?0:money(b.cash);
      if(cash>total) fail('Cash portion cannot exceed the sale total.');
      const card=total-cash;
      if(card>0&&b.card_confirmed!==true) fail('Confirm payment was taken on your card terminal.');
      const tendered=cash?money(b.tendered):0;if(tendered<cash) fail('Cash received is less than the cash payment.');
      return {date:day,staff_id:staff.id,staff_name:staff.name,customer_id:customer?.id||'',customer_name:customer?.name||'Walk-in',appointment_id:appointment?.id||'',at:old?.at||new Date(now()).toISOString(),receipt_number:old?.receipt_number,discount,type:isDeposit?'deposit':'checkout',gross_total:isDeposit?total:gross_total,deposit_applied,items,total,cash,card,tendered,change:tendered-cash,method:b.method,notes:text(b.notes||'','Notes',false,1000),recorded_by:old?.recorded_by||actor};
    }
    if(kind==='cashups') {
      const day=date(b.date);if(day>today(now())) fail('You cannot cash up a future date.');
      if(list('cashups').some(x=>x.date===day&&x.id!==old?.id)) fail('This day has already been cashed up.',409);
      const sales=list('sales').filter(x=>x.date===day),opening=money(b.opening),counted=money(b.counted);
      const cash=sales.reduce((s,x)=>s+x.cash,0),card=sales.reduce((s,x)=>s+x.card,0);
      const refunds=list('refunds').filter(r=>r.date===day&&r.method==='cash').reduce((n,r)=>n+r.amount,0);
      return {date:day,at:old?.at||new Date(now()).toISOString(),completed_by:text(b.completed_by||actor,'Person completing cash-up',true,120),opening,counted,cash,card,refunds,expected:opening+cash-refunds,difference:counted-opening-cash+refunds,notes:text(b.notes||'','Notes',false,1000)};
    }
    fail('Unknown record.',404);
  }
  function mutate(kind,b,actor) {
    if(!kinds.includes(kind)) fail('Not found.',404);
    if((kind==='services'||kind==='staff')&&actor!=='admin') fail('Admin access required.',403);
    if(actor!=='admin'&&(!['customers','appointments','sales','cashups'].includes(kind)||(b.action==='delete'&&kind!=='appointments')||(['sales','cashups'].includes(kind)&&b.id))) fail('Admin access required.',403);
    let photoPlan=null;
    if(kind==='staff'&&actor==='admin'&&b&&b.action!=='delete'){if(b.photo==='')photoPlan='clear';else if(typeof b.photo==='string'&&b.photo.startsWith('data:image/'))photoPlan=decodeStaffPhoto(b.photo);}
    const result=transaction(()=>{
      if(kind==='sales'&&!b.id&&b.request_key) {
        const prior=db.prepare('SELECT record_id FROM requests WHERE key=?').get(String(b.request_key));
        if(prior) {const saved=get('sales',prior.record_id);if(!saved)fail('This payment was removed; start a new payment.',409);return {...saved,replayed:true};}
      }
      const id=kind==='settings'?'settings':kind==='hours'?'hours:'+b.staff_id:b.id||randomUUID();const old=get(kind,id);
      if(b.id&&!old) fail('Record no longer exists.',404);
      if(kind==='hours'&&old&&(b.version==null||b.version==='')&&isOpeningWeek(old.days)) b={...b,version:old.version};
      if(old&&Number(b.version)!==old.version) fail('This record changed. Refresh and try again.',409);
      if(b.action==='delete') {
        if(!old)fail('Record not found.',404);
        if(kind==='refunds'||kind==='hours')fail('This record cannot be deleted.');
        if(kind==='sales'&&list('refunds').some(r=>r.sale_id===id))fail('Refunded sales must be retained.',409);
        if(kind==='settings')fail('Business settings cannot be deleted.');
        if(['customers','staff','services'].includes(kind)&&list('appointments').some(x=>x.status!=='cancelled'&&x.status!=='completed'&&(kind==='customers'?x.customer_id===id:kind==='staff'?x.staff_id===id:x.service_ids.includes(id)))) fail('Update or cancel the linked appointments first.',409);
        if(kind==='products'&&list('sales').some(x=>x.items.some(i=>i.kind==='products'&&i.id===id))) fail('This product is linked to sales and must be retained for stock corrections.',409);
        if(kind==='appointments'&&list('sales').some(x=>x.appointment_id===id)) fail('Delete or correct the linked sale first.',409);
        if(kind==='appointments') cancelUnsent(id);
        if(kind==='sales') {openDate(old.date);if(old.type==='deposit'&&list('sales').some(s=>s.appointment_id===old.appointment_id&&s.type!=='deposit'))fail('Correct the final checkout before deleting its deposit.',409);stockChange(old,1,actor);if(old.appointment_id&&old.type!=='deposit'){const appointment=get('appointments',old.appointment_id);if(appointment)write('appointments',appointment.id,{...appointment,status:'booked'},actor,appointment);} /* receipt_numbers keeps this sale id, so the receipt number is never reused */}
        db.prepare('UPDATE records SET deleted=1,version=version+1 WHERE id=?').run(id);audit(actor,'delete',kind,id,old,null);return {id,deleted:true};
      }
      if(kind==='sales'&&old&&list('refunds').some(r=>r.sale_id===id))fail('Refunded sales must be retained unchanged.',409);
      if(kind==='appointments'&&b.action!=='delete') ensureOpeningHours(b.staff_id,actor);
      const data=validate(kind,b,old,actor);
      if(kind==='staff'&&photoPlan==='clear')data.photo='';
      else if(kind==='staff'&&photoPlan)data.photo=photoPlan.ext;
      if(kind==='sales') {
        if(old)stockChange(old,1,actor);stockChange(data,-1,actor);
        if(data.appointment_id&&data.type!=='deposit'){const appointment=required('appointments',data.appointment_id);write('appointments',appointment.id,{...appointment,status:'paid'},actor,appointment);}
      }
      if(kind==='sales'&&!old)data.receipt_number=receiptNumber(id);
      const result=write(kind,id,data,actor,old);
      if(kind==='staff'&&!old) ensureOpeningHours(id,actor);
      if(kind==='sales'&&!old){if(typeof b.request_key!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(b.request_key))fail('A payment reference is required.');db.prepare('INSERT INTO requests(key,record_id) VALUES(?,?)').run(b.request_key,id);}
      return actor==='staff'&&kind==='cashups'?cashupForStaff(result):result;
    });
    if(kind==='staff'&&result?.deleted)clearStaffPhoto(result.id);
    else if(photoPlan==='clear'&&result?.id)clearStaffPhoto(result.id);
    else if(photoPlan?.ext&&result?.id)commitStaffPhoto(result.id,photoPlan);
    deliverDue();
    return result;
  }
  const cashupForStaff=({id,date,at,completed_by,opening,counted,cash,refunds,expected,difference,notes})=>({id,date,at,completed_by,opening,counted,cash,refunds,expected,difference,notes});
  function cashSummary(day){date(day);return {cash:list('sales').filter(s=>s.date===day).reduce((n,s)=>n+s.cash,0),refunds:list('refunds').filter(r=>r.date===day&&r.method==='cash').reduce((n,r)=>n+r.amount,0)};}
  function drawerClaim(key,actor,reason){const inserted=db.prepare('INSERT OR IGNORE INTO drawer_events(id,status) VALUES(?,?)').run(key,'attempted');if(!inserted.changes)return false;audit(actor,'drawer_request','drawer',key,null,{reason,status:'attempted'});return true;}
  function drawerResult(key,actor,status){db.prepare('UPDATE drawer_events SET status=? WHERE id=?').run(status,key);audit(actor,'drawer_result','drawer',key,null,{status});}

  function receipt(id){const sale=get('sales',id);if(!sale)fail('Receipt not found.',404);const settings=get('settings','settings');return {...sale,businessName:settings?.name||'Beauty For All',businessAddress:settings?.address||'',businessPhone:settings?.phone||''};}
  function businessProfile(){const settings=get('settings','settings');return {name:settings?.name||'Beauty For All',phone:settings?.phone||'',address:settings?.address||''};}
  function cancelUnsent(appointmentId){db.prepare("UPDATE sms_messages SET status='cancelled', cancelled_at=? WHERE appointment_id=? AND status IN ('not_connected','missing_number','scheduled')").run(new Date(now()).toISOString(),appointmentId);}
  function appointmentFace(appointment){return JSON.stringify({date:appointment.date,time:appointment.time,staff_id:appointment.staff_id,customer_id:appointment.customer_id,mobile:appointment.mobile||'',services:(appointment.services||[]).map(service=>`${service.id}:${service.name}`)});}
  function replaceSms(appointment){
    cancelUnsent(appointment.id);
    const stamp=now(),created=new Date(stamp).toISOString();
    const insert=db.prepare('INSERT INTO sms_messages(id,appointment_id,customer_name,kind,status,phone,body,scheduled_for,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const message of planMessages(appointment,businessProfile(),stamp)) insert.run(randomUUID(),appointment.id,appointment.customer_name,message.kind,message.phone?'not_connected':'missing_number',message.phone,message.body,message.scheduled_for,created);
  }
  function syncAppointmentSms(before,after){
    if(['cancelled','no_show','completed'].includes(after.status)){cancelUnsent(after.id);return;}
    if(!before||appointmentFace(before)!==appointmentFace(after)) replaceSms(after);
  }
  function deliverDue(){
    if(!smsProvider?.send) return;
    for(const message of db.prepare("SELECT * FROM sms_messages WHERE status='not_connected'").all()){
      try{
        if(!String(message.phone||'').trim()){db.prepare("UPDATE sms_messages SET status='missing_number' WHERE id=?").run(message.id);continue;}
        if(Date.parse(message.scheduled_for)>now()){db.prepare("UPDATE sms_messages SET status='scheduled' WHERE id=?").run(message.id);continue;}
        smsProvider.send({id:message.id,appointment_id:message.appointment_id,customer_name:message.customer_name,kind:message.kind,phone:message.phone,body:message.body,scheduled_for:message.scheduled_for});
        db.prepare("UPDATE sms_messages SET status='sent' WHERE id=?").run(message.id);
      }catch{db.prepare("UPDATE sms_messages SET status='failed' WHERE id=?").run(message.id);}
    }
  }
  function auditSecurity(actor,action,detail){audit(actor,action,'security',action,null,{detail});}
  function every(kind){return db.prepare('SELECT * FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(row=>({...decode(row),deleted:row.deleted===1}));}
  function customerHistory(id) {
    const customer=required('customers',id);
    return {customer,appointments:every('appointments').filter(a=>a.customer_id===id),payments:every('sales').filter(s=>s.customer_id===id).map(({recorded_by,...sale})=>sale)};
  }
  function state(role) {
    deliverDue();
    const result={role,today:today(now())};
    for(const kind of ['customers','staff','services','products','appointments']) result[kind]=list(kind);
    result.services=result.services.map(service=>({...service,category:service.category||'',active:service.active!==false}));
    result.products=result.products.map(product=>({...product,category:product.category||'',cost:product.cost||0,supplier:product.supplier||'',reorder:product.reorder??0,active:product.active!==false}));
    const grouped=new Map();
    for(const message of db.prepare('SELECT appointment_id,status FROM sms_messages').all()){const bucket=grouped.get(message.appointment_id)||[];bucket.push(message);grouped.set(message.appointment_id,bucket);}
    const paidAppointments=new Map(list('sales').filter(s=>s.appointment_id&&s.type!=='deposit').map(s=>[s.appointment_id,s.id]));
    result.appointments=result.appointments.map(a=>({...a,people:a.people??1,mobile:a.mobile??get('customers',a.customer_id)?.phone??'',deposit:depositTotal(a.id),remaining:paidAppointments.has(a.id)?0:a.total-depositTotal(a.id),paid:paidAppointments.has(a.id),receipt_id:paidAppointments.get(a.id)||null,sms:smsRank(grouped.get(a.id)||[])}));
    result.businessName=get('settings','settings')?.name||'Beauty For All';
    if(role!=='admin')result.staff=result.staff.map(member=>({id:member.id,name:member.name,active:member.active!==false,photo:member.photo||'',version:member.version}));
    if(role==='admin') {
      result.hours=list('hours');result.refunds=list('refunds');result.sales=list('sales');result.cashups=list('cashups');result.settings=get('settings','settings')||{name:'Beauty For All',phone:'',address:''};
      result.audit=db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all().map(row=>({...row,before:row.before_data?JSON.parse(row.before_data):null,after:row.after_data?JSON.parse(row.after_data):null,before_data:undefined,after_data:undefined}));
      result.sms=db.prepare('SELECT id,appointment_id,customer_name,kind,status,phone,body,scheduled_for,created_at,cancelled_at FROM sms_messages ORDER BY rowid DESC LIMIT 100').all();
      result.smsConnected=Boolean(smsProvider?.send);
    } else result.business=businessProfile();
    return result;
  }
  for(const member of list('staff')) ensureOpeningHours(member.id,'admin');
  return {state,mutate,receipt,customerHistory,cashSummary,drawerClaim,drawerResult,auditSecurity,staffPhoto:readStaffPhoto,close:()=>db.close()};
}
