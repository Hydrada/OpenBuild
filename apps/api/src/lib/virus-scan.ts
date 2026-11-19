import { connect } from "node:net";

export type ScanResult = { clean: true } | { clean: false; signature: string };
export type Scanner = (data: Buffer) => Promise<ScanResult>;

/**
 * ClamAV scanner speaking clamd's INSTREAM protocol over TCP (no extra dependency): the file is sent in chunks
 * ("zINSTREAM\0", then <4-byte big-endian length><bytes>... and a zero length), and clamd answers
 * "stream: OK" or "stream: <signature> FOUND". Anything else, a timeout or a refused connection is an error.
 */
export function clamdScanner(host: string, port: number, timeoutMs = 30_000): Scanner {
  return (data) => new Promise<ScanResult>((resolve, reject) => {
    const socket = connect({ host, port });
    const chunks: Buffer[] = [];
    const done = (err?: Error, result?: ScanResult) => {
      socket.destroy();
      if (err) reject(err); else resolve(result!);
    };
    socket.setTimeout(timeoutMs, () => done(new Error("Virus scanner timed out")));
    socket.on("error", (e) => done(new Error(`Virus scanner unavailable: ${e.message}`)));
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      const reply = Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim();
      if (/^stream: OK$/.test(reply)) return done(undefined, { clean: true });
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (found) return done(undefined, { clean: false, signature: found[1]! });
      done(new Error(`Virus scanner error: ${reply.slice(0, 200) || "no reply"}`));
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const CHUNK = 64 * 1024;
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
  });
}

/** OPENBUILD_CLAMD=host:port turns scanning on. */
export function scannerFromEnv(env: NodeJS.ProcessEnv): Scanner | undefined {
  const v = env.OPENBUILD_CLAMD?.trim();
  if (!v) return undefined;
  const m = /^(.+):(\d{1,5})$/.exec(v);
  if (!m) throw new Error("OPENBUILD_CLAMD must be host:port, e.g. clamav:3310");
  return clamdScanner(m[1]!, Number(m[2]));
}
