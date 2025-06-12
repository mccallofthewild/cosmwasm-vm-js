import { join } from 'path';

interface Pkg {
  version: string;
  [key: string]: unknown;
}

function run(cmd: string[]) {
  const result = Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd.join(' ')}`);
  }
}

const args = process.argv.slice(2);
let mode: 'major' | 'minor' | 'patch' = 'patch';
for (const arg of args) {
  if (arg === '--major') mode = 'major';
  if (arg === '--minor') mode = 'minor';
  if (arg === '--patch') mode = 'patch';
}

const pkgPath = join(import.meta.dir, '..', 'package.json');
const pkgContent = await Bun.file(pkgPath).text();
const pkg: Pkg = JSON.parse(pkgContent);
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
await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

run(['git', 'add', 'package.json']);
run(['git', 'commit', '-m', `Bump version to v${newVersion}`]);
run(['git', 'tag', `v${newVersion}`]);
console.log(`Bumped to v${newVersion}`);
