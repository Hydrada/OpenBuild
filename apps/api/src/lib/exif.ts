/**
 * Reads the capture time from a JPEG's EXIF block (DateTimeOriginal, else DateTime). Returns "YYYY-MM-DDTHH:MM:SS"
 * in camera-local time, or null. Bounded and defensive: never throws on malformed input.
 */
export function exifTakenAt(buf: Buffer): string | null {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let off = 2;
    while (off + 4 <= buf.length && off < 256 * 1024) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1]!;
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString("latin1", off + 4, off + 10) === "Exif\0\0") return readTiff(buf.subarray(off + 10, off + 2 + len));
      if (marker === 0xda || len < 2) return null; // start of scan: no EXIF
      off += 2 + len;
    }
  } catch { /* malformed */ }
  return null;
}

function readTiff(t: Buffer): string | null {
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ascii = (entry: number) => {
    const count = u32(entry + 4);
    const at = count > 4 ? u32(entry + 8) : entry + 8;
    if (at + count > t.length) return null;
    return t.toString("latin1", at, at + count).replace(/\0.*$/, "");
  };
  const scan = (ifd: number) => {
    const found: Record<number, number> = {};
    if (ifd + 2 > t.length) return found;
    const n = Math.min(u16(ifd), 512);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > t.length) break;
      found[u16(e)] = e;
    }
    return found;
  };
  const ifd0 = scan(u32(4));
  let value: string | null = null;
  if (ifd0[0x8769] !== undefined) {
    const exif = scan(u32(ifd0[0x8769]! + 8));
    if (exif[0x9003] !== undefined) value = ascii(exif[0x9003]!);
  }
  if (!value && ifd0[0x0132] !== undefined) value = ascii(ifd0[0x0132]!);
  const m = value && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m || m[1] === "0000") return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}
