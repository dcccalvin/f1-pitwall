// Settings: phone link (QR), data source, F1 TV connection.
import { esc } from '../format.js';

export class Settings {
  constructor(store) {
    this.store = store;
    this.dlg = document.getElementById('settings');
    this.body = document.getElementById('settings-body');
    document.getElementById('settings-btn').addEventListener('click', () => this.open());
    document.addEventListener('click', (e) => { if (e.target.closest('[data-open-f1tv]')) this.open('f1tv'); });
    this.dlg.addEventListener('click', (e) => { if (e.target === this.dlg) this.dlg.close(); });
    this.body.addEventListener('click', (e) => this.#onClick(e));
  }

  async open(focus) {
    this.body.innerHTML = '<p class="muted" style="padding:20px 0">Loading…</p>';
    if (!this.dlg.open) this.dlg.showModal();
    const [info, recs] = await Promise.all([
      fetch('/api/info').then((r) => r.json()).catch(() => ({})),
      fetch('/api/recordings').then((r) => r.json()).catch(() => ({ files: [] })),
    ]);
    this.info = info;
    this.#render(info, recs.files || []);
    if (focus) this.body.querySelector(`[data-sec="${focus}"]`)?.scrollIntoView({ block: 'start' });
  }

  #render(info, files) {
    const st = info.status || {};
    const local = info.canEditSettings;
    const exp = st.tokenExpires ? new Date(st.tokenExpires) : null;
    const expTxt = exp ? (exp < Date.now() ? 'expired — paste a fresh one' : `valid until ${exp.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`) : '';
    const mode = info.mode;
    const demoF1 = mode === 'demo' && st.f1tv;

    this.body.innerHTML = `
      <section class="set-sec" data-sec="phone">
        <h3>Open on your phone</h3>
        ${info.phoneUrl ? `<div class="phone"><img src="${info.phoneQr}" alt="QR code">
          <div><p>Scan with your phone camera, or type this address. Your phone must be on the same Wi-Fi as this laptop.</p><code>${esc(info.phoneUrl)}</code>
          <p class="muted" style="margin-top:10px">Tip: add it to your home screen for a full-screen app. Each screen keeps its own delay.</p></div></div>`
          : '<p>No network connection found. Connect this laptop to Wi-Fi.</p>'}
      </section>

      <section class="set-sec" data-sec="source">
        <h3>Data source</h3>
        <p>Live uses F1's timing feed while a session is running. Demo plays a simulated race so you can try everything any time.</p>
        <div class="seg">
          <button data-mode="live" class="${mode === 'live' ? 'on' : ''}" ${local ? '' : 'disabled'}>Live</button>
          <button data-mode="demo" class="${mode === 'demo' && !demoF1 ? 'on' : ''}" ${local ? '' : 'disabled'}>Demo race</button>
          <button data-mode="demo-f1tv" class="${demoF1 ? 'on' : ''}" ${local ? '' : 'disabled'}>Demo + F1 TV preview</button>
          <button data-mode="replay" class="${mode === 'replay' ? 'on' : ''}" ${local && files.length ? '' : 'disabled'}>Replay</button>
        </div>
        ${files.length ? `<div class="row-actions"><select id="rec-file" ${local ? '' : 'disabled'}>${files.map((f) => `<option value="${esc(f.name)}">${esc(f.name.replace(/\.jsonl$/, '').replace(/_/g, ' '))} · ${(f.size / 1048576).toFixed(1)} MB</option>`).join('')}</select>
          <select id="rec-speed" ${local ? '' : 'disabled'}><option value="1">1× speed</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option></select></div>
          <p class="muted" style="margin-top:8px">Every live session you watch is saved for replay (F1 now locks its own archive behind a login).</p>`
          : '<p class="muted">No recordings yet. Sessions are saved automatically while Live is on.</p>'}
        ${local ? '' : '<p class="muted">Change the data source on the laptop running Pit Wall.</p>'}
      </section>

      <section class="set-sec" data-sec="f1tv">
        <h3>F1 TV ${st.f1tv && mode === 'live' ? '<span class="tag ok">Connected</span>' : '<span class="tag">Not connected</span>'}</h3>
        <p>Free data covers timing, gaps, sectors, tyres, flags, race control, weather and team radio. An F1 TV subscription (Access is enough) adds live car telemetry, real GPS on the track map and pit stop times.</p>
        ${st.f1tv && mode === 'live' && expTxt ? `<p>Token ${esc(expTxt)}.</p>` : ''}
        ${local ? `
          <textarea id="tok" placeholder="Paste your F1 TV token or the whole login-session cookie value here" spellcheck="false"></textarea>
          <div class="row-actions">
            <button type="button" class="btn primary" data-act="save-token">Save &amp; connect</button>
            ${st.f1tv && mode === 'live' ? '<button type="button" class="btn danger" data-act="clear-token">Disconnect</button>' : ''}
            <span class="muted" id="tok-msg"></span>
          </div>
          <details><summary>How to get your token</summary><ol>
            <li>Subscribe to F1 TV (the Access plan is enough).</li>
            <li>On this laptop, sign in at <b>formula1.com</b> in Chrome or Edge.</li>
            <li>Press F12 → <b>Application</b> → <b>Cookies</b> → <b>https://www.formula1.com</b>.</li>
            <li>Find the cookie named <b>login-session</b>, double-click its value and copy it.</li>
            <li>Paste it above and press Save. It lasts about 4 days, so repeat once per race weekend.</li>
          </ol><p class="muted" style="margin-top:8px">The token is stored only in <code>config.json</code> on this laptop and is only sent to F1.</p></details>`
          : '<p class="muted">Connect F1 TV on the laptop running Pit Wall.</p>'}
      </section>

      <section class="set-sec">
        <h3>About <span class="tag">v${esc(info.version || '?')}</span></h3>
        ${info.folder && local ? `<p class="muted">Running from <b>${esc(info.folder)}</b></p>` : ''}
        <p class="muted">Unofficial personal dashboard built on F1's public live timing feed. Not associated with Formula 1. Circuit outlines from MultiViewer. For personal use only.</p>
      </section>`;
  }

  async #onClick(e) {
    const m = e.target.closest('[data-mode]');
    if (m && !m.disabled) {
      const body = { mode: m.dataset.mode === 'demo-f1tv' ? 'demo' : m.dataset.mode, f1tv: m.dataset.mode === 'demo-f1tv' };
      if (body.mode === 'replay') { body.file = this.body.querySelector('#rec-file')?.value; body.speed = Number(this.body.querySelector('#rec-speed')?.value || 1); }
      const r = await fetch('/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ error: 'Server not reachable' }));
      if (r.error) this.store.toast(r.error);
      else { this.dlg.close(); this.store.toast(`Switched to ${m.textContent}`); }
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const msg = this.body.querySelector('#tok-msg');
    const token = a.dataset.act === 'save-token' ? this.body.querySelector('#tok').value.trim() : '';
    if (a.dataset.act === 'save-token' && !token) { msg.textContent = 'Paste a token first.'; return; }
    msg.textContent = 'Saving…';
    const r = await fetch('/api/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }).then((x) => x.json()).catch(() => ({ error: 'Server not reachable' }));
    if (r.error) { msg.textContent = r.error; return; }
    this.store.toast(token ? 'F1 TV token saved. Reconnecting with F1 TV data…' : 'F1 TV disconnected. Using free data.');
    this.open('f1tv');
  }
}
