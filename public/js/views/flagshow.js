// A waving flag that drops in when the track status changes, then slides away.
// The cloth is cut into thin strips that ripple out from the pole, like real fabric.

const SLICES = 22;
const FLAGS = {
  green: { cloth: 'green', title: 'Green flag', sub: 'Track clear · racing resumes' },
  yellow: { cloth: 'yellow', title: 'Yellow flag', sub: 'Danger ahead · slow down, no overtaking there' },
  sc: { cloth: 'yellow', board: 'SC', title: 'Safety car', sub: 'The field bunches up behind the safety car' },
  vsc: { cloth: 'yellow', board: 'VSC', title: 'Virtual safety car', sub: 'Everyone slows to a set speed' },
  'vsc-ending': { cloth: 'green', board: 'VSC', title: 'VSC ending', sub: 'Racing resumes in a few seconds' },
  red: { cloth: 'red', title: 'Red flag', sub: 'Session stopped · cars return to the pit lane' },
  chequered: { cloth: 'chequered', title: 'Chequered flag', sub: 'End of the session' },
};

export class FlagShow {
  constructor(store) {
    this.store = store;
    this.el = document.getElementById('flagshow');
    this.enabled = localStorage.getItem('flagAnim') !== '0';
    this.lastYellow = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    localStorage.setItem('flagAnim', this.enabled ? '1' : '0');
    if (!this.enabled) this.el.hidden = true;
  }

  show(key, label = '') {
    const f = FLAGS[key];
    if (!this.enabled || !f) return;
    if (key === 'yellow') { // local yellows come and go a lot: don't nag
      if (Date.now() - this.lastYellow < 45000) return;
      this.lastYellow = Date.now();
    }
    const strips = Array.from({ length: SLICES }, (_, i) => `<i style="--i:${i}"></i>`).join('');
    const sub = label && !label.toLowerCase().startsWith(f.title.toLowerCase()) ? label : f.sub;
    this.el.innerHTML = `<div class="fs-card fs-${key}">
      <div class="fs-flag fs-${f.cloth}"><span class="fs-pole"></span><div class="fs-cloth">${strips}</div>${f.board ? `<em class="fs-board">${f.board}</em>` : ''}</div>
      <div class="fs-text"><b>${f.title}</b><span>${sub.replace(/[<>&]/g, '')}</span></div></div>`;
    this.el.hidden = false;
    this.el.classList.remove('out');
    void this.el.offsetWidth;
    this.el.classList.add('in');
    clearTimeout(this.t1); clearTimeout(this.t2);
    this.t1 = setTimeout(() => {
      this.el.classList.add('out');
      this.t2 = setTimeout(() => { this.el.hidden = true; this.el.classList.remove('in', 'out'); }, 450);
    }, key === 'chequered' ? 6500 : key === 'yellow' ? 3000 : 4500);
  }
}
