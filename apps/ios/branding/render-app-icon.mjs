// Rasterize app-icon.svg → the AppIcon asset's 1024x1024 PNG.
//
// The App Store rejects icons that carry an alpha channel, so we render
// with @resvg/resvg-js and then flatten to opaque RGB with sharp. The
// source SVG is already full-bleed opaque, so flatten only strips the
// (fully-opaque) alpha channel — no visible compositing.
//
// Usage (deps are not vendored to keep the repo lean):
//   cd apps/ios/branding
//   npm i --no-save @resvg/resvg-js sharp
//   node render-app-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, 'app-icon.svg'));

const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } });
const rgba = resvg.render().asPng();

const out = join(
  here,
  '..',
  'Argus/Sources/Assets.xcassets/AppIcon.appiconset/icon-1024.png',
);
const png = await sharp(rgba).flatten({ background: '#060D0A' }).png().toBuffer();
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
