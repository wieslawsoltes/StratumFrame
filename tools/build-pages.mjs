/** Stage an explicit static-site allowlist; all URLs remain relative for project Pages. */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const site = new URL('_site/', root);
await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
for (const path of ['index.html', 'styles.css', 'assets', 'src', 'tests', 'docs', 'examples', 'dist', 'README.md', 'LICENSE']) {
  await cp(new URL(path, root), new URL(path, site), { recursive: true });
}
await cp(new URL('dist/stratum-frame.html', root), new URL('stratum-frame.html', site));
await writeFile(new URL('.nojekyll', site), '');
console.log('Staged _site with native modules, worker, examples, documentation and standalone download.');
