import { applyTextReplacements, patchDocumentXml, patchOriginalDocx, xmlToPlainText, zipBytes, unzipBytes } from './patchDocx.ts';

const xml = '<w:p><w:r><w:t>负责增长实验与复盘</w:t></w:r></w:p>';
const patched = patchDocumentXml(xml, [{ from: '负责增长实验与复盘', to: '负责 B 端增长实验，并沉淀复盘机制' }]);
if (!patched.xml.includes('负责 B 端增长实验，并沉淀复盘机制') || patched.applied !== 1) {
  console.error('RED: exact paragraph replace failed', patched);
  process.exit(1);
}

const split = patchDocumentXml('<w:p><w:r><w:t>负责</w:t></w:r><w:r><w:t>增长实验</w:t></w:r></w:p>', [{ from: '负责增长实验', to: '主导增长实验' }]);
if (!split.xml.includes('主导增长实验') || split.applied !== 1) {
  console.error('RED: split-run replace failed', split);
  process.exit(1);
}

const spaced = applyTextReplacements('负责  增长实验', [{ from: '负责 增长实验', to: '主导增长实验' }]);
if (spaced.text !== '主导增长实验' || spaced.applied !== 1) {
  console.error('RED: whitespace-normalized replace failed', spaced);
  process.exit(1);
}

const sample = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xml}</w:body></w:document>`;
const files = new Map<string, Uint8Array>([
  ['[Content_Types].xml', new TextEncoder().encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>')],
  ['word/document.xml', new TextEncoder().encode(sample)],
]);
const zipped = await zipBytes(files);
const roundtrip = await unzipBytes(zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength));
const xmlBack = new TextDecoder().decode(roundtrip.get('word/document.xml'));
if (!xmlBack.includes('负责增长实验与复盘')) {
  console.error('RED: zip roundtrip lost document.xml', xmlBack);
  process.exit(1);
}

const written = await patchOriginalDocx(zipped.buffer, [{ needles: ['负责增长实验与复盘'], to: '负责 B 端增长实验' }]);
if (written.applied !== 1 || !written.text.includes('负责 B 端增长实验')) {
  console.error('RED: original docx patch failed', written);
  process.exit(1);
}
if (!xmlToPlainText(sample).includes('负责增长实验与复盘')) {
  console.error('RED: xmlToPlainText failed');
  process.exit(1);
}

console.log('GREEN');
