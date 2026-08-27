const CRC_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i += 1) {
  let crc = i;
  for (let j = 0; j < 8; j += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  CRC_TABLE[i] = crc >>> 0;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeXml(value: string) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function encodeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function findNeedle(haystack: string, needle: string) {
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return { index: exact, length: needle.length };
  const compact = needle.replace(/\s+/g, ' ').trim();
  if (compact.length < 4) return null;
  const collapsedHay: string[] = [];
  const indexMap: number[] = [];
  for (let i = 0; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (/\s/.test(ch)) {
      if (collapsedHay.length && collapsedHay[collapsedHay.length - 1] !== ' ') {
        collapsedHay.push(' ');
        indexMap.push(i);
      }
    } else {
      collapsedHay.push(ch);
      indexMap.push(i);
    }
  }
  const collapsed = collapsedHay.join('');
  const at = collapsed.indexOf(compact);
  if (at < 0) return null;
  const start = indexMap[at] ?? 0;
  const endIndex = indexMap[at + compact.length - 1] ?? start;
  return { index: start, length: endIndex - start + 1 };
}

function replaceParagraphText(paragraph: string, next: string) {
  const runs = [...paragraph.matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g)];
  if (!runs.length) return paragraph;
  let used = false;
  return paragraph.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (_full, attrs: string) => {
    if (used) return `<w:t xml:space="preserve"></w:t>`;
    used = true;
    const nextAttrs = /\bxml:space=/.test(attrs) ? attrs : `${attrs} xml:space="preserve"`;
    return `<w:t${nextAttrs}>${encodeXml(next)}</w:t>`;
  });
}

export function applyTextReplacements(text: string, pairs: Array<{ from: string; to: string }>) {
  let next = text;
  let applied = 0;
  const missed: string[] = [];
  for (const pair of pairs) {
    const hit = findNeedle(next, pair.from);
    if (!hit) {
      missed.push(pair.from);
      continue;
    }
    next = `${next.slice(0, hit.index)}${pair.to}${next.slice(hit.index + hit.length)}`;
    applied += 1;
  }
  return { text: next, applied, missed };
}

export function patchDocumentXml(xml: string, pairs: Array<{ from: string; to: string }>) {
  const remaining = pairs.filter((pair) => pair.from.trim() && pair.to.trim());
  const used = new Set<number>();
  const patched = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
    const current = paragraphPlain(paragraph);
    if (!current) return paragraph;
    let next = current;
    remaining.forEach((pair, index) => {
      if (used.has(index)) return;
      const hit = findNeedle(next, pair.from);
      if (!hit) return;
      next = `${next.slice(0, hit.index)}${pair.to}${next.slice(hit.index + hit.length)}`;
      used.add(index);
    });
    return next === current ? paragraph : replaceParagraphText(paragraph, next);
  });
  return { xml: patched, applied: used.size, missed: remaining.filter((_, index) => !used.has(index)).map((pair) => pair.from) };
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function inflateRaw(bytes: Uint8Array) {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(bytes: Uint8Array) {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readU16(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

function writeU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function findEocd(bytes: Uint8Array, view: DataView) {
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (readU32(view, i) !== 0x06054b50) continue;
    const comment = readU16(view, i + 20);
    if (i + 22 + comment === bytes.length) return i;
  }
  throw new Error('这份 Word 不是可改写的 .docx 压缩包。');
}

function paragraphPlain(paragraph: string) {
  return [...paragraph.replace(/<w:tab\b[^/]*\/>/g, ' ').replace(/<w:br\b[^/]*\/>/g, ' ').matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1]))
    .join('');
}

export function xmlToPlainText(xml: string) {
  return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((match) => paragraphPlain(match[0]).trim()).filter(Boolean).join('\n');
}

export async function unzipBytes(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEocd(bytes, view);
  const totalEntries = readU16(view, eocd + 10);
  const centralOffset = readU32(view, eocd + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff) throw new Error('这份 Word 体积过大，暂不支持写回原文。');
  const files = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (readU32(view, cursor) !== 0x02014b50) throw new Error('Word 压缩目录损坏。');
    const flags = readU16(view, cursor + 8);
    const method = readU16(view, cursor + 10);
    const compressedSize = readU32(view, cursor + 20);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const localOffset = readU32(view, cursor + 42);
    if (flags & 1) throw new Error('加密的 Word 无法写回。');
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('这份 Word 体积过大，暂不支持写回原文。');
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (readU32(view, localOffset) !== 0x04034b50) throw new Error('Word 压缩条目损坏。');
    const localNameLength = readU16(view, localOffset + 26);
    const localExtraLength = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed.slice() : method === 8 ? await inflateRaw(compressed) : (() => { throw new Error(`不支持的 Word 压缩方式（${method}）。`); })();
    files.set(name, data);
  }
  return files;
}

export async function zipBytes(files: Map<string, Uint8Array>) {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = encoder.encode(name);
    const store = data.length === 0;
    const compressed = store ? new Uint8Array(0) : await deflateRaw(data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x800);
    writeU16(localView, 8, store ? 0 : 8);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, compressed.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x800);
    writeU16(centralView, 10, store ? 0 : 8);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, compressed.length);
    writeU32(centralView, 24, data.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 8, files.size);
  writeU16(endView, 10, files.size);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, offset);
  const output = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

export function pickReplacementPairs(haystack: string, groups: Array<{ needles: string[]; to: string }>) {
  return groups.flatMap((group) => {
    const needles = group.needles.map((value) => value.trim()).filter((value) => value.length >= 4);
    const from = needles.find((value) => findNeedle(haystack, value)) ?? needles[0];
    return from ? [{ from, to: group.to }] : [];
  });
}

export async function patchOriginalDocx(source: ArrayBuffer, groups: Array<{ needles: string[]; to: string }>) {
  const files = await unzipBytes(source);
  const path = [...files.keys()].find((name) => name === 'word/document.xml' || name.endsWith('/word/document.xml'));
  if (!path) throw new Error('这份 Word 里没有可改写的正文。');
  const xmlBytes = files.get(path);
  if (!xmlBytes) throw new Error('这份 Word 里没有可改写的正文。');
  const xml = new TextDecoder().decode(xmlBytes);
  const pairs = pickReplacementPairs(xmlToPlainText(xml), groups);
  const result = patchDocumentXml(xml, pairs);
  files.set(path, new TextEncoder().encode(result.xml));
  const bytes = await zipBytes(files);
  return {
    blob: new Blob([toArrayBuffer(bytes)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    applied: result.applied,
    missed: result.missed,
    text: xmlToPlainText(result.xml),
  };
}
