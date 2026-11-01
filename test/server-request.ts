import { IncomingMessage, ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

/** Exercise the real HTTP request handler without opening a port. Transport and browser behavior need separate checks. */
export function serverRequest(server: Server, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const request = new IncomingMessage(socket as Socket);
    request.method = 'GET'; request.url = path; request.headers = { host: '127.0.0.1:4180', ...headers };
    const response = new ServerResponse(request);
    response.assignSocket(socket as Socket);
    response.on('error', reject);
    response.on('finish', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.getHeaders())) {
        if (value !== undefined) for (const one of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(one));
      }
      socket.destroy();
      resolve({ status: response.statusCode, headers: responseHeaders, body });
    });
    server.emit('request', request, response);
    request.push(null);
  });
}
