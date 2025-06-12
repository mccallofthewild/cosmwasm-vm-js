import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
let mode: 'major' | 'minor' | 'patch' = 'patch';
for (const arg of args) {
  if (arg === '--major') mode = 'major';
  if (arg === '--minor') mode = 'minor';
  if (arg === '--patch') mode = 'patch';
}

const pkgPath = join(dirname(new URL(import.meta.url).pathname), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
const parts = pkg.version.split('.').map(Number);
let [major, minor, patch] = parts;

switch (mode) {
  case 'major':
    major += 1;
    minor = 0;
    patch = 0;
    break;
  case 'minor':
    minor += 1;
    patch = 0;
    break;
  case 'patch':
    patch += 1;
    break;
}

const newVersion = `${major}.${minor}.${patch}`;
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

execSync('git add package.json', { stdio: 'inherit' });
execSync(`git commit -m "Bump version"`, { stdio: 'inherit' });
execSync(`git tag v${newVersion}`, { stdio: 'inherit' });
console.log(`Bumped to v${newVersion}`);

