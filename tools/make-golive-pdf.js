/* Builds NECTRA-GoLive-Checklist.pdf from tools/golive-content.js using the guide PDF writer. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { build, assemble } = require('./make-guide-pdf.js');

const pdf = assemble(build(require('./golive-content.js')));
const out = path.join(__dirname, '..', 'NECTRA-GoLive-Checklist.pdf');
fs.writeFileSync(out, pdf);
console.log('wrote', out, '(' + pdf.length + ' bytes)');
