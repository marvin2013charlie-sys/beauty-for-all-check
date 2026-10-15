import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const COLS = 48;
// StarPRNT ESC BEL: 200ms on, 200ms off, peripheral drive 1. The 14×16 drawer plugs into that port.
const DRAWER_KICK = Buffer.from([0x1b, 0x40, 0x18, 0x1b, 0x07, 0x14, 0x14, 0x07]);

export const printerModel = {name:'Star TSP143IV UE', detail:'USB and Ethernet thermal receipt printer'};
export const drawerModel = {name:'14×16 in. printer-driven cash drawer', detail:'Plugs into the DK port on the printer. The printer is required.'};

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const offline = () => fail('The receipt printer did not respond. Check it is switched on and the address or USB cable is right.', 502);

function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export function hardwareConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Enter the printer connection.');
  const connection = input.connection === 'usb' || input.connection === 'ethernet' ? input.connection : '';
  if (!connection) fail('Choose Ethernet or USB.');
  const enabled = input.enabled === true || input.enabled === 'true';
  let host = '', usbQueue = '';
  if (connection === 'ethernet') {
    host = String(input.host || '').trim();
    if ((enabled || host) && !isPrivateIpv4(host)) fail('Enter the printer’s private network address, such as 192.168.1.50.');
  } else {
    usbQueue = String(input.usbQueue || '').trim();
    if (!/^[A-Za-z0-9_-]{0,64}$/.test(usbQueue)) fail('The USB printer queue name can only use letters, numbers, hyphens and underscores.');
    if (enabled && !usbQueue) fail('Enter the USB printer queue. Add the Star printer on this Mac first.');
  }
  return {enabled, connection, host, port:9100, usbQueue};
}

const clean = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replaceAll('£', '#').replace(/[^\x20-\x7E]/g, '').trim();
const money = pence => { const amount = Number(pence) || 0; return `${amount < 0 ? '-' : ''}#${(Math.abs(amount) / 100).toFixed(2)}`; };
const row = (left, right = '') => {
  const start = clean(left), end = clean(right);
  if (!end) return start.slice(0, COLS);
  const room = Math.max(1, COLS - end.length);
  return `${start.slice(0, room - 1).padEnd(room - 1, ' ')} ${end}`;
};
const text = value => Buffer.from(`${clean(value).slice(0, COLS)}\n`, 'ascii');
const bytes = (...values) => Buffer.from(values);
const when = sale => {
  const date = sale.at ? new Date(sale.at) : null;
  if (!date || Number.isNaN(date.getTime())) return clean(sale.date || '');
  return clean(new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}).format(date));
};

export function receiptBytes(sale, business = {}) {
  const name = clean(business.name || sale.businessName || 'Beauty For All') || 'Beauty For All';
  const address = String(business.address || sale.businessAddress || '277 Blagreaves Lane\nDE23 1PT').split(/\n|,/).map(clean).filter(Boolean);
  const phone = clean(business.phone || sale.businessPhone || '');
  const staff = [...new Set((sale.items || []).map(item => item.staff_name).filter(Boolean))].join(', ') || sale.staff_name || '';
  const parts = [
    bytes(0x1b, 0x40, 0x18), bytes(0x1b, 0x52, 0x03), bytes(0x1b, 0x1d, 0x61, 0x01),
    bytes(0x1b, 0x69, 0x01, 0x01), bytes(0x1b, 0x45), text(name.slice(0, 24)), bytes(0x1b, 0x46), bytes(0x1b, 0x69, 0x00, 0x00),
    ...address.map(text), ...(phone ? [text(phone)] : []), text(''),
    bytes(0x1b, 0x1d, 0x61, 0x00), text('-'.repeat(COLS)),
    text(row('Receipt', sale.receipt_number || '')), text(when(sale)),
    text(row('Staff', staff)), text(row('Customer', sale.customer_name || 'Walk-in')), text('-'.repeat(COLS)),
  ];
  if (sale.items?.length) {
    for (const item of sale.items) {
      parts.push(text(item.name), text(row(`  ${item.quantity} x ${money(item.price)}`, money(item.price * item.quantity))));
    }
  } else parts.push(text('Appointment deposit'));
  const gross = sale.gross_total ?? sale.total;
  parts.push(
    text('-'.repeat(COLS)), text(row('Subtotal', money(gross))),
    ...(sale.discount ? [text(row('Discount', money(sale.discount)))] : []),
    text(row('Total', money(gross - (sale.discount || 0)))),
    ...(sale.deposit_applied ? [text(row('Deposit already paid', money(sale.deposit_applied)))] : []),
    text(row('Paid now', money(sale.total))), text(row('Payment', String(sale.method || '').toUpperCase())),
    ...(sale.cash ? [text(row('Cash received', money(sale.tendered))), text(row('Change', money(sale.change)))] : []),
    text('-'.repeat(COLS)), bytes(0x1b, 0x1d, 0x61, 0x01), text('Thank you for visiting'), text(name), text(''),
    bytes(0x1b, 0x64, 0x01),
  );
  return Buffer.concat(parts);
}

export function testSlipBytes() {
  return Buffer.concat([
    bytes(0x1b, 0x40, 0x18), bytes(0x1b, 0x52, 0x03), bytes(0x1b, 0x1d, 0x61, 0x01), bytes(0x1b, 0x45),
    text('Beauty For All'), bytes(0x1b, 0x46), text('Printer test'), text(printerModel.name),
    text('The receipt printer is connected.'), text('The cash drawer was not opened.'), text(''),
    bytes(0x1b, 0x64, 0x01),
  ]);
}

export function sendEthernet(host, port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host, port, family:4});
    let settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error('timeout')), 2500);
    socket.once('error', finish);
    socket.once('connect', () => socket.end(payload, () => finish()));
  });
}

function sendUsb(queue, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('lp', ['-d', queue, '-o', 'raw'], {stdio:['pipe', 'ignore', 'pipe']});
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 8000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || 'The USB printer queue rejected the receipt.')); });
    child.stdin.end(payload);
  });
}

async function deliver(config, payload) {
  try {
    if (config.connection === 'usb') await sendUsb(config.usbQueue, payload);
    else await sendEthernet(config.host, config.port || 9100, payload);
  } catch { throw offline(); }
}

export async function printerQueues() {
  try {
    const {stdout} = await execFileAsync('lpstat', ['-p'], {timeout:2000});
    return [...stdout.matchAll(/^printer (\S+)/gm)].map(match => match[1]);
  } catch { return []; }
}

export function createHardware(dataDir, {transport} = {}) {
  const file = join(dataDir, 'hardware.json');
  const send = transport || deliver;
  const defaults = {enabled:false, connection:'ethernet', host:'', port:9100, usbQueue:''};
  async function read() {
    try { return {...defaults, ...hardwareConfig(JSON.parse(await readFile(file, 'utf8')))}; }
    catch (error) { if (error.code !== 'ENOENT') return defaults; return defaults; }
  }
  async function save(config) {
    const next = hardwareConfig(config);
    await mkdir(dataDir, {recursive:true, mode:0o700});
    await writeFile(file, JSON.stringify(next), {mode:0o600});
    await chmod(file, 0o600);
    return next;
  }
  async function enabled() { return (await read()).enabled; }
  async function transmit(config, payload) {
    const ready = hardwareConfig(config);
    if (!ready.enabled) fail('Tick “Use this printer”, enter its address, and save hardware before testing.');
    await send(ready, payload);
  }
  async function open() {
    const config = await read();
    if (!config.enabled) return 'not_connected';
    await send(config, DRAWER_KICK);
  }
  async function print(sale) {
    const config = await read();
    if (!config.enabled) fail('Connect the receipt printer in Settings before printing.', 409);
    await send(config, receiptBytes(sale, sale));
  }
  function status(role) {
    return read().then(config => {
      const summary = {enabled:config.enabled, connection:config.connection, printer:printerModel.name, printerDetail:printerModel.detail, drawer:drawerModel.name, drawerDetail:drawerModel.detail};
      if (role === 'admin') { summary.host = config.host; summary.port = config.port; summary.usbQueue = config.usbQueue; }
      return summary;
    });
  }
  return {read, save, enabled, open, print, probe:config => transmit(config, bytes(0x1b, 0x40, 0x18)), printTest:config => transmit(config, testSlipBytes()), status};
}
