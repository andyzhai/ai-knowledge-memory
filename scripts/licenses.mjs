import { readFile, mkdir, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packages = Object.entries(lock.packages).filter(([path]) => path.startsWith('node_modules/')).map(([path, value]) => ({
  name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
  version: value.version, license: value.license ?? 'REVIEW_REQUIRED', dev: !!value.dev,
})).sort((a, b) => a.name.localeCompare(b.name));
const directory = process.argv.includes('--h') ? 'artifacts/licenses/h' : 'artifacts/licenses/default';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/dependencies.json`, JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages }, null, 2) + '\n');
console.log(`Wrote ${packages.length} pinned package/license entries to ${directory}; review bundled LICENSES files in the corresponding build.`);
