import { bearerOf, centralProfile, type TeamCliOptions } from './team-cli.js';
import { envelopeJson } from './envelope.js';
import { healthSnapshotSchema } from './contracts/health.js';

/** Read the running server, never a fresh CLI process's empty counters or the local database. */
export async function runHealthCommand(argv: readonly string[], write: (line: string) => void, options: TeamCliOptions = {}): Promise<number> {
  const json = argv.includes('--json');
  const fail = (message: string, reason = 'unavailable', code = 1) => {
    write(json ? envelopeJson({ command: 'health', ok: false, reason, message }) : message); return code;
  };
  if (argv.includes('--help')) {
    write('toolroll health [--profile <name>] [--json]\nRecent latency, event-loop delay, write waits and live streams from the connected server. An instance operator must sign in with toolroll connect first.');
    return 0;
  }
  let profileName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') continue;
    if (argv[i] === '--profile' && profileName === undefined && argv[i + 1] && !argv[i + 1]!.startsWith('-')) { profileName = argv[++i]; continue; }
    return fail('Use toolroll health [--profile <name>] [--json].', 'usage', 2);
  }
  try {
    const profile = centralProfile(options, profileName);
    if (!profile) return fail('Connect to the server first with toolroll connect, then run toolroll health.', 'not-connected', 2);
    const timeout = AbortSignal.timeout(30_000);
    const response = await (options.fetch ?? fetch)(`${profile.origin}/health`, {
      redirect: 'manual', credentials: 'omit', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: { authorization: bearerOf(profile), accept: json ? 'application/json' : 'text/plain' },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return fail(response.status === 401 || response.status === 403 || response.status === 302
        ? 'Sign in as an instance operator to read server health.'
        : response.status === 404 ? 'This server does not provide performance health yet. Update the server.' : 'Server health is unavailable. Try again shortly.');
    }
    // A health response is bounded by the fixed route vocabulary. Refuse unrelated HTML and oversized replies.
    const reader = response.body?.getReader();
    if (!reader) return fail('The server returned no health measurements.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 128 * 1024) { await reader.cancel(); return fail('The server returned an unexpected health response.'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (json) {
      const parsed = healthSnapshotSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return fail('The server returned an unexpected health response.');
      write(envelopeJson({ command: 'health', ok: true, health: parsed.data }));
    } else {
      if (!response.headers.get('content-type')?.startsWith('text/plain') || !text.startsWith('Server health')) return fail('The server returned an unexpected health response.');
      write(text.trimEnd());
    }
    return 0;
  } catch { return fail('Could not read server health. Check the saved connection and server availability.'); }
}
