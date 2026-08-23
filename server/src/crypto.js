// At-rest encryption for everything that contains contact data.
//
// AES-256-GCM throughout. Every ciphertext is [12-byte IV][16-byte tag][body],
// so a truncated or tampered value fails to decrypt rather than yielding
// partial plaintext. Used for the email and suggestion columns, the stored
// filename, and the raw upload blocks.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';

const ALGO = 'aes-256-gcm';

export function encrypt(plaintext, key = config.dataKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(buf, key = config.dataKey) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Encrypt a plaintext file into fixed-size ciphertext blocks, handing each one
 * to `sink(index, ciphertext)` — which stores it in the database.
 *
 * Used to get the raw upload out of plaintext as quickly as possible. Block form
 * (rather than one blob) keeps both the encryption and the later
 * decrypt-and-parse bounded in memory, so a 200 MB upload never has to become a
 * 200 MB string.
 *
 * @returns {Promise<number>} number of blocks written
 */
export async function encryptFileToBlocks(srcPath, sink, blockBytes = 4 * 1024 * 1024) {
  const handle = await fs.open(srcPath, 'r');
  let index = 0;
  try {
    const buffer = Buffer.alloc(blockBytes);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, blockBytes, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGO, config.dataKey, iv);
      const body = Buffer.concat([cipher.update(buffer.subarray(0, bytesRead)), cipher.final()]);
      await sink(index, Buffer.concat([iv, cipher.getAuthTag(), body]));
      index++;
    }
  } finally {
    await handle.close();
  }
  return index;
}

/**
 * Stream the plaintext back out of those blocks.
 *
 * `readBlock(index)` returns the stored ciphertext. Blocks are pushed as Buffers
 * and the caller applies `setEncoding('utf8')`, so Node's StringDecoder rejoins
 * any multi-byte character that straddles a block boundary — decoding each block
 * independently would corrupt them.
 */
export function createDecryptedBlockStream(readBlock, blockCount, sliceBytes = 64 * 1024) {
  let index = 0;
  let pending = null;   // decrypted block awaiting emission
  let offset = 0;

  return new Readable({
    read() {
      // Deliberately deferred to the next event-loop turn.
      //
      // The source is a database row and an in-memory buffer, so nothing here
      // ever waits on real I/O. Pushing synchronously lets the entire ingest —
      // parse, encrypt, insert, all of it — run to completion inside a single
      // tick, which starves the HTTP server: the 202 announcing the job would
      // not reach the client until the work it announced had already finished.
      // setImmediate makes the pump cooperative.
      setImmediate(() => {
        try {
          if (!pending || offset >= pending.length) {
            if (index >= blockCount) { this.push(null); return; }
            const buf = readBlock(index++);
            if (!buf) throw new Error('missing upload block');
            const decipher = crypto.createDecipheriv(ALGO, config.dataKey, buf.subarray(0, 12));
            decipher.setAuthTag(buf.subarray(12, 28));
            pending = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
            offset = 0;
          }
          // Modest slices rather than one 4 MB push, so the parser's buffer and
          // this stream stay bounded regardless of block size.
          const end = Math.min(offset + sliceBytes, pending.length);
          const slice = pending.subarray(offset, end);
          offset = end;
          this.push(slice);
        } catch (err) {
          this.destroy(err);
        }
      });
    },
  });
}

/** Overwrite before unlinking so plaintext temp uploads aren't recoverable from free space. */
export async function shred(file) {
  try {
    const { size } = await fs.stat(file);
    const handle = await fs.open(file, 'r+');
    try {
      const chunk = crypto.randomBytes(Math.min(size, 1 << 20));
      for (let off = 0; off < size; off += chunk.length) {
        await handle.write(chunk, 0, Math.min(chunk.length, size - off), off);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch { /* file already gone — nothing to shred */ }
  await fs.rm(file, { force: true });
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Blind index: a deterministic keyed hash of the address, stored alongside the
// ciphertext so an exact-address lookup can compare 16 bytes per row instead of
// decrypting every row. Keyed rather than a plain hash, so the column cannot be
// attacked with a dictionary of common addresses, and derived from the data key
// so it rotates with it.
//
// Deliberately NOT indexed — see migration 4: the keys are random by
// construction, so maintaining a B-tree over them dominated ingest cost.
const BLIND_INDEX_KEY = crypto.hkdfSync('sha256', config.dataKey, Buffer.alloc(0), Buffer.from('blind-index-v1'), 32);

export function blindIndex(value) {
  return crypto.createHmac('sha256', Buffer.from(BLIND_INDEX_KEY))
    .update(String(value).trim().toLowerCase())
    .digest()
    .subarray(0, 16); // 128 bits is ample for equality lookup and halves the index size
}

export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
