import { connect } from 'node:net';
import type { Readable } from 'node:stream';

export type ScanResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string };

/**
 * Minimal clamd INSTREAM client (https://docs.clamav.net/manual/Usage/Scanning.html#clamd).
 * Streams the object from storage through the worker to clamd in 64 KiB chunks;
 * never buffers the whole file. clamd's StreamMaxLength (default 25 MB, we set 4 GB
 * in infra/clamav/clamd.conf) bounds what is scanned.
 */
export function clamScan(host: string, port: number, source: Readable, timeoutMs = 10 * 60_000): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let reply = '';
    const fail = (e: Error) => {
      sock.destroy();
      source.destroy();
      reject(e);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error('clamd timeout')));
    sock.on('error', fail);
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => {
      const r = reply.replace(/\0/g, '').trim(); // "stream: OK" | "stream: Eicar-Signature FOUND" | "INSTREAM size limit exceeded. ERROR"
      if (r.endsWith('OK')) resolve({ status: 'CLEAN' });
      else if (r.endsWith('FOUND')) resolve({ status: 'INFECTED', signature: r.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
      else reject(new Error(`clamd: ${r}`));
    });
    sock.on('connect', async () => {
      try {
        sock.write('zINSTREAM\0');
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          for (let i = 0; i < buf.length; i += 65536) {
            const part = buf.subarray(i, i + 65536);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(part.length);
            if (!sock.write(Buffer.concat([len, part]))) await new Promise((r) => sock.once('drain', r));
          }
        }
        sock.end(Buffer.alloc(4)); // zero-length chunk terminates the stream
      } catch (e) {
        fail(e as Error);
      }
    });
  });
}
