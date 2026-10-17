// Render the repository's simple vector mark into PNG using built-in Node APIs.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, content) {
  const typeBytes = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(content.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, content])));
  return Buffer.concat([size, typeBytes, content, crc]);
}
const points = [[33,94],[33,57],[49,57],[49,78],[78,49],[57,49],[57,33],[94,33],[94,70],[78,70],[78,61],[45,94]];
function inside(x, y) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}
for (const size of [16, 48, 128]) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0,0,0,0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) * 128 / size, py = (y + (sy + .5) / 4) * 128 / size;
      const cx = Math.max(28, Math.min(100, px)), cy = Math.max(28, Math.min(100, py));
      const opaque = (px-cx)**2 + (py-cy)**2 <= 28**2;
      const color = inside(px, py) ? [255,255,255] : [59,100,235];
      for (let k=0;k<3;k++) sum[k]+=color[k];
      sum[3]+=opaque?255:0;
    }
    const offset=y*(size*4+1)+1+x*4;
    for(let k=0;k<4;k++) data[offset+k]=Math.round(sum[k]/16);
  }
  const header=Buffer.alloc(13); header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
  fs.writeFileSync(path.join(__dirname,'..','icons','icon'+size+'.png'),png);
}
console.log('Generated 16, 48 and 128 px extension icons from the vector mark.');
