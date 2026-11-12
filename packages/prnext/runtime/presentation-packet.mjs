// Internal display packets. React Flight transports the typed arrays using its
// official binary records; no wire records or user objects are rewritten.
const LIMIT = 1_000_000;
function jsonBytes(value) {
  if (value === undefined) return 12;
  if (typeof value !== 'string') return String(value).length;
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 92) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += c >= 0xd800 && c <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

/** Prefer flat scalar storage. Use binary columns/deduplicated strings only
 * when the estimated uncompressed saving exceeds 25%, including framing cost.
 * This is a bounded admission heuristic, not a compression/network guarantee.
 */
export function encodePresentationPacket(values) {
  if (values.length > LIMIT) throw new RangeError('Presentation packet budget');
  if (values.length < 256) return {__prnextFlat: values};
  const dictionary = new Map();
  let flatBytes = values.length + 2, stringBytes = 0;
  for (let index=0;index<values.length;index++) {
    const value=values[index];
    flatBytes += jsonBytes(value);
    if (typeof value === 'string' && !dictionary.has(value)) {
      dictionary.set(value, dictionary.size);
      stringBytes += jsonBytes(value) + 1;
    }
    // Most ordinary tables cannot benefit from binary columns. A bounded
    // prefix probe avoids constructing a full string dictionary on that path.
    // A false negative merely keeps the flat representation.
    if(index===255){
      const sampledFlatBytes=flatBytes-values.length+256;
      if(100+256*9+stringBytes>=sampledFlatBytes*.75)return{__prnextFlat:values};
    }
  }
  if (100 + values.length * 9 + stringBytes >= flatBytes * .75) return {__prnextFlat: values};
  const tags = new Uint8Array(values.length), numbers = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === undefined) tags[i] = 1;
    else if (typeof value === 'number') { tags[i] = 2; numbers[i] = value; }
    else if (typeof value === 'string') { tags[i] = 3; numbers[i] = dictionary.get(value); }
    else if (value !== null) throw new TypeError('Invalid display scalar');
  }
  return {__prnextBinary: [tags, numbers, [...dictionary.keys()]]};
}

export function presentationPacketReader(packet) {
  const flat = packet?.__prnextFlat;
  let read, length;
  if (Array.isArray(flat)) { length = flat.length; read = i => flat[i]; }
  else {
    const binary = packet?.__prnextBinary;
    if (!Array.isArray(binary) || binary.length !== 3) throw new TypeError('Invalid display packet');
    const [tags, numbers, strings] = binary;
    if (!(tags instanceof Uint8Array) || !(numbers instanceof Float64Array) || tags.length !== numbers.length || !Array.isArray(strings)) throw new TypeError('Invalid binary display packet');
    length = tags.length;
    read = i => {
      switch (tags[i]) {
        case 0: return null;
        case 1: return undefined;
        case 2: return numbers[i];
        case 3: {
          const index = numbers[i];
          if (!Number.isSafeInteger(index) || index < 0 || index >= strings.length || typeof strings[index] !== 'string') throw new TypeError('Invalid display string index');
          return strings[index];
        }
        default: throw new TypeError('Invalid display tag');
      }
    };
  }
  if (length > LIMIT) throw new RangeError('Presentation packet budget');
  return {
    length,
    at(i) {
      if (!Number.isSafeInteger(i) || i < 0 || i >= length) throw new RangeError('Display offset');
      const value = read(i);
      if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') throw new TypeError('Invalid display scalar');
      return value;
    },
    range(offset, width) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(width) || offset < 0 || width < 0 || offset + width > length) throw new RangeError('Display range');
    },
  };
}
