'use strict';
// Build the static page Vercel will serve at "/": the mini-app + a <script src="/bradar-api.js">.
const fs = require('fs');
let html = fs.readFileSync('../bradar.html', 'utf8');
if (!/src="\/bradar-api\.js"/.test(html)) {
  html = html.replace(/<\/body>/i, '<script src="/bradar-api.js"></script>\n</body>');
}
fs.writeFileSync('public/index.html', html);
console.log('generated public/index.html (' + html.length + ' bytes)');
