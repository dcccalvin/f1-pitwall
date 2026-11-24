// Keep the laptop from going to sleep while a session is on (so a race at 4 am isn't
// missed halfway because Windows decided nobody was using the computer).
//
// Windows: a hidden PowerShell child asks the system to stay awake
// (SetThreadExecutionState ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and holds that until it
// is stopped or Pit Wall itself has gone. macOS: `caffeinate`. The screen may still turn
// off; only sleep is held back.
import { spawn } from 'node:child_process';

const PS = `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$k = Add-Type -MemberDefinition $sig -Name Power -Namespace PitWall -PassThru
while ($true) {
  [void]$k::SetThreadExecutionState([uint32]2147483649)
  if (-not (Get-Process -Id ${'$'}{PARENT} -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Seconds 30
}`;

export class KeepAwake {
  constructor({ log = console } = {}) {
    this.log = log;
    this.child = null;
  }

  get on() { return !!this.child; }

  set(want, why = '') {
    if (want && !this.child) this.#start(why);
    else if (!want && this.child) this.#stop();
  }

  #start(why) {
    try {
      if (process.platform === 'win32') {
        const script = PS.replace('${PARENT}', String(process.pid));
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
      } else if (process.platform === 'darwin') {
        this.child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      } else return; // Linux: leave it to the desktop's own settings
      this.child.on('exit', () => { this.child = null; });
      this.child.on('error', () => { this.child = null; });
      this.log.log?.(`[power] keeping the computer awake${why ? ` (${why})` : ''}`);
    } catch (e) {
      this.log.warn?.(`[power] could not keep the computer awake: ${e.message}`);
      this.child = null;
    }
  }

  #stop() {
    try { this.child.kill(); } catch { /* already gone */ }
    this.child = null;
    this.log.log?.('[power] computer may sleep again');
  }
}
