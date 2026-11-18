/** Synthetic interactive Claude. No SDK, shell, subprocess, credentials or model fallback.
 * stdin: keys; stdout: hostile-capable screen; fd3: JSONL controls; fd4: JSONL sync signals.
 * Controls: {id,op:'resize',cols,rows}, {id,op:'barrier'}, {id,op:'exit',code}.
 * A barrier acknowledges prior commands on its control stream, not unread stdin. Wait for key/command signals.
 * Screen and sync writes await callbacks (including backpressure); signals describe completed writes.
 */
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, createReadStream, createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const attacks = JSON.parse(readFileSync(new URL('./terminal-attacks.json', import.meta.url), 'utf8'));
const E = '\x1b';
const write = (stream, data) => new Promise((resolve, reject) => stream.write(data, error => error ? reject(error) : resolve()));

/** Owns the supplied readers until controlled exit/EOF. Errors reject; no installed program is ever consulted. */
export async function runInteractiveClaude({ input, output, controls, signals, cols = 80, rows = 24 }) {
  let line = '', pending = '', permission = false, ended = false, code = 0, seq = 0;
  let tail = Promise.resolve();
  const decoder = new StringDecoder('utf8');
  const signal = (event, facts = {}) => write(signals, JSON.stringify({ seq: ++seq, event, ...facts }) + '\n');
  const screen = text => write(output, text);
  const draw = () => screen(`${E}[H${E}[2JSynthetic Claude · ${cols}×${rows}\r\n日本語 😀\r\n/status /permission /long /attacks /exit\r\n> ${line}`);
  const exit = async value => {
    if (ended) return;
    ended = true; code = value;
    await screen(`${E}[?2004l${E}[?25h${E}[?1049l`);
    await signal('exit', { code });
    input.destroy(); controls.destroy();
  };
  const command = async text => {
    const [name, arg] = text.split(' ');
    if (name === '/exit') { await exit(exitCode(arg)); return; }
    if (name === '/permission') {
      permission = true;
      await screen('\r\nSynthetic permission: allow fake file read? [y/n]');
      await signal('permission');
    } else if (name === '/long') {
      const count = arg === undefined ? 200 : Number(arg);
      if (!Number.isInteger(count) || count < 1 || count > 2000) throw new Error('Invalid long output count');
      for (let i = 0; i < count; i++) await screen(`\r\nSynthetic line ${i + 1}: 日本語 😀`);
      await signal('long', { count });
    } else if (name === '/attacks') {
      for (const attack of attacks) {
        for (const hex of attack.chunks) await screen(Buffer.from(hex, 'hex'));
        await signal('attack', { name: attack.name });
      }
    } else await screen(`\r\n${name === '/status' ? 'Synthetic session ready' : `Synthetic reply: ${text}`}\r\n> `);
    await signal('command', { text });
  };
  const keys = async text => {
    pending += text;
    while (pending && !ended) {
      let key;
      if (pending.startsWith(E)) {
        if (pending.length === 1 || pending === `${E}[` || pending === `${E}O`) return;
        const match = pending.match(/^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/);
        key = match?.[0] ?? E;
      } else key = String.fromCodePoint(pending.codePointAt(0));
      pending = pending.slice(key.length);
      if (key === '\x03') { await exit(130); return; }
      if (permission) {
        if (key === 'y' || key === 'n') {
          permission = false;
          await screen(`\r\nFake read ${key === 'y' ? 'allowed' : 'denied'}\r\n> `);
          await signal('permission-answer', { allowed: key === 'y' });
        }
      } else if (key === '\r' || key === '\n') {
        const text = line; line = ''; await command(text);
      } else if (key === '\x7f' || key === '\b') {
        line = [...line].slice(0, -1).join(''); await draw();
      } else if (!key.startsWith(E)) {
        if (line.length >= 4096) throw new Error('Input line too long');
        line += key; await screen(key);
      }
      await signal('key', { key });
    }
  };
  const enqueue = fn => { const next = tail.then(fn); tail = next; return next; };
  async function readKeys() {
    for await (const chunk of input) {
      if (ended) break;
      await enqueue(() => keys(decoder.write(Buffer.from(chunk))));
    }
    if (!ended) await enqueue(async () => { await keys(decoder.end()); await exit(0); });
  }
  async function readControls() {
    let buffer = '';
    const utf8 = new StringDecoder('utf8');
    for await (const chunk of controls) {
      if (ended) break;
      buffer += utf8.write(Buffer.from(chunk));
      if (buffer.length > 8192) throw new Error('Control frame too large');
      while (buffer.includes('\n') && !ended) {
        const at = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        await enqueue(async () => {
          if (ended) return;
          if (frame.op === 'resize') {
            if (![frame.cols, frame.rows].every(n => Number.isInteger(n) && n >= 2 && n <= 500)) throw new Error('Invalid dimensions');
            cols = frame.cols; rows = frame.rows; await draw();
          } else if (frame.op === 'exit') await exit(exitCode(frame.code));
          else if (frame.op !== 'barrier') throw new Error('Unknown fixture control');
          await signal('control', { id: frame.id, op: frame.op, cols, rows });
        });
      }
    }
    if (!ended) throw new Error('Fixture control stream closed');
  }
  try {
    await screen(`${E}[?1049h${E}[?2004h${E}[?25l`);
    await draw(); await signal('ready', { cols, rows });
    await Promise.all([readKeys(), readControls()].map(p => p.catch(error => {
      if (ended && error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      input.destroy(); controls.destroy(); throw error;
    })));
    await tail;
    return code;
  } finally { input.destroy(); controls.destroy(); }
}
function exitCode(value = 0) {
  const code = Number(value);
  if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error('Invalid exit code');
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--fixture-interactive') throw new Error('Explicit --fixture-interactive required');
  const controls = new PassThrough();
  const controlReader = createReadStream(null, { fd: 3, autoClose: true });
  controlReader.pipe(controls);
  const signals = createWriteStream(null, { fd: 4, autoClose: false });
  const resize = () => controls.write(JSON.stringify({ op: 'resize', id: 'SIGWINCH', cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }) + '\n');
  process.stdout.on('resize', resize);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  try {
    process.exitCode = await runInteractiveClaude({ input: process.stdin, output: process.stdout, controls, signals,
      cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
  } finally {
    process.stdout.off('resize', resize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    // The fixture owns its fd3 reader; destroy it too so controlled exit cannot leave the process alive.
    controlReader.destroy();
    signals.end();
  }
}
