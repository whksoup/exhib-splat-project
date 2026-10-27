// COLMAP sparse model: camera positions and viewing directions from images.bin.
// Only each image's pose and name are read; the 2D point lists are skipped.
import fs from 'node:fs';

/**
 * @param {string} file  sparse/<n>/images.bin
 * @returns {{ id: number, name: string, center: number[], forward: number[] }[]}
 *   center and forward (the camera's +z, where it looks) in the model's world frame.
 */
export function readColmapImages(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(64 * 1024);
  const images = [];
  try {
    fs.readSync(fd, buf, 0, 8, 0);
    const count = Number(buf.readBigUInt64LE(0));
    let pos = 8;
    for (let i = 0; i < count; i++) {
      const got = fs.readSync(fd, buf, 0, buf.length, pos);
      // id u32, qvec 4 x f64 (w x y z), tvec 3 x f64, camera id u32, name \0, num points2D u64
      const id = buf.readUInt32LE(0);
      const [w, x, y, z] = [4, 12, 20, 28].map((o) => buf.readDoubleLE(o));
      const t = [36, 44, 52].map((o) => buf.readDoubleLE(o));
      const end = buf.indexOf(0, 64);
      if (end < 0 || end >= got - 8) throw new Error(`images.bin: image ${i} name not found`);
      const name = buf.toString('utf8', 64, end);
      const points = Number(buf.readBigUInt64LE(end + 1));
      pos += end + 1 + 8 + points * 24;
      if (pos > size) throw new Error(`images.bin truncated at image ${i}`);
      // R (world -> camera) from the quaternion; centre = -Rᵀt, forward = Rᵀ[0, 0, 1] (R's third row).
      const R = [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
      ];
      const center = [0, 1, 2].map((c) => -(R[c] * t[0] + R[3 + c] * t[1] + R[6 + c] * t[2]));
      images.push({ id, name, center, forward: [R[6], R[7], R[8]] });
    }
  } finally {
    fs.closeSync(fd);
  }
  return images;
}
