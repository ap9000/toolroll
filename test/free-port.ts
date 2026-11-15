import { createServer, type Server } from "node:net";

/**
 * Ports a test listens on, chosen by the system at run time: each is bound on 127.0.0.1 with port 0, its assigned
 * number read back, and released just before it is handed out. Two test files running side by side can then never be
 * given the same number (a fixed or pid-derived port could, and a CI run failed with EADDRINUSE that way). 4180, a real
 * console's port, is never handed out, and no number is handed out twice in one test process. Where the computer has
 * an IPv6 loopback the same number must also be free on ::1, since a console may listen there too.
 */
const handedOut = new Set<number>();
const REFUSED = new Set([4180]);

const listen = (server: Server, port: number, host: string): Promise<number | NodeJS.ErrnoException> =>
  new Promise(resolve => {
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error));
    server.listen({ port, host, exclusive: true }, () => resolve((server.address() as { port: number }).port));
  });
const close = (server: Server): Promise<void> => new Promise(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); });

/** A tuple of `N` numbers, so `const [a, b] = await freePorts(2)` types both as numbers. */
type Ports<N extends number, R extends number[] = []> = R["length"] extends N ? R : Ports<N, [...R, number]>;

/** `count` distinct free ports, held together while they are chosen so none repeats. */
export async function freePorts<N extends number>(count: N): Promise<Ports<N>> {
  const held: Server[] = [];
  const ports: number[] = [];
  try {
    for (let tries = 0; ports.length < count; tries++) {
      if (tries > count + 200) throw new Error(`no ${count} free loopback ports could be found`);
      const v4 = createServer();
      held.push(v4);
      const port = await listen(v4, 0, "127.0.0.1");
      if (typeof port !== "number") throw port;
      if (REFUSED.has(port) || handedOut.has(port)) continue;
      const v6 = createServer();
      held.push(v6);
      const also = await listen(v6, port, "::1");
      // No IPv6 loopback here (some containers): only the IPv4 one matters. Taken on ::1: choose another.
      if (typeof also !== "number" && also.code !== "EADDRNOTAVAIL" && also.code !== "EAFNOSUPPORT") continue;
      ports.push(port);
    }
  } finally {
    await Promise.all(held.map(close));
  }
  for (const port of ports) handedOut.add(port);
  return ports as Ports<N>;
}

/** One free port (see freePorts). */
export async function freePort(): Promise<number> {
  return (await freePorts(1))[0]!;
}
