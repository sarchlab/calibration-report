import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {after, before, test} from 'node:test';
import {cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
let temporary, install, executable, packageRoot, packedFiles, originalDistData;
const inputBytes = await readFile(join(root, 'examples/data.json'));
const run = (command, args, cwd = temporary) => spawnSync(command, args, {
  cwd, encoding: 'utf8', timeout: 60000,
});
const succeed = (result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
};
const cli = (...args) => run(executable, args);

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'calibration-report-package-'));
  originalDistData = await readFile(join(root, 'dist/data.json')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  // Exercise prepack in a copied checkout, preserving the real preview/data.
  const fixture = join(temporary, 'source');
  await mkdir(fixture);
  for (const path of ['package.json', 'README.md', 'LICENSE', 'vite.config.js', 'bin', 'site', 'data.schema.json'])
    await cp(join(root, path), join(fixture, path), {
      recursive: true, filter: (source) => source !== join(root, 'site/data.json'),
    });
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  succeed(run('npm', ['pack', '--pack-destination', temporary], fixture));
  const privateData = join(fixture, 'dist/data.json');
  const sourceMap = join(fixture, 'dist/assets/private.js.map');
  const extraAsset = join(fixture, 'dist/assets/private.json');
  await writeFile(privateData, 'PRIVATE_CALIBRATION_DATA');
  await writeFile(sourceMap, 'PRIVATE_SOURCE_MAP');
  await writeFile(extraAsset, 'PRIVATE_EXTRA_ASSET');
  try {
    const result = succeed(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], fixture));
    packedFiles = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  } finally {
    await Promise.all([privateData, sourceMap, extraAsset].map((file) => rm(file)));
  }
  install = join(temporary, 'isolated consumer');
  await mkdir(install);
  await writeFile(join(install, 'package.json'), '{"private":true}');
  succeed(run('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(temporary, `calibration-report-${metadata.version}.tgz`)], install));
  executable = join(install, 'node_modules/.bin/calibration-report');
  packageRoot = join(install, 'node_modules/calibration-report');
});

after(async () => {
  if (temporary) await rm(temporary, {recursive: true, force: true});
});

test('packing leaves the source checkout report data unchanged', async () => {
  const current = await readFile(join(root, 'dist/data.json')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  assert.deepEqual(current, originalDistData);
});

test('published contents exclude local data, source maps and development files', async () => {
  assert.deepEqual(packedFiles.filter((name) => !name.startsWith('dist/assets/')), [
    'LICENSE', 'README.md', 'bin/calibration-report.js', 'data.schema.json', 'dist/index.html', 'dist/LICENSE', 'dist/THIRD_PARTY_LICENSES.md', 'package.json',
  ]);
  assert.equal(packedFiles.filter((name) => name.startsWith('dist/assets/')).length, 2);
  assert(packedFiles.every((name) => !name.endsWith('data.json') && !name.endsWith('.map')));
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.license, 'MIT');
  assert.equal(installed.dependencies, undefined);
  assert.equal(installed.scripts.install, undefined);
  assert.equal(installed.scripts.postinstall, undefined);
  assert.deepEqual((await readdir(join(install, 'node_modules'))).filter((name) => !name.startsWith('.')), ['calibration-report']);
});

test('the package and built viewer preserve the project MIT license', async () => {
  const source = await readFile(join(root, 'LICENSE'));
  assert.deepEqual(await readFile(join(packageRoot, 'LICENSE')), source);
  assert.deepEqual(await readFile(join(packageRoot, 'dist/LICENSE')), source);
});

test('the bundled viewer preserves complete dependency license notices', async () => {
  const notices = await readFile(join(packageRoot, 'dist/THIRD_PARTY_LICENSES.md'), 'utf8');
  for (const dependency of ['@mantine/core', '@mantine/hooks', 'clsx', 'react', 'react-dom', 'react-number-format', 'scheduler']) {
    const directory = join(root, 'node_modules', dependency);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const filename = dependency === 'clsx' ? 'license' : 'LICENSE';
    const license = await readFile(join(directory, filename), 'utf8');
    assert(notices.includes(`## ${dependency} - ${pkg.version} (MIT)`), dependency);
    assert(notices.includes(license.trim()), dependency + ' full license text');
  }
});

test('installed executable generates byte-identical data and relative assets in a path with spaces', async () => {
  const input = join(temporary, 'input data.json');
  const output = join(temporary, 'new report');
  await writeFile(input, inputBytes);
  succeed(cli('--data', input, '--out', output));
  assert.deepEqual(await readFile(join(output, 'data.json')), inputBytes);
  assert.deepEqual(await readFile(input), inputBytes);
  const html = await readFile(join(output, 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
  assert.equal(references.length, 2);
  for (const asset of ['index.html', 'LICENSE', 'THIRD_PARTY_LICENSES.md', ...references])
    assert.deepEqual(await readFile(join(output, asset)), await readFile(join(packageRoot, 'dist', asset)));
  const empty = join(temporary, 'existing empty');
  await mkdir(empty);
  succeed(cli('--data', input, '--out', empty));
  assert.deepEqual(await readFile(join(empty, 'data.json')), inputBytes);
});

test('installed CLI reports help, version and argument errors without creating output', async () => {
  assert.match(succeed(cli('--help')).stdout, /--data.*--out/);
  assert.equal(succeed(cli('--version')).stdout.trim(), metadata.version);
  assert.notEqual(cli().status, 0);
  assert.match(cli().stderr, /Both --data and --out are required/);
  assert.notEqual(cli('--unknown').status, 0);
  const invalid = join(temporary, 'invalid.json');
  const output = join(temporary, 'should not exist');
  await writeFile(invalid, '{');
  assert.match(cli('--data', invalid, '--out', output).stderr, /not valid JSON/);
  await assert.rejects(readdir(output), {code: 'ENOENT'});
  assert.notEqual(cli('--data', join(temporary, 'missing.json'), '--out', output).status, 0);
  await assert.rejects(readdir(output), {code: 'ENOENT'});
});

test('existing files, nonempty directories and output symlinks are never overwritten', async () => {
  const input = join(temporary, 'protected input.json');
  await writeFile(input, inputBytes);
  const occupied = join(temporary, 'occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'keep.txt'), 'keep');
  assert.match(cli('--data', input, '--out', occupied).stderr, /not empty/);
  assert.deepEqual(await readdir(occupied), ['keep.txt']);
  assert.equal(await readFile(join(occupied, 'keep.txt'), 'utf8'), 'keep');
  assert.notEqual(cli('--data', input, '--out', input).status, 0);
  assert.deepEqual(await readFile(input), inputBytes);
  const outside = join(temporary, 'outside');
  const linked = join(temporary, 'linked');
  await mkdir(outside);
  await symlink(outside, linked);
  assert.match(cli('--data', input, '--out', linked).stderr, /symbolic link/);
  assert.deepEqual(await readdir(outside), []);
});
