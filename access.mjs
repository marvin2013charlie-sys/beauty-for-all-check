import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { connect as connectNet } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function normalName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
export function normalEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}
export function validEmail(value) {
  return typeof value === 'string' && value.length <= 160 && /^[^\s@]{1,64}@[^\s@]{1,120}\.[^\s@]{2,24}$/.test(value);
}
export function validDob(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1900) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  return value <= today;
}
export function maskEmail(email) {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}
export async function hashSecret(value) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(value, salt, 64)).toString('hex') };
}
export async function checkSecret(value, record) {
  if (!record?.salt || !/^[0-9a-f]{128}$/.test(record.hash || '')) return false;
  const digest = await scrypt(String(value), record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return expected.length === digest.length && timingSafeEqual(digest, expected);
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function mailConfig(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Enter the email mailbox.');
  const enabled = input.enabled === true || input.enabled === 'true';
  const host = String(input.host || '').trim();
  const port = Number(input.port);
  const username = String(input.username || '').trim();
  const from = normalEmail(input.from);
  const password = input.password == null || input.password === '' ? previous?.password || '' : String(input.password);
  if (enabled || host || username || from || password) {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) fail('Enter the email server address.');
    if (port !== 465 && port !== 587) fail('Use email port 465 or 587.');
    if (!username || username.length > 160 || /[\r\n]/.test(username)) fail('Enter the mailbox username.');
    if (!password || password.length > 200 || /[\r\n]/.test(password)) fail('Enter the mailbox password.');
    if (!validEmail(from)) fail('Enter the From email address.');
  }
  return { enabled, host, port: port === 465 ? 465 : 587, username, password, from };
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const failConnect = error => { socket.destroy(); reject(error); };
    socket.once('secureConnect', () => done());
    socket.once('connect', () => { if (!socket.encrypted) done(); });
    socket.once('error', failConnect);
    function done() { socket.off('error', failConnect); resolve(socket); }
  });
}

function smtpChannel(socket) {
  let buffer = '';
  let waiter = null;
  socket.setEncoding('utf8');
  socket.on('data', chunk => { buffer += chunk; settle(); });
  socket.on('error', error => { if (waiter) { waiter.reject(error); waiter = null; } });
  function take() {
    const lines = [];
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      lines.push(line);
      if (/^\d{3} /.test(line)) return { code: Number(line.slice(0, 3)), lines };
    }
    return null;
  }
  function settle() {
    if (!waiter) return;
    const reply = take();
    if (!reply) return;
    const current = waiter;
    waiter = null;
    current.resolve(reply);
  }
  return {
    read() {
      const ready = take();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiter = null; reject(new Error('The email server did not reply in time.')); }, 10000);
        waiter = { resolve: reply => { clearTimeout(timer); resolve(reply); }, reject: error => { clearTimeout(timer); reject(error); } };
        settle();
      });
    },
    write(line) { socket.write(`${line}\r\n`); },
  };
}

async function expectCode(channel, code) {
  const reply = await channel.read();
  if (reply.code !== code) fail(`The email server rejected the message (${reply.code}).`, 502);
  return reply;
}

export async function sendSmtp({ host, port, username, password, from, to, subject, text, socket }) {
  const connection = socket || await openMailbox({ host, port });
  const channel = smtpChannel(connection);
  try {
    await expectCode(channel, 220);
    channel.write('EHLO beautyforall');
    await expectCode(channel, 250);
    if (!socket && port === 587) {
      channel.write('STARTTLS');
      await expectCode(channel, 220);
      connection.removeAllListeners('data');
      connection.removeAllListeners('error');
      const secure = connectTls({ socket: connection, servername: host });
      await waitForConnect(secure);
      return sendSmtp({ host, port: 465, username, password, from, to, subject, text, socket: secure });
    }
    channel.write(`AUTH PLAIN ${Buffer.from(`\u0000${username}\u0000${password}`).toString('base64')}`);
    await expectCode(channel, 235);
    channel.write(`MAIL FROM:<${from}>`);
    await expectCode(channel, 250);
    channel.write(`RCPT TO:<${to}>`);
    await expectCode(channel, 250);
    channel.write('DATA');
    await expectCode(channel, 354);
    const body = String(text).replace(/\r?\n/g, '\n').split('\n').map(line => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
    connection.write(`From: Beauty For All <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`);
    await expectCode(channel, 250);
    channel.write('QUIT');
  } finally {
    connection.end();
  }
}

function openMailbox({ host, port }) {
  if (port === 465) return waitForConnect(connectTls({ host, port, servername: host }));
  return waitForConnect(connectNet({ host, port }));
}

export function createAccess(dataDir, now = Date.now) {
  const recoveryPath = join(dataDir, 'recovery.json');
  const mailPath = join(dataDir, 'mail.json');
  async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; return null; }
  }
  async function writePrivate(path, value) {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await chmod(path, 0o600);
  }
  async function readRecovery() {
    const data = await readJson(recoveryPath);
    if (!data?.email || !data.name?.hash || !data.dob?.hash) return null;
    return { email: data.email, name: data.name, dob: data.dob, tokens: Array.isArray(data.tokens) ? data.tokens : [] };
  }
  async function readMail() {
    const data = await readJson(mailPath);
    if (!data) return null;
    try { return mailConfig({ ...data, enabled: data.enabled }, data); }
    catch { return null; }
  }
  function publicStatus(profile, mail) {
    return {
      recoveryRegistered: Boolean(profile),
      recoveryEmail: profile ? maskEmail(profile.email) : '',
      mailConfigured: Boolean(mail?.enabled),
      mailHost: mail?.host || '',
      mailPort: mail?.port || 587,
      mailUsername: mail?.username || '',
      mailFrom: mail?.from || '',
    };
  }
  return {
    readMail,
    async status() { return publicStatus(await readRecovery(), await readMail()); },
    async saveProfile({ name, email, dob }) {
      const cleanName = normalName(name);
      const cleanEmail = normalEmail(email);
      if (cleanName.length < 2 || cleanName.length > 120) fail('Enter the admin’s full name.');
      if (!validEmail(cleanEmail)) fail('Enter the admin email address.');
      if (!validDob(dob, now())) fail('Enter the admin’s date of birth.');
      const profile = { email: cleanEmail, name: await hashSecret(cleanName), dob: await hashSecret(dob), tokens: [] };
      await writePrivate(recoveryPath, profile);
      return publicStatus(profile, await readMail());
    },
    async requestReset({ name, email, dob }, send, baseUrl) {
      const profile = await readRecovery();
      if (!profile) return { status: 'missing' };
      const emailOk = normalEmail(email) === profile.email;
      const nameOk = await checkSecret(normalName(name), profile.name);
      const dobOk = await checkSecret(String(dob ?? ''), profile.dob);
      if (!emailOk || !nameOk || !dobOk) return { status: 'mismatch' };
      if (typeof send !== 'function' || typeof baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) return { status: 'no_mail' };
      const token = randomBytes(32).toString('hex');
      const next = { ...profile, tokens: [{ hash: tokenHash(token), expires: now() + 20 * 60 * 1000 }] };
      await writePrivate(recoveryPath, next);
      const text = ['Beauty For All', '', 'A new admin PIN was requested.', '', 'Open this link on the salon computer to choose a new PIN:', `${baseUrl}/recover/reset?token=${token}`, '', 'This link expires in 20 minutes and can be used once.', 'If you did not ask for this, you can ignore this email.'].join('\n');
      try {
        await send({ to: profile.email, subject: 'Reset your Beauty For All admin PIN', text });
      } catch {
        await writePrivate(recoveryPath, { ...profile, tokens: [] });
        return { status: 'send_failed' };
      }
      return { status: 'sent' };
    },
    async takeToken(token) {
      if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
      const profile = await readRecovery();
      const hash = tokenHash(token);
      const match = profile?.tokens.find(item => item.hash === hash && item.expires > now());
      if (!match) return null;
      await writePrivate(recoveryPath, { ...profile, tokens: [] });
      return profile.email;
    },
    async saveMail(input) {
      const saved = mailConfig(input, await readMail());
      await writePrivate(mailPath, saved);
      return publicStatus(await readRecovery(), saved);
    },
  };
}
