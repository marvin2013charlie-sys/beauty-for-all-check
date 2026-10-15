const rawToken = new URLSearchParams(location.search).get('token') || '';
if (location.search) history.replaceState({}, '', location.pathname);
const token = /^[0-9a-f]{64}$/.test(rawToken) ? rawToken : '';
const identity = document.getElementById('identity-form');
const reset = document.getElementById('reset-form');
const intro = document.getElementById('recover-intro');

function show(form, text, tone) {
  const message = form.querySelector('.form-message');
  message.classList.remove('ok', 'pending');
  if (tone) message.classList.add(tone);
  message.textContent = text;
}

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

if (token) {
  identity.hidden = true;
  reset.hidden = false;
  intro.textContent = 'Choose a new four-digit admin PIN. This link works once and only on this computer.';
  reset.addEventListener('submit', async event => {
    event.preventDefault();
    const button = reset.querySelector('button');
    const data = Object.fromEntries(new FormData(reset));
    button.disabled = true;
    try {
      const { response, data: result } = await post('/api/recover/reset', { token, pin: data.pin, confirm: data.confirm });
      if (!response.ok) {
        show(reset, result.error || 'The new PIN could not be saved.', '');
        return;
      }
      sessionStorage.setItem('bfa-pin-reset', 'Your new admin PIN is saved. Sign in with it.');
      location.replace('/');
    } catch {
      show(reset, 'Couldn’t connect. Please try again.', '');
    } finally {
      button.disabled = false;
    }
  });
}

identity.addEventListener('submit', async event => {
  event.preventDefault();
  if (identity.hidden) return;
  const button = identity.querySelector('button');
  const data = Object.fromEntries(new FormData(identity));
  button.disabled = true;
  try {
    const { response, data: result } = await post('/api/recover', data);
    const text = result.message || result.error || 'The recovery request could not be completed.';
    const tone = result.status === 'sent' ? 'ok' : result.status === 'no_mail' || result.status === 'send_failed' ? 'pending' : '';
    show(identity, response.ok ? text : (result.error || text), response.ok ? tone : '');
  } catch {
    show(identity, 'Couldn’t connect. Please try again.', '');
  } finally {
    button.disabled = false;
  }
});
