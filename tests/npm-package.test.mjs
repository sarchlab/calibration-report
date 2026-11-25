import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {after, before, test} from 'node:test';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
let temporary, install, executable, packageRoot, packedFiles;
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
  // Exercise the actual prepack hook: installed consumers need no build tools.
  succeed(run('npm', ['pack', '--pack-destination', temporary], root));
  const privateData = join(root, 'dist/data.json');
  const sourceMap = join(root, 'dist/assets/private.js.map');
  const extraAsset = join(root, 'dist/assets/private.json');
  await writeFile(privateData, 'PRIVATE_CALIBRATION_DATA');
  await writeFile(sourceMap, 'PRIVATE_SOURCE_MAP');
  await writeFile(extraAsset, 'PRIVATE_EXTRA_ASSET');
  try {
    const result = succeed(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
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

test('published contents exclude local data, source maps and development files', async () => {
  assert.deepEqual(packedFiles.filter((name) => !name.startsWith('dist/assets/')), [
    'README.md', 'bin/calibration-report.js', 'data.schema.json', 'dist/index.html', 'package.json',
  ]);
  assert.equal(packedFiles.filter((name) => name.startsWith('dist/assets/')).length, 2);
  assert(packedFiles.every((name) => !name.endsWith('data.json') && !name.endsWith('.map')));
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.dependencies, undefined);
  assert.equal(installed.scripts.install, undefined);
  assert.equal(installed.scripts.postinstall, undefined);
  assert.deepEqual((await readdir(join(install, 'node_modules'))).filter((name) => !name.startsWith('.')), ['calibration-report']);
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
  for (const asset of ['index.html', ...references])
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
