const MAX_BYTES = 2 * 1024 * 1024;
const tooLarge = () => new Error("'use cache' arguments exceed 2 MiB");
export async function encodeCacheArguments(body) {
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_BYTES) throw tooLarge();
    return Buffer.from(body);
  }
  const entries = [];
  let size = 0;
  for (const [name, value] of body) {
    const text = typeof value === 'string';
    const head = JSON.stringify([name, text ? 'text' : 'blob', text ? '' : value.type, text ? '' : value.name]);
    const headLength = Buffer.byteLength(head);
    const length = text ? Buffer.byteLength(value) : value.size;
    size += 8 + headLength + length;
    if (size > MAX_BYTES) throw tooLarge();
    if (entries.length >= 10000) throw new Error("'use cache' arguments exceed 10000 encoded fields");
    entries.push({ head, headLength, value, length, text });
  }
  // Check the complete body before copying Blob bytes or invoking decodeReply.
  const result = Buffer.allocUnsafe(size);
  let offset = 0;
  for (const entry of entries) {
    result.writeUInt32BE(entry.headLength, offset);
    result.writeUInt32BE(entry.length, offset + 4);
    offset += 8;
    offset += result.write(entry.head, offset);
    if (entry.text) result.write(entry.value, offset);
    else Buffer.from(await entry.value.arrayBuffer()).copy(result, offset);
    offset += entry.length;
  }
  return result;
}
