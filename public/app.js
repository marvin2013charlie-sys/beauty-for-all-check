const forms = [...document.querySelectorAll('[data-login]')];
let signingIn = false;

const roleButtons = [...document.querySelectorAll('[data-select-role]')];
roleButtons.forEach(button => button.addEventListener('click', () => {
  if (signingIn || button.getAttribute('aria-pressed') === 'true') return;
  roleButtons.forEach(option => option.setAttribute('aria-pressed', String(option === button)));
  forms.forEach(form => {
    form.closest('[data-role]').hidden = form.dataset.login !== button.dataset.selectRole;
    form.reset();
    form.querySelectorAll('.pin-input').forEach(input => {
      input.classList.remove('filled', 'revealed');
      input.removeAttribute('aria-invalid');
    });
    const reveal = form.querySelector('[data-reveal]');
    reveal.setAttribute('aria-pressed', 'false');
    reveal.setAttribute('aria-label', `Show ${form.dataset.login} PIN`);
    reveal.querySelector('span').textContent = 'Show';
    document.getElementById(`${form.dataset.login}-message`).textContent = '';
  });
}));

for (const form of forms) {
  const role = form.dataset.login;
  const inputs = [...form.querySelectorAll('.pin-input')];
  const message = document.getElementById(`${role}-message`);
  const reveal = form.querySelector('[data-reveal]');
  const update = () => {
    message.textContent = '';
    message.classList.remove('ok','pending');
    inputs.forEach(input => {
      input.classList.toggle('filled', Boolean(input.value));
      input.removeAttribute('aria-invalid');
    });
  };
  const distribute = (value, start = 0) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    if (!digits) return;
    if (digits.length === 4) start = 0;
    for (let i = start; i < Math.min(start + digits.length, 4); i++) inputs[i].value = digits[i - start];
    update();
    inputs[Math.min(start + digits.length, 3)].focus();
    if (!signingIn && inputs.every(box => /^\d$/.test(box.value))) form.requestSubmit();
  };
  inputs.forEach((input, index) => {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', event => {
      const digits = input.value.replace(/\D/g, '');
      input.value = '';
      if (digits) distribute(digits, index);
      else update();
    });
    input.addEventListener('paste', event => {
      event.preventDefault();
      distribute(event.clipboardData.getData('text'), index);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Backspace' && !input.value && index > 0) {
        event.preventDefault();
        inputs[index - 1].value = '';
        inputs[index - 1].focus();
        update();
      }
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); inputs[index - 1].focus(); }
      if (event.key === 'ArrowRight' && index < 3) { event.preventDefault(); inputs[index + 1].focus(); }
    });
  });
  reveal.addEventListener('click', () => {
    const show = reveal.getAttribute('aria-pressed') !== 'true';
    inputs.forEach(input => input.classList.toggle('revealed', show));
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${role} PIN`);
    reveal.querySelector('span').textContent = show ? 'Hide' : 'Show';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (signingIn) return;
    const pin = inputs.map(input => input.value).join('');
    if (!/^\d{4}$/.test(pin)) {
      message.textContent = 'Enter all 4 digits to continue.';
      inputs.forEach(input => input.setAttribute('aria-invalid', String(!input.value)));
      inputs.find(input => !input.value)?.focus();
      return;
    }
    signingIn = true;
    const submit = form.querySelector('[type=submit]');
    const buttonLabel = submit.querySelector('span');
    const originalLabel = buttonLabel.textContent;
    forms.forEach(other => other.querySelector('[type=submit]').disabled = true);
    form.setAttribute('aria-busy', 'true');
    buttonLabel.textContent = 'Signing you in…';
    message.textContent = '';
    try {
      const response = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role, pin}), signal:AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok) {
        message.textContent = result.error || 'Unable to sign in. Please try again.';
        inputs.forEach(input => { input.value = ''; input.classList.remove('filled'); input.setAttribute('aria-invalid','true'); });
        inputs[0].focus();
        return;
      }
      inputs.forEach(input => input.value = '');
      window.location.assign(result.redirect);
    } catch {
      message.textContent = 'Couldn’t connect. Please try again.';
    } finally {
      signingIn = false;
      buttonLabel.textContent = originalLabel;
      forms.forEach(other => other.querySelector('[type=submit]').disabled = false);
      form.removeAttribute('aria-busy');
    }
  });
}

const resetNote = sessionStorage.getItem('bfa-pin-reset');
if (resetNote) {
  sessionStorage.removeItem('bfa-pin-reset');
  const note = document.getElementById('admin-message');
  note.textContent = resetNote;
  note.classList.add('ok');
}
document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try { const response = await fetch('/api/logout', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); if (!response.ok) throw new Error(); location.replace('/'); }
  catch { button.disabled = false; document.getElementById('logout-message').textContent = 'Couldn’t sign out. Please try again.'; }
}));
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
