import http from 'node:http';
import { openStore } from './store.mjs';
import { createHardware, printerQueues } from './hardware.mjs';
import { checkSecret, createAccess, sendSmtp } from './access.mjs';
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const roles = ['admin', 'staff'];
const sessionLifetime = 4 * 60 * 60 * 1000;
const recoveryCopy = {
  missing: 'Admin recovery has not been saved yet. An admin who still knows the PIN can save their name, email and date of birth in Settings.',
  mismatch: 'Those details do not match the admin registered for recovery.',
  no_mail: 'Those details match, but no email mailbox is connected, so nothing was sent.',
  send_failed: 'The details matched, but the email could not be sent. No reset link was issued.',
  sent: 'A link to choose a new admin PIN was sent to the registered email. It expires in 20 minutes and works once.',
};

export async function createCredentials(dataDir, suppliedPins) {
  await mkdir(dataDir, {recursive:true, mode:0o700});
  const pins = suppliedPins || {admin:String(randomInt(10000)).padStart(4,'0'), staff:String(randomInt(10000)).padStart(4,'0')};
  if (!suppliedPins) while (pins.admin === pins.staff) pins.staff = String(randomInt(10000)).padStart(4,'0');
  if (roles.some(role => !/^\d{4}$/.test(pins[role])) || pins.admin === pins.staff) throw new Error('Choose two different four-digit PINs.');
  const credentials = {};
  for (const role of roles) {
    const salt = randomBytes(16).toString('hex');
    credentials[role] = {salt, hash:(await scrypt(pins[role], salt, 64)).toString('hex')};
  }
  await writeFile(join(dataDir,'credentials.json'), JSON.stringify(credentials), {mode:0o600});
  await chmod(join(dataDir,'credentials.json'), 0o600);
  if (!suppliedPins) {
    await writeFile(join(dataDir,'LOCAL_ACCESS.txt'), `Beauty For All — local preview access\n\nAdmin PIN: ${pins.admin}\nStaff PIN: ${pins.staff}\n\nThese PINs are for this local preview only.\nDelete this handover file once recorded. It is never served over HTTP.\nRun npm run reset-pins to generate new PINs (stop and restart the server).\n`, {mode:0o600});
    await chmod(join(dataDir,'LOCAL_ACCESS.txt'), 0o600);
  }
  return credentials;
}

export async function createApp({dataDir = join(root,'.local'), suppliedPins, now = Date.now, drawer = null, hardwareTransport, smsProvider = null, mailer = null} = {}) {
  let credentials;
  try { credentials = JSON.parse(await readFile(join(dataDir,'credentials.json'),'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; credentials = await createCredentials(dataDir, suppliedPins); }
  const store = openStore(dataDir,now,smsProvider);
  const hardware = createHardware(dataDir,{transport:hardwareTransport});
  const till = drawer || hardware;
  const sessions = new Map();
  const attempts = new Map();
  const traffic = new Map();
  const recoveryAttempts = new Map();
  const access = createAccess(dataDir, now);
  const staticFiles = new Map([['/','index.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/favicon.svg','favicon.svg'],['/recover.js','recover.js'],['/workspace.css','workspace.css'],['/workspace.js','workspace.js']]);
  const mime = file => file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
  function session(req) {
    const token = /(?:^|;\s*)bfa_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const value = sessions.get(token);
    if (!value || value.expires <= now()) { if (token) sessions.delete(token); return null; }
    return {...value, token};
  }
  const four = value => typeof value === 'string' && /^\d{4}$/.test(value);
  async function sameAsOtherRole(role, pin) {
    return checkSecret(pin, credentials[role === 'admin' ? 'staff' : 'admin']);
  }
  async function replacePin(role, pin) {
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(pin, salt, 64)).toString('hex');
    const next = {...credentials, [role]: {salt, hash}};
    const path = join(dataDir, 'credentials.json');
    await writeFile(path, JSON.stringify(next), {mode: 0o600});
    await chmod(path, 0o600);
    credentials[role] = next[role];
  }
  function endRole(role, exceptToken) {
    for (const [token, value] of sessions) if (value.role === role && token !== exceptToken) sessions.delete(token);
  }
  function recoveryLimited(address) {
    let attempt = recoveryAttempts.get(address);
    if (!attempt || attempt.until <= now()) {
      attempt = {count: 0, until: now() + 10 * 60 * 1000};
      recoveryAttempts.set(address, attempt);
    }
    attempt.count += 1;
    return attempt.count > 8;
  }
  async function readJson(req, limit) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > limit) return {tooLarge: true};
    }
    try {
      const body = JSON.parse(raw || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) return {invalid: true};
      return {body};
    } catch {
      return {invalid: true};
    }
  }
  async function recoverySender() {
    if (typeof mailer?.send === 'function') return message => mailer.send(message);
    const mail = await access.readMail();
    if (!mail?.enabled) return null;
    return message => sendSmtp({host: mail.host, port: mail.port, username: mail.username, password: mail.password, from: mail.from, to: message.to, subject: message.subject, text: message.text});
  }
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    const pathname = new URL(req.url,'http://localhost').pathname;
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, payload, type = 'application/json') => {
      res.writeHead(status,{'Content-Type':`${type}; charset=utf-8`});
      res.end(type === 'application/json' ? JSON.stringify(payload) : payload);
    };
    const redirect = path => { res.writeHead(303,{Location:path}); res.end(); };
    const sessionCookie = (req,token,maxAge) => `bfa_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.RENDER === 'true' && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
    const currentSession = session(req);
    try {
      if (req.method === 'POST') {
        const https = process.env.RENDER === 'true' && req.headers['x-forwarded-proto'] === 'https';
        const expectedOrigin = `${https ? 'https' : 'http'}://${req.headers.host}`;
        if ((req.headers.origin && req.headers.origin !== expectedOrigin) || (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site']))) return send(403,{error:'Request not allowed.'});
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415,{error:'JSON required.'});
        if (pathname === '/api/recover' || pathname === '/api/recover/reset' || pathname.startsWith('/api/access/')) {
          if (pathname === '/api/recover' || pathname === '/api/recover/reset') {
            if (recoveryLimited(req.socket.remoteAddress)) { res.setHeader('Retry-After','600'); return send(429,{error:'Too many recovery attempts. Please wait and try again.'}); }
          } else if (!currentSession) return send(401,{error:'Please sign in.'});
          else if (currentSession.role !== 'admin') return send(403,{error:'Admin access required.'});
          const parsed = await readJson(req, 8192);
          if (parsed.tooLarge) return send(413,{error:'Request too large.'});
          if (parsed.invalid) return send(400,{error:'Enter the details again.'});
          const body = parsed.body;
          if (pathname === '/api/access/staff-pin') {
            if (!four(body.pin) || body.pin !== body.confirm) return send(400,{error:'Enter the same four-digit staff PIN twice.'});
            if (await checkSecret(body.pin, credentials.staff) || await sameAsOtherRole('staff', body.pin)) return send(400,{error:'Choose a different four-digit PIN.'});
            await replacePin('staff', body.pin);
            endRole('staff');
            store.auditSecurity('admin','staff_pin_reset','Admin set a new staff PIN.');
            return send(200,{ok:true});
          }
          if (pathname === '/api/access/admin-pin') {
            if (!four(body.current) || !four(body.pin) || body.pin !== body.confirm) return send(400,{error:'Enter your current PIN and the same new four-digit PIN twice.'});
            const record = credentials.admin;
            const digest = await scrypt(body.current, record.salt, 64);
            if (!timingSafeEqual(digest, Buffer.from(record.hash,'hex'))) return send(400,{error:'That current PIN isn’t correct.'});
            if (body.pin === body.current || await sameAsOtherRole('admin', body.pin)) return send(400,{error:'Choose a different four-digit PIN.'});
            await replacePin('admin', body.pin);
            endRole('admin', currentSession.token);
            store.auditSecurity('admin','admin_pin_changed','Admin changed the admin PIN.');
            return send(200,{ok:true});
          }
          if (pathname === '/api/access/recovery') {
            const status = await access.saveProfile(body);
            store.auditSecurity('admin','admin_recovery_updated','Admin saved recovery details.');
            return send(200, status);
          }
          if (pathname === '/api/access/mail') {
            const status = await access.saveMail(body);
            store.auditSecurity('admin','mail_settings_updated','Admin updated the email mailbox.');
            return send(200, status);
          }
          if (pathname === '/api/recover') {
            const result = await access.requestReset(body, await recoverySender(), process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${req.socket.localPort}`);
            const detail = {missing:'Admin recovery is not set up.',mismatch:'Admin recovery details did not match.',no_mail:'Recovery details matched. No mailbox is connected, so nothing was sent.',send_failed:'Recovery details matched, but the email could not be sent.',sent:'A reset link was emailed to the registered admin address.'}[result.status];
            store.auditSecurity('admin', result.status === 'missing' || result.status === 'mismatch' ? 'admin_recovery_rejected' : 'admin_recovery_requested', detail);
            return send(200,{status:result.status,message:recoveryCopy[result.status]});
          }
          if (pathname === '/api/recover/reset') {
            if (!four(body.pin) || body.pin !== body.confirm) return send(400,{error:'Enter the same four-digit PIN twice.'});
            if (await sameAsOtherRole('admin', body.pin)) return send(400,{error:'Choose a different four-digit PIN.'});
            const email = await access.takeToken(body.token);
            if (!email) return send(400,{error:'This reset link is invalid or has expired.'});
            await replacePin('admin', body.pin);
            endRole('admin');
            store.auditSecurity('admin','admin_pin_reset','Admin set a new PIN from the recovery link.');
            return send(200,{ok:true});
          }
          return send(404,{error:'Not found.'});
        }
        if (!['/api/login','/api/logout'].includes(pathname) && !pathname.startsWith('/api/records/') && !pathname.startsWith('/api/hardware')) return send(404,{error:'Not found.'});
        if (pathname.startsWith('/api/hardware')) {
          if (!currentSession) return send(401,{error:'Please sign in.'});
          let raw='';
          for await (const chunk of req) {raw+=chunk;if(Buffer.byteLength(raw)>4096)return send(413,{error:'Request too large.'});}
          let body;try{body=JSON.parse(raw);}catch{return send(400,{error:'Enter the printer connection.'});}
          if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{error:'Enter the printer connection.'});
          if(pathname!=='/api/hardware/print'&&currentSession.role!=='admin')return send(403,{error:'Admin access required.'});
          if(pathname==='/api/hardware'){await hardware.save(body);return send(200,await hardware.status('admin'));}
          if(pathname==='/api/hardware/test-connection'){await hardware.probe(body);return send(200,{ok:true});}
          if(pathname==='/api/hardware/test-print'){await hardware.printTest(body);return send(200,{ok:true});}
          if(pathname==='/api/hardware/print'){
            if(typeof body.id!=='string'||!/^[0-9a-f-]{36}$/i.test(body.id))return send(400,{error:'Choose a receipt to print.'});
            await hardware.print(store.receipt(body.id));return send(200,{ok:true});
          }
          return send(404,{error:'Not found.'});
        }
        if (pathname.startsWith('/api/records/')) {
          if (!currentSession) return send(401,{error:'Please sign in.'});
          let raw='';
          const recordLimit=pathname.endsWith('/staff')?2200000:65536;
          for await (const chunk of req) {raw+=chunk;if(Buffer.byteLength(raw)>recordLimit)return send(413,{error:'Request too large.'});}
          let body;try {body=JSON.parse(raw);}catch{return send(400,{error:'Invalid record.'});}
          if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{error:'Invalid record.'});
          const kind=pathname.split('/').pop(),actor=currentSession.role;
          async function openDrawer(key,reason){
            if(!store.drawerClaim(key,actor,reason))return 'already_requested';
            let status='not_connected';
            if(till){try{const result=await till.open({key,reason});status=result==='not_connected'?'not_connected':'command_sent';}catch{status='failed';}}
            store.drawerResult(key,actor,status);return status;
          }
          if(kind==='drawer'){
            if(actor!=='admin')return send(403,{error:'Admin access required.'});
            if(typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500||typeof body.request_key!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(body.request_key))return send(400,{error:'A reason and request reference are required.'});
            return send(200,{status:await openDrawer('manual:'+body.request_key,body.reason)});
          }
          const saved=store.mutate(kind,body,actor);
          if(kind==='sales'&&!body.id&&!saved.replayed&&saved.cash>0)saved.drawer_status=await openDrawer('sale:'+saved.id,'Completed cash transaction '+saved.receipt_number);
          return send(200,saved);
        }
        if (pathname === '/api/logout') {
          if (currentSession) { store.auditSecurity(currentSession.role,'sign_out','Signed out.'); sessions.delete(currentSession.token); }
          res.setHeader('Set-Cookie',sessionCookie(req,'',0));
          return send(200,{ok:true});
        }
        const address = req.socket.remoteAddress;
        let activity = traffic.get(address);
        if (!activity || activity.until <= now()) { activity = {count:0,until:now()+60000}; traffic.set(address,activity); }
        if (++activity.count > 30) { res.setHeader('Retry-After','60'); return send(429,{error:'Too many requests. Please wait a minute.'}); }
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1024) return send(413,{error:'Request too large.'}); }
        let body;
        try { body = JSON.parse(raw); } catch { return send(400,{error:'Enter your four-digit PIN.'}); }
        if (!body || !roles.includes(body.role) || typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin)) return send(400,{error:'Choose a role and enter your four-digit PIN.'});
        const {role,pin} = body;
        const key = `${address}:${role}`;
        let attempt = attempts.get(key);
        if (attempt?.until > now() && attempt.failures >= 5) {
          const seconds = Math.ceil((attempt.until-now())/1000);
          res.setHeader('Retry-After',String(seconds));
          return send(429,{error:`Too many attempts. Try again in ${seconds} seconds.`});
        }
        if (!attempt || attempt.until <= now()) { attempt = {failures:0,until:now()+60000}; attempts.set(key,attempt); }
        const record = credentials[role];
        const digest = await scrypt(pin, record.salt, 64);
        if (!timingSafeEqual(digest,Buffer.from(record.hash,'hex'))) {
          attempt.failures++;
          if (attempt.failures >= 5) attempt.until = now()+30000;
          store.auditSecurity(role,'sign_in_rejected','Rejected sign-in.');
          return send(401,{error:'That PIN isn’t correct. Please try again.'});
        }
        attempts.delete(key);
        if (currentSession) sessions.delete(currentSession.token);
        store.auditSecurity(role,'sign_in','Signed in.');
        const token = randomBytes(32).toString('hex');
        sessions.set(token,{role,expires:now()+sessionLifetime});
        res.setHeader('Set-Cookie',sessionCookie(req,token,sessionLifetime/1000));
        return send(200,{ok:true,redirect:`/${role}`});
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405,{error:'Method not allowed.'});
      if (pathname.startsWith('/api/customers/')) {
        if (!currentSession) return send(401,{error:'Please sign in.'});
        const history=store.customerHistory(pathname.split('/').pop());
        if (currentSession.role==='admin') return send(200,history);
        return send(200,{customer:history.customer,payments:[],appointments:history.appointments.map(a=>({id:a.id,date:a.date,time:a.time,staff_name:a.staff_name,status:a.status,deleted:a.deleted,services:(a.services||[]).map(s=>({name:s.name}))}))});
      }
      if (pathname.startsWith('/api/staff-photos/')) {
        if (!currentSession) return send(401,{error:'Please sign in.'});
        const photo=store.staffPhoto(pathname.split('/').pop());
        if (!photo) return send(404,{error:'No profile photo.'});
        res.writeHead(200,{'Content-Type':photo.type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
        res.end(photo.bytes);
        return;
      }
      if (pathname.startsWith('/api/receipts/')) return currentSession ? send(200,store.receipt(pathname.split('/').pop())) : send(401,{error:'Please sign in.'});
      if (pathname.startsWith('/api/cash-summary/')) {
        if (!currentSession) return send(401,{error:'Please sign in.'});
        if (currentSession.role!=='admin') return send(403,{error:'This workspace is not available for your role.'});
        return send(200,store.cashSummary(pathname.split('/').pop()));
      }
      if (pathname === '/api/hardware/queues') {
        if (!currentSession) return send(401,{error:'Please sign in.'});
        if (currentSession.role !== 'admin') return send(403,{error:'Admin access required.'});
        return send(200,{queues:await printerQueues()});
      }
      if (pathname === '/api/workspace') {
        if (!currentSession) return send(401,{error:'Please sign in.'});
        const hardwareStatus = await hardware.status(currentSession.role);
        const payload = {...store.state(currentSession.role),drawer_connected:drawer?true:hardwareStatus.enabled,hardware:hardwareStatus};
        if (currentSession.role === 'admin') payload.access = await access.status();
        return send(200,payload);
      }
      if (pathname === '/api/session') return currentSession ? send(200,{role:currentSession.role}) : send(401,{error:'Please sign in.'});
      if (pathname === '/admin' || pathname === '/staff' || pathname === '/admin/design') {
        if (!currentSession) return redirect('/');
        const requiredRole = pathname === '/staff' ? 'staff' : 'admin';
        if (currentSession.role !== 'admin' && currentSession.role !== requiredRole) return send(403,{error:'This workspace is not available for your role.'});
        if (pathname === '/admin' || pathname === '/staff') return send(200,(await readFile(join(root,'public','workspace.html'),'utf8')).replaceAll('{{ROLE}}',currentSession.role).replaceAll('{{MODE}}',pathname.slice(1)),'text/html');
        return redirect('/admin');
      }
      if (pathname === '/recover' || pathname === '/recover/reset') return send(200,await readFile(join(root,'public','recover.html'),'utf8'),'text/html');
      if (pathname === '/' && currentSession) return redirect(`/${currentSession.role}`);
      const file = staticFiles.get(pathname);
      if (!file) return send(404,{error:'Not found.'});
      return send(200,await readFile(join(root,'public',file)),mime(file));
    } catch (error) {
      if (!error.status) console.error('Request failed:',error.message);
      if (!res.headersSent) send(error.status||500,{error:error.status?error.message:'Something went wrong. Please try again.'});
      else res.end();
    }
  });
  const cleanup = setInterval(() => {
    for (const [key,value] of sessions) if (value.expires <= now()) sessions.delete(key);
    for (const map of [attempts,traffic,recoveryAttempts]) for (const [key,value] of map) if (value.until <= now()) map.delete(key);
  },60000).unref();
  server.on('close',() => {clearInterval(cleanup);store.close();});
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--reset-pins')) {
    const dataDir = process.env.DATA_DIR || join(root,'.local');
    await createCredentials(dataDir);
    console.log(`New local PINs saved to ${join(dataDir,'LOCAL_ACCESS.txt')}. Restart the server to apply them.`);
  } else {
    const dataDir = process.env.DATA_DIR || join(root,'.local');
    const host = process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1';
    const suppliedPins = process.env.ADMIN_PIN && process.env.STAFF_PIN ? {admin:process.env.ADMIN_PIN, staff:process.env.STAFF_PIN} : undefined;
    const server = await createApp({dataDir, suppliedPins});
    const port = Number(process.env.PORT || 4187);
    server.listen(port,host,() => console.log(`Beauty For All: http://${host}:${port}\nLocal PINs: ${join(dataDir,'LOCAL_ACCESS.txt')}`));
  }
}
