import {presentationPacketReader} from '../packages/prnext/runtime/presentation-packet.mjs';

export function inflatePresentationPacket(packet, layout) {
  const reader = presentationPacketReader(packet);
  function row(offset, shape, depth = 0) {
    if (depth > 64) throw new RangeError('Display layout depth');
    reader.range(offset, shape.width);
    const values = Array.from({length: shape.width}, (_, i) => reader.at(offset + i));
    for (const [index, child] of Object.entries(shape.arrays || {})) {
      const pointer = values[index], count = reader.at(pointer), width = reader.at(pointer + 1);
      if (!Number.isSafeInteger(count) || count < 0 || count > 20000 || width !== child.width) throw new RangeError('Display list');
      reader.range(pointer + 2, count * width);
      values[index] = Array.from({length: count}, (_, i) => row(pointer + 2 + i * width, child, depth + 1));
    }
    for (const [index, choices] of Object.entries(shape.branches || {})) {
      const pointer = values[index], choice = reader.at(pointer);
      if (choice !== 0 && choice !== 1) throw new TypeError('Display branch');
      values[index] = row(pointer, choices[choice], depth + 1);
    }
    return values;
  }
  return row(0, layout);
}
