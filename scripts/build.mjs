// Builds www/ from src/: bundles the native storage layer, copies the fonts
// and wraps src/app.html (the same page published on claude.ai) in a full document.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';

const out = 'www';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/fonts`, { recursive: true });

await build({ entryPoints: ['src/native.js'], bundle: true, minify: true, format: 'iife', target: 'chrome100', outfile: `${out}/native.js` });

const fonts = [
  ['bricolage-grotesque', 'Bricolage Grotesque', 500],
  ['bricolage-grotesque', 'Bricolage Grotesque', 700],
  ['instrument-sans', 'Instrument Sans', 400],
  ['instrument-sans', 'Instrument Sans', 500],
  ['instrument-sans', 'Instrument Sans', 600],
];
let fontCss = '';
for (const [pkg, family, weight] of fonts) {
  for (const subset of ['latin']) {
    const file = `${pkg}-${subset}-${weight}-normal.woff2`;
    copyFileSync(`node_modules/@fontsource/${pkg}/files/${file}`, `${out}/fonts/${file}`);
    fontCss += `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(fonts/${file}) format("woff2");}\n`;
  }
}

let page = readFileSync('src/app.html', 'utf8');
// Fonts ship inside the app instead of coming from Google Fonts.
page = page.replace(/<link rel="preconnect"[^>]*>\n?/, '').replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n?/, '');
page = page.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '');

const head = `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f5fd1">
<style>
${fontCss}
:root { color-scheme: light; padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px)); }
body { margin: 0; overscroll-behavior-y: none; }
[hidden] { display: none !important; }
</style>
<script src="native.js"></script>
</head>
<body>
`;
writeFileSync(`${out}/index.html`, head + page + '\n</body>\n</html>\n');
console.log('www/ built');
