import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Just enough ZIP for .xlsx files: write deflated entries, read stored or deflated ones.
 * No ZIP64 (files over 4 GB), no encryption, no multi-disk archives.
 */

/** The file isn't a ZIP archive we can read (e.g. not an .xlsx, or damaged). */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UTF8_NAMES = 0x0800;
/** Unpacked size limit, so a malicious archive can't exhaust memory. */
const MAX_TOTAL_SIZE = 256 * 1024 * 1024;

/** 1980-01-01 00:00 in DOS format; a fixed timestamp keeps output reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const packed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);

    parts.push(local, name, packed);
    central.push(header, name);
    offset += local.length + name.length + packed.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** Every entry by name. Sizes come from the central directory, so data descriptors are fine. */
export function readZip(archive: Buffer): Map<string, Buffer> {
  const end = findEndOfCentral(archive);
  const count = archive.readUInt16LE(end + 10);
  let pointer = archive.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  let total = 0;

  for (let index = 0; index < count; index++) {
    if (pointer + 46 > archive.length || archive.readUInt32LE(pointer) !== CENTRAL_HEADER) {
      throw new ZipError('The file is damaged: its table of contents is unreadable.');
    }
    const method = archive.readUInt16LE(pointer + 10);
    const packedSize = archive.readUInt32LE(pointer + 20);
    const size = archive.readUInt32LE(pointer + 24);
    const nameLength = archive.readUInt16LE(pointer + 28);
    const extraLength = archive.readUInt16LE(pointer + 30);
    const commentLength = archive.readUInt16LE(pointer + 32);
    const localOffset = archive.readUInt32LE(pointer + 42);
    const name = archive.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new ZipError(`The file is damaged: "${name}" can't be found in it.`);
    }
    const dataStart =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const packed = archive.subarray(dataStart, dataStart + packedSize);
    total += size;
    if (total > MAX_TOTAL_SIZE) throw new ZipError('The file is too large to read.');

    if (method === 0) {
      entries.set(name, Buffer.from(packed));
    } else if (method === 8) {
      try {
        entries.set(name, inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) }));
      } catch {
        throw new ZipError(`The file is damaged: "${name}" can't be unpacked.`);
      }
    } else {
      throw new ZipError(`"${name}" uses an unsupported compression method (${String(method)}).`);
    }
  }
  return entries;
}

function findEndOfCentral(archive: Buffer): number {
  // The end record is 22 bytes plus a comment of up to 65535 bytes.
  const lowest = Math.max(0, archive.length - 22 - 0xffff);
  for (let at = archive.length - 22; at >= lowest; at--) {
    if (archive.readUInt32LE(at) === END_OF_CENTRAL) return at;
  }
  throw new ZipError("The file isn't an .xlsx spreadsheet (it isn't a ZIP archive).");
}
