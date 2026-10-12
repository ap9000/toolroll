/** Synthetic OS observations for real sweep children. The sandbox can deny ps; production protocol,
 * database connections, filesystem operations and signals still run unchanged. No production test flags. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProcessRow } from "../src/run-closeout.js";

export type SweepObservation = ProcessRow & { cwd?: string; exe?: string; argv?: string[] };
export function sweepObservations(root: string) {
  const file = join(root, "sweep-observations.json"), preload = join(root, "sweep-observations.mjs");
  const before = process.env.NODE_OPTIONS;
  writeFileSync(preload, `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync, link = fs.readlinkSync, exec = cp.execFileSync, spawn = cp.spawnSync;
    const data = () => JSON.parse(read(${JSON.stringify(file)}, 'utf8'));
    const rows = () => data().rows.filter(row => { try { process.kill(row.pid, 0); return true; } catch { return false; } });
    const selected = args => { const at = args.indexOf('-p'); return at < 0 ? rows() : rows().filter(row => args[at+1].split(',').map(Number).includes(row.pid)); };
    cp.execFileSync = (file, args = [], options) => {
      if (file === '/bin/ps') {
        if (args.includes('args=')) return selected(args).map(row => (row.argv ?? []).join(' ')).join('\\n');
        return rows().map(row => {
          const age = Math.max(0, Math.round((Date.now() - row.bornAt) / 1000));
          return row.pid+' '+row.ppid+' '+row.pgid+' '+Math.floor(age/60)+':'+String(age%60).padStart(2,'0')+' '+(row.terminal?'ttys000':'??')+' '+row.name;
        }).join('\\n');
      }
      if (file === 'lsof') return selected(args).map(row => 'p'+row.pid+'\\n'+(row.cwd?'fcwd\\nn'+row.cwd+'\\n':'')+(row.exe?'ftxt\\nn'+row.exe+'\\n':'')).join('');
      return exec(file, args, options);
    };
    // Linux process paths use /proc rather than lsof. Only fixture PIDs are supplied by the synthetic census.
    fs.readFileSync = (file, ...rest) => {
      const match = /^\\/proc\\/(\\d+)\\/cmdline$/.exec(String(file));
      if (match) return (rows().find(row => row.pid === Number(match[1]))?.argv ?? []).join('\\0');
      return read(file, ...rest);
    };
    fs.readlinkSync = (file, ...rest) => {
      const match = /^\\/proc\\/(\\d+)\\/(cwd|exe)$/.exec(String(file));
      if (match) { const row = rows().find(row => row.pid === Number(match[1])); if (row?.[match[2]]) return row[match[2]]; throw Error('missing fixture path'); }
      return link(file, ...rest);
    };
    cp.spawnSync = (file, args, options) => {
      const gate = data().duGate;
      if (file === 'du' && gate) {
        fs.writeFileSync(gate.entered, JSON.stringify({ nice: os.getPriority() }));
        const end = Date.now() + 2000;
        while (!fs.existsSync(gate.release) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        fs.writeFileSync(gate.result, JSON.stringify({ released: fs.existsSync(gate.release) }));
        return { status: 0, stdout: args.slice(1).map(path => '1024\\t'+path).join('\\n'), stderr: '', signal: null };
      }
      return spawn(file, args, options);
    };
    if (data().home) os.homedir = () => data().home;
    syncBuiltinESMExports();
  `);
  const write = (rows: SweepObservation[], more: { home?: string; duGate?: { entered: string; release: string; result: string } } = {}) => writeFileSync(file, JSON.stringify({ rows, ...more }));
  write([]);
  process.env.NODE_OPTIONS = `${before ?? ""} --import=${JSON.stringify(pathToFileURL(preload).href)}`.trim();
  return { write, restore: () => { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; } };
}
