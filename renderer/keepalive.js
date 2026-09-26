const fill = document.getElementById('ka-fill');
const status = document.getElementById('ka-status');
const title = document.getElementById('ka-title');

window.ram.onKeepAlive(p => {
  if (p.done) {
    fill.style.width = '100%';
    if (p.dead) {
      fill.classList.add('warn');
      title.textContent = 'Cookies refreshed';
      status.textContent = `${p.dead} of ${p.total} accounts expired. Open the app and use "Log in again" on them.`;
    } else {
      fill.classList.add('done');
      title.textContent = 'All cookies are alive';
      status.textContent = `Checked ${p.total} accounts. Closing…`;
    }
    return;
  }
  fill.style.width = `${Math.round((p.i / p.total) * 100)}%`;
  status.textContent = `Checking ${p.name} (${p.i + 1} of ${p.total})`;
});
