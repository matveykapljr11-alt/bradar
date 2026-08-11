'use strict';
// Build the static page Vercel will serve at "/": the mini-app + a <script src="/bradar-api.js">.
const fs = require('fs');
let html = fs.readFileSync('../bradar.html', 'utf8');
if (!/src="\/bradar-api\.js"/.test(html)) {
  // insert before the LAST </body> — the app's JS contains a literal "</body>"
  // (in the print-PDF helper), so a naive first-match replace would corrupt the script.
  const tag = '<script src="/bradar-api.js"></script>\n';
  const i = html.lastIndexOf('</body>');
  html = i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}
fs.writeFileSync('public/index.html', html);
console.log('generated public/index.html (' + html.length + ' bytes)');
