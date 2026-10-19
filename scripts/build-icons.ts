import { Resvg } from '@resvg/resvg-js';
import * as fs from 'fs';
import * as path from 'path';

// Renders the Rekindle mark (web/public/favicon.svg) into the extension's PNG icons, so the
// browser toolbar, the favicon and the app header share one drawing. Run: pnpm build:icons
const svg = fs.readFileSync(path.resolve('web/public/favicon.svg'), 'utf-8');
for (const size of [16, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();
  const out = path.resolve('extension/icons', `icon-${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`${out} (${png.length} bytes)`);
}
