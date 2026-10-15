const fallbackAddress = '277 Blagreaves Lane, DE23 1PT';

function shiftDay(day, days) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}).formatToParts(date);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:00Z`;
}

export function londonIso(day, time) {
  let utc = Date.parse(`${day}T${time}:00Z`);
  const wanted = Date.parse(`${day}T${time}:00Z`);
  for (let attempt = 0; attempt < 4; attempt += 1) utc += wanted - Date.parse(clock(new Date(utc), 'Europe/London'));
  return new Date(utc).toISOString();
}

function longDate(day) {
  return new Intl.DateTimeFormat('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'UTC'}).format(new Date(`${day}T12:00:00Z`));
}

export function messageBody(kind, appointment, business = {}) {
  const salon = business.name || 'Beauty For All';
  const phone = String(business.phone || '').trim();
  const address = String(business.address || '').trim() || fallbackAddress;
  const contact = [address, phone].filter(Boolean).join(' · ');
  const treatment = (appointment.services || []).map(service => service.name).filter(Boolean).join(', ') || 'Appointment';
  const opening = kind === 'reminder' ? `Reminder from Beauty For All. Your appointment is tomorrow.` : `Beauty For All. Your appointment is confirmed.`;
  return [
    opening,
    `Customer: ${appointment.customer_name}`,
    `Date: ${longDate(appointment.date)}`,
    `Time: ${appointment.time}`,
    `Treatment: ${treatment}`,
    `Staff: ${appointment.staff_name}`,
    `Contact: ${salon}${contact ? ` · ${contact}` : ''}`,
    `To cancel or reschedule, contact ${salon}${phone ? ` on ${phone}` : ''} before your appointment.`,
  ].join('\n');
}

export function planMessages(appointment, business, now) {
  const phone = String(appointment.mobile || '').trim();
  const messages = [{kind:'confirmation', phone, scheduled_for:new Date(now).toISOString(), body:messageBody('confirmation', appointment, business)}];
  const reminderAt = londonIso(shiftDay(appointment.date, -1), '10:00');
  if (Date.parse(reminderAt) > now) messages.push({kind:'reminder', phone, scheduled_for:reminderAt, body:messageBody('reminder', appointment, business)});
  return messages;
}
