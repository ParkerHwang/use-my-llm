/**
 * Minimal read-only ZIP reader for a Claude data export.
 *
 * Reads the central directory and extracts named members into memory. It never
 * writes to disk and never uses member paths as file-system paths, so archive
 * names cannot escape anywhere. Stored and deflated members are supported;
 * encrypted, multi-disk and ZIP64 archives are rejected.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;
const MAX_ENTRIES = 100_000;
const MAX_CENTRAL_BYTES = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  method: number;
  encrypted: boolean;
  offset: number;
  crc32: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** Extract one member. Throws when it is larger than `maxBytes`. */
  read(entry: ZipEntry, maxBytes: number): Buffer;
  close(): void;
}

function zipError(message: string): Error {
  return Object.assign(new Error(message), { code: 'INVALID_ZIP' });
}

let crcTable: Uint32Array | undefined;
function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) crc = crcTable[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function openZip(path: string): ZipArchive {
  const descriptor = openSync(path, 'r');
  const readAt = (offset: number, length: number): Buffer => {
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const count = readSync(descriptor, buffer, done, length - done, offset + done);
      if (count === 0) throw zipError('The archive is truncated.');
      done += count;
    }
    return buffer;
  };

  try {
    const fileSize = fstatSync(descriptor).size;
    if (fileSize < 22) throw zipError('This is not a ZIP archive.');
    const tailSize = Math.min(fileSize, 22 + MAX_COMMENT);
    const tail = readAt(fileSize - tailSize, tailSize);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === END_SIGNATURE) {
        end = index;
        break;
      }
    }
    if (end === -1) throw zipError('This is not a ZIP archive.');
    const disk = tail.readUInt16LE(end + 4);
    const count = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (disk !== 0 || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw zipError('Multi-part and ZIP64 archives are not supported.');
    }
    if (count > MAX_ENTRIES || centralSize > MAX_CENTRAL_BYTES || centralOffset + centralSize > fileSize) {
      throw zipError('The archive directory is invalid.');
    }

    const central = readAt(centralOffset, centralSize);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw zipError('The archive directory is invalid.');
      }
      const flags = central.readUInt16LE(cursor + 8);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      entries.push({
        name: central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
        method: central.readUInt16LE(cursor + 10),
        crc32: central.readUInt32LE(cursor + 16),
        compressedSize: central.readUInt32LE(cursor + 20),
        size: central.readUInt32LE(cursor + 24),
        offset: central.readUInt32LE(cursor + 42),
        encrypted: (flags & 1) === 1,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    return {
      entries,
      read(entry, maxBytes) {
        if (entry.encrypted) throw zipError('Encrypted archive members are not supported.');
        if (entry.size > maxBytes || entry.compressedSize > maxBytes) throw zipError('An archive member is too large.');
        if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff) throw zipError('ZIP64 members are not supported.');
        const local = readAt(entry.offset, 30);
        if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw zipError('The archive is damaged.');
        const dataOffset = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataOffset + entry.compressedSize > fileSize) throw zipError('The archive is truncated.');
        const compressed = readAt(dataOffset, entry.compressedSize);
        let data: Buffer;
        if (entry.method === 0) data = compressed;
        else if (entry.method === 8) {
          // The declared size is the limit, so a crafted member cannot expand further.
          try {
            data = inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1) });
          } catch {
            throw zipError('An archive member could not be decompressed.');
          }
        } else throw zipError('This compression method is not supported.');
        if (data.length !== entry.size || crc32(data) !== entry.crc32) throw zipError('The archive is damaged.');
        return data;
      },
      close() {
        closeSync(descriptor);
      },
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
