const STORAGE_KEY = 'oneroute-server-url';
const DEPLOYED_URL = 'https://oneroute.dpdns.org';

const form = document.querySelector('#connect-form');
const input = document.querySelector('#server-url');
const remember = document.querySelector('#remember-url');
const button = document.querySelector('#connect-button');
const status = document.querySelector('#status');

const savedUrl = localStorage.getItem(STORAGE_KEY);
input.value = savedUrl || DEPLOYED_URL;

function normalizeUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the server address.');

  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Use an http:// or https:// server address.');
  }

  return parsed.toString().replace(/\/$/, '');
}

function showStatus(message, kind = '') {
  status.textContent = message;
  status.className = `status ${kind}`.trim();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  showStatus('Checking the ONEROUTE server…');

  try {
    const serverUrl = normalizeUrl(input.value);
    const response = await fetch(`${serverUrl}/health`, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`The server returned HTTP ${response.status}.`);
    }

    const health = await response.json();
    if (!health.ok) throw new Error('The server health check did not pass.');

    if (remember.checked) {
      localStorage.setItem(STORAGE_KEY, serverUrl);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }

    showStatus('Connected. Opening your ONEROUTE website…', 'success');
    // The deployed host currently serves the app reliably at /index.html;
    // local Express hosting also supports this path.
    window.location.assign(`${serverUrl}/index.html`);
  } catch (error) {
    const message = error instanceof TypeError
      ? 'Could not reach the server. Check the address, network, and firewall.'
      : error.message;
    showStatus(message, 'error');
    button.disabled = false;
  }
});
