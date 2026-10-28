import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const out = 'plugins/codex-wechat/dist';
await mkdir(out, { recursive: true });
await build({
  entryPoints: ['src/cli.mjs'], outfile: `${out}/cli.cjs`, bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', minify: true,
  legalComments: 'external', banner: { js: '#!/usr/bin/env node' },
  define: { 'import.meta.url': '__entryUrl' },
  inject: ['scripts/entry-url.cjs'],
});
await writeFile(`${out}/dashboard.html`, await readFile('src/dashboard.html'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const { readdir } = await import('node:fs/promises');
const notices = [];
for (const location of Object.keys(lock.packages).sort()) {
  const info = lock.packages[location];
  if (!location || info.dev) continue;
  const pkg = JSON.parse(await readFile(`${location}/package.json`, 'utf8'));
  const names = (await readdir(location)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort();
  const texts = await Promise.all(names.map(name => readFile(`${location}/${name}`, 'utf8')));
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license || info.license || 'see package'})\n${texts.join('\n')}`);
}
await writeFile(`${out}/THIRD-PARTY-LICENSES.txt`, notices.join('\n\n========================================\n\n').replace(/\r\n/g, '\n').replace(/[\t ]+$/gm, ''));
console.log('Built standalone plugin (no npm install required on the target machine).');
