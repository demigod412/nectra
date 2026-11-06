/* Minimal dependency-free PDF writer for the NECTRA guide.
   Uses the standard Helvetica/Helvetica-Bold/Courier fonts (no embedding),
   word-wraps with approximate glyph widths, and paginates automatically. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---- approximate Helvetica glyph widths (fraction of font size) ---- */
const narrow = 'iljtfI.,:;\'|!'; const wide = 'mwMW@'; const capsMed = 'ABCDEFGHKNOPQRSUVXYZ0123456789';
function charW(ch, size) { if (narrow.includes(ch)) return 0.3 * size; if (wide.includes(ch)) return 0.82 * size; if (capsMed.includes(ch)) return 0.68 * size; if (ch === ' ') return 0.3 * size; return 0.52 * size; }
const textW = (s, size) => s.split('').reduce((a, c) => a + charW(c, size), 0);
function wrap(text, size, maxW) {
  const words = String(text).split(/\s+/); const lines = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (textW(t, size) > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  return lines;
}
/* WinAnsi-safe: replace common unicode with ASCII */
const ascii = (s) => String(s).replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, '-').replace(/≥/g, '>=').replace(/≠/g, '!=').replace(/→/g, '->').replace(/·/g, '-').replace(/×/g, 'x').replace(/🌸|✅|📈|🕯|🔒/gu, '').replace(/[^\x20-\x7E]/g, '');
const esc = (s) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const PAGE = { w: 595.28, h: 841.89 }; // A4
const M = 56; const PINK = '0.949 0.333 0.604'; const DARK = '0.15 0.15 0.18'; const GREY = '0.42 0.42 0.46';

function build(blocks) {
  const pages = []; let ops = []; let y = PAGE.h - M; const usable = PAGE.w - 2 * M;
  const nl = (h) => { y -= h; if (y < M + 24) { pages.push(ops); ops = []; y = PAGE.h - M; } };
  const line = (txt, { size = 10.5, font = 'F1', color = DARK, indent = 0, gap = 4 } = {}) => {
    for (const ln of wrap(txt, size, usable - indent)) {
      if (y < M + 20) { pages.push(ops); ops = []; y = PAGE.h - M; }
      ops.push(`${color} rg BT /${font} ${size} Tf 1 0 0 1 ${M + indent} ${y} Tm (${esc(ln)}) Tj ET`);
      y -= size + 3;
    }
    y -= gap;
  };
  for (const b of blocks) {
    if (b.t === 'title') { nl(0); ops.push(`${PINK} rg BT /F2 24 Tf 1 0 0 1 ${M} ${y} Tm (${esc(b.v)}) Tj ET`); y -= 30; if (b.sub) line(b.sub, { size: 11, color: GREY, gap: 10 }); ops.push(`${PINK} RG 1.5 w ${M} ${y + 6} m ${PAGE.w - M} ${y + 6} l S`); y -= 14; }
    else if (b.t === 'h1') { if (y < M + 80) { pages.push(ops); ops = []; y = PAGE.h - M; } y -= 8; ops.push(`${PINK} rg BT /F2 16 Tf 1 0 0 1 ${M} ${y} Tm (${esc(b.v)}) Tj ET`); y -= 22; }
    else if (b.t === 'h2') { y -= 4; line(b.v, { size: 12.5, font: 'F2', color: DARK, gap: 5 }); }
    else if (b.t === 'p') line(b.v, { gap: 7 });
    else if (b.t === 'li') { ops.push(`${PINK} rg BT /F1 10.5 Tf 1 0 0 1 ${M + 6} ${y} Tm (-) Tj ET`); line(b.v, { indent: 18, gap: 3 }); }
    else if (b.t === 'num') { ops.push(`${GREY} rg BT /F2 10.5 Tf 1 0 0 1 ${M + 4} ${y} Tm (${b.n}.) Tj ET`); line(b.v, { indent: 20, gap: 3 }); }
    else if (b.t === 'code') line(b.v, { font: 'F3', size: 9.5, color: '0.2 0.2 0.5', indent: 6, gap: 6 });
    else if (b.t === 'note') { line(b.v, { size: 9.5, color: GREY, gap: 7 }); }
    else if (b.t === 'space') y -= (b.v || 8);
  }
  pages.push(ops);
  return pages;
}

function render(pages) {
  const objs = []; const add = (s) => { objs.push(s); return objs.length; };
  const fonts = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Courier' };
  const fontIds = {};
  const kids = [];
  const pagesId = 2; // reserved
  // font objects
  const fontObjNums = {};
  Object.entries(fonts).forEach(([k, name]) => { fontObjNums[k] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`); });
  const contentNums = [];
  const pageNums = [];
  pages.forEach((ops, i) => {
    // footer
    const footer = `${GREY} rg BT /F1 8 Tf 1 0 0 1 ${M} ${M - 24} Tm (NECTRA - demo/educational build. Not financial advice. Trading and borrowing carry risk of loss.  Page ${i + 1} of ${pages.length}) Tj ET`;
    const stream = ops.concat(footer).join('\n');
    const comp = zlib.deflateSync(Buffer.from(stream, 'latin1'));
    const cNum = add(`<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n@@STREAM${objs.length}@@\nendstream`);
    contentNums.push({ num: cNum, data: comp });
    const fontRes = Object.entries(fontObjNums).map(([k, n]) => `/${k} ${n} 0 R`).join(' ');
    const pNum = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << ${fontRes} >> >> /Contents ${cNum} 0 R >>`);
    pageNums.push(pNum);
  });
  // now assemble file with proper object numbering; we used add() which pushed in order, but Catalog/Pages need fixed early numbers.
  // Rebuild with explicit numbering instead:
  return assemble(pages);
}

/* Cleaner assembler with deterministic object numbers */
function assemble(pages) {
  const fonts = [['F1', 'Helvetica'], ['F2', 'Helvetica-Bold'], ['F3', 'Courier']];
  let n = 0; const obj = []; // obj[i] = {id, body(Buffer|string)}
  const id = () => ++n;
  const catalogId = id(), pagesId = id();
  const fontIds = fonts.map(() => id());
  const pageObjs = pages.map(() => ({ pageId: id(), contentId: id() }));
  const parts = [];
  const push = (oid, body) => parts.push({ oid, body });
  push(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  push(pagesId, `<< /Type /Pages /Kids [${pageObjs.map((p) => p.pageId + ' 0 R').join(' ')}] /Count ${pages.length} >>`);
  fonts.forEach((f, i) => push(fontIds[i], `<< /Type /Font /Subtype /Type1 /BaseFont /${f[1]} /Encoding /WinAnsiEncoding >>`));
  const fontRes = fonts.map((f, i) => `/${f[0]} ${fontIds[i]} 0 R`).join(' ');
  pages.forEach((ops, i) => {
    const footer = `${GREY} rg BT /F1 8 Tf 1 0 0 1 ${M} ${M - 26} Tm (NECTRA guide - demo/educational build. Not financial advice. Trading and borrowing carry risk of loss.   ${i + 1}/${pages.length}) Tj ET`;
    const stream = Buffer.from(ops.concat(footer).join('\n'), 'latin1');
    const comp = zlib.deflateSync(stream);
    push(pageObjs[i].pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << ${fontRes} >> >> /Contents ${pageObjs[i].contentId} 0 R >>`);
    push(pageObjs[i].contentId, Buffer.concat([Buffer.from(`<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), comp, Buffer.from('\nendstream', 'latin1')]));
  });
  parts.sort((a, b) => a.oid - b.oid);
  let out = Buffer.from('%PDF-1.5\n%\xff\xff\xff\xff\n', 'latin1');
  const offsets = [0];
  for (const p of parts) {
    offsets[p.oid] = out.length;
    const head = Buffer.from(`${p.oid} 0 obj\n`, 'latin1');
    const body = Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body, 'latin1');
    out = Buffer.concat([out, head, body, Buffer.from('\nendobj\n', 'latin1')]);
  }
  const xref = out.length;
  let x = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size ${n + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.concat([out, Buffer.from(x, 'latin1')]);
}

module.exports = { build, assemble, render };

if (require.main === module) {
  const blocks = require('./guide-content.js');
  const pdf = assemble(build(blocks));
  const out1 = path.join(__dirname, '..', 'NECTRA-Guide.pdf');
  const out2 = path.join(__dirname, '..', 'public', 'NECTRA-Guide.pdf');
  fs.writeFileSync(out1, pdf); fs.writeFileSync(out2, pdf);
  console.log('wrote', out1, '(' + pdf.length + ' bytes) and', out2);
}
