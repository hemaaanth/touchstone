import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const MAX_REVIEW_IMAGE_BYTES = 5 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function validReviewBytes(bytes, sha256) {
  return Buffer.isBuffer(bytes) && bytes.length >= 33 && bytes.length <= MAX_REVIEW_IMAGE_BYTES
    && bytes.subarray(0, 8).equals(pngSignature) && bytes.readUInt32BE(8) === 13
    && bytes.toString('ascii', 12, 16) === 'IHDR'
    && typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)
    && createHash('sha256').update(bytes).digest('hex') === sha256;
}

/** Linux descriptor anchors prevent a renamed parent or symlink from redirecting the read. */
export async function readReviewImage({ path, sha256 }, { openFile = open } = {}) {
  if (typeof path !== 'string' || !/^\/var\/lib\/touchstone\/session\/shot-(?:[1-9]|1[0-2])\.png$/.test(path)
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('Image review unavailable');
  const handles = [];
  try {
    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let parent = await openFile('/', directoryFlags);
    handles.push(parent);
    for (const name of ['var', 'lib', 'touchstone', 'session']) {
      parent = await openFile('/proc/self/fd/' + parent.fd + '/' + name, directoryFlags);
      handles.push(parent);
    }
    const file = await openFile('/proc/self/fd/' + parent.fd + '/' + path.split('/').at(-1), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const info = await file.stat();
    if (!info.isFile() || info.size < 33 || info.size > MAX_REVIEW_IMAGE_BYTES) throw Error('Invalid image');
    const buffer = Buffer.allocUnsafe(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytesRead !== info.size || !validReviewBytes(bytes, sha256)) throw Error('Invalid image');
    return bytes;
  } catch {
    throw Error('Image review unavailable');
  } finally {
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
  }
}
