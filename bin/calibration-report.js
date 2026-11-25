#!/usr/bin/env node
import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `Usage: calibration-report --data <data.json> --out <directory>

Generate a static calibration report using the bundled viewer.
The output directory must be new or empty. The input data is copied unchanged.

Options:
  --data <file>       Input calibration JSON file
  --out <directory>   Output directory containing index.html and data.json
  --help, -h          Show this help
  --version, -v       Show the package version
`;

async function main() {
  const {values} = parseArgs({
    options: {
      data: {type: 'string'},
      out: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
      version: {type: 'boolean', short: 'v'},
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.version) {
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    console.log(metadata.version);
    return;
  }
  if (!values.data || !values.out)
    throw new Error('Both --data and --out are required. Run calibration-report --help for usage.');

  const source = resolve(values.data);
  const output = resolve(values.out);
  const data = await readFile(source);
  try {
    JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('Input is not valid JSON: ' + source);
  }

  // Check the bundled viewer before creating or writing the destination.
  const viewer = join(packageRoot, 'dist');
  const assets = (await readdir(join(viewer, 'assets')))
    .filter((name) => /\.(js|css)$/.test(name));
  const files = [
    'index.html',
    'THIRD_PARTY_LICENSES.md',
    ...assets.map((name) => join('assets', name)),
  ];
  if (!assets.length) throw new Error('Bundled viewer assets are missing. Reinstall calibration-report.');
  for (const file of files) {
    if (!(await lstat(join(viewer, file))).isFile())
      throw new Error('Bundled viewer file is missing or invalid: ' + file);
  }

  let existing;
  try {
    existing = await lstat(output);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error('Output must be a directory, not a file or symbolic link: ' + output);
  if (existing && (await readdir(output)).length)
    throw new Error('Output directory is not empty. Choose a new or empty directory: ' + output);

  await mkdir(join(output, 'assets'), {recursive: true});
  // Exclusive copies also refuse files created after the empty-directory check.
  for (const file of files)
    await copyFile(join(viewer, file), join(output, file), constants.COPYFILE_EXCL);
  // Use the bytes we parsed, so a concurrently updated input cannot change them.
  await writeFile(join(output, 'data.json'), data, {flag: 'wx'});
  console.log('Created calibration report in ' + output);
  console.log('Serve this directory with a static HTTP server or publish it to your static host.');
}

main().catch((error) => {
  console.error('calibration-report: ' + error.message);
  process.exitCode = 1;
});
