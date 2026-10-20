import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { f16Step, analyseSummary, parseBuildLodComment, nextVersion } from '../build.mjs';
import { compareVersions, checkDeps } from '../check-deps.mjs';
import { tmpDir, writeGaussianPly, FAKE_BUILD_LOD } from './fixtures.mjs';

const PIPELINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = tmpDir();
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function runBuild(args, env = {}) {
  return spawnSync(process.execPath, [path.join(PIPELINE, 'build.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PIPELINE_OUTPUT_ROOT: path.join(dir, 'out'),
      PIPELINE_BUILD_LOG: path.join(dir, 'reports', 'build-log.jsonl'),
      ...env,
    },
  });
}

test('parseArgs: happy path, = syntax, passthrough', () => {
  const { opts, errors } = parseArgs(['a.ply', '--name', 'tower', '--version=v3', '--no-scan', '--', '--within-dist=0,0,0,40']);
  assert.deepEqual(errors, []);
  assert.equal(opts.input, 'a.ply');
  assert.equal(opts.name, 'tower');
  assert.equal(opts.version, 'v3');
  assert.equal(opts.scan, false);
  assert.deepEqual(opts.extra, ['--within-dist=0,0,0,40']);
});

test('parseArgs: errors', () => {
  assert.match(parseArgs([]).errors.join(), /Missing input/);
  assert.match(parseArgs(['a.ply']).errors.join(), /--name/);
  assert.match(parseArgs(['a.ply', '--name']).errors.join(), /needs a value/);
  assert.match(parseArgs(['a.ply', '--name', 'bad name!']).errors.join(), /Invalid --name/);
  assert.match(parseArgs(['a.ply', 'b.ply', '--name', 'x']).errors.join(), /one input/);
  assert.match(parseArgs(['a.ply', '--name', 'x', '--bogus']).errors.join(), /Unknown option/);
  assert.match(parseArgs(['a.ply', '--name', 'x', '--', '--max-sh=3']).errors.join(), /conflicts/);
  assert.match(parseArgs(['a.ply', '--name', 'x', '--', '--quick']).errors.join(), /conflicts/);
  assert.equal(parseArgs(['--help']).opts.help, true);
});

test('f16Step matches half-float spacing', () => {
  assert.equal(f16Step(1), 2 ** -10);
  assert.equal(f16Step(1000), 0.5);
  assert.equal(f16Step(-70), 2 ** -4);
});

test('analyseSummary warns on far centroid, SH > 1, .sog input', () => {
  const s = { ext: '.ply', shDegree: 3, bounds: { bboxMin: [990, 0, 0], bboxMax: [1010, 5, 5], centroid: [1000, 2, 2], nonFiniteSplats: 0 } };
  const w = analyseSummary(s, { recentreThreshold: 10 });
  assert.ok(w.some((x) => /Centroid is 1000/.test(x)));
  assert.ok(w.some((x) => /--max-sh=1 drops/.test(x)));
  const near = analyseSummary({ ext: '.sog', shDegree: 1, bounds: { bboxMin: [-1, -1, -1], bboxMax: [1, 1, 1], centroid: [0, 0, 0], nonFiniteSplats: 0 } });
  assert.equal(near.filter((x) => /Centroid/.test(x)).length, 0);
  assert.ok(near.some((x) => /\.sog/.test(x)));
});

test('parseBuildLodComment extracts the stats JSON', () => {
  const out = 'Read: num_splats: 4\nComment: {\n  "a": 1,\n  "nested": {"b": [1, 2]}\n}\nWrote x-0.radc (5 bytes)\n';
  assert.deepEqual(parseBuildLodComment(out), { a: 1, nested: { b: [1, 2] } });
  assert.equal(parseBuildLodComment('nothing'), null);
});

test('nextVersion', () => {
  const m = path.join(dir, 'versions');
  assert.equal(nextVersion(m), 'v1');
  fs.mkdirSync(path.join(m, 'v1'), { recursive: true });
  fs.mkdirSync(path.join(m, 'v7'));
  fs.mkdirSync(path.join(m, 'notes'));
  assert.equal(nextVersion(m), 'v8');
});

test('compareVersions', () => {
  assert.equal(compareVersions('1.82.0', '1.82.0'), 0);
  assert.equal(compareVersions('1.90.1', '1.82.0'), 1);
  assert.equal(compareVersions('1.75.0', '1.82.0'), -1);
});

test('checkDeps returns a structured report', () => {
  const items = checkDeps();
  for (const name of ['node', 'git', 'cargo', 'build-lod binary']) {
    assert.ok(items.find((i) => i.name === name), `missing check ${name}`);
  }
  for (const i of items.filter((x) => !x.ok && x.blocking)) assert.ok(i.fix.length > 0, `${i.name} has no fix text`);
});

test('CLI: missing input / bad extension exit 2', () => {
  let r = runBuild([path.join(dir, 'nope.ply'), '--name', 'x']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not found/);
  const bad = path.join(dir, 'model.obj');
  fs.writeFileSync(bad, 'x');
  r = runBuild([bad, '--name', 'x']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not accept/);
});

test('CLI: dry run prints header info, warning and command; writes nothing', () => {
  const f = path.join(dir, 'far.ply');
  writeGaussianPly(f, [[500, 0, 0], [502, 2, 2]]);
  const r = runBuild([f, '--name', 'far', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /splats:\s+2/);
  assert.match(r.stdout, /SH degree:\s+3/);
  assert.match(r.stdout, /centroid:\s+\(501\.000, 1\.000, 1\.000\)/);
  assert.match(r.stderr, /WARNING: Centroid is 501/);
  assert.match(r.stdout, /--quality --rad-chunked --max-sh=1/);
  assert.ok(!fs.existsSync(path.join(dir, 'out')));
});

test('CLI: end-to-end with stand-in build-lod (staging, outputs, report, jsonl)', () => {
  const fake = path.join(dir, 'fake-build-lod.mjs');
  fs.writeFileSync(fake, FAKE_BUILD_LOD);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  const f = path.join(src, 'Scan 01.ply');
  writeGaussianPly(f, [[1, 1, 1], [2, 2, 2]]);

  const r = runBuild([f, '--name', 'tower', '--build-lod', fake, '--', '--within-dist=0,0,0,40'], { FAKE_LINGER_MS: '3500' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = path.join(dir, 'out', 'tower', 'v1');
  const files = fs.readdirSync(out).sort();
  assert.deepEqual(files, ['build-lod.log', 'build-report.json', 'tower-lod-0.radc', 'tower-lod-1.radc', 'tower-lod.rad']);
  assert.deepEqual(fs.readdirSync(src), ['Scan 01.ply'], 'source dir untouched');

  const rep = JSON.parse(fs.readFileSync(path.join(out, 'build-report.json'), 'utf8'));
  assert.equal(rep.status, 'ok');
  assert.deepEqual(rep.buildLod.args, ['--quality', '--rad-chunked', '--max-sh=1', '--within-dist=0,0,0,40']);
  assert.equal(rep.buildLod.stats.final_splat_count, 7);
  assert.equal(rep.output.chunkCount, 2);
  assert.equal(rep.input.splatCount, 2);
  assert.ok(rep.timing.wallClockSeconds > 0);
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.ok(rep.memory.peakRssBytes > 40 * 2 ** 20, `peak memory sampled: ${rep.memory.peakRssBytes}`);
  }

  const log = fs.readFileSync(path.join(dir, 'reports', 'build-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).name, 'tower');

  // Same version again is refused; next run auto-increments.
  assert.equal(runBuild([f, '--name', 'tower', '--version', 'v1', '--build-lod', fake]).status, 2);
  assert.equal(runBuild([f, '--name', 'tower', '--build-lod', fake]).status, 0);
  assert.ok(fs.existsSync(path.join(dir, 'out', 'tower', 'v2', 'tower-lod.rad')));
});

test('CLI: build-lod decode failure (exit 0, no output) is reported as failed', () => {
  const fake = path.join(dir, 'fake-build-lod.mjs');
  fs.writeFileSync(fake, FAKE_BUILD_LOD);
  const f = path.join(dir, 'bad.ply');
  writeGaussianPly(f, [[1, 1, 1]]);
  const r = runBuild([f, '--name', 'bad', '--build-lod', fake], { FAKE_FAIL_DECODE: '1' });
  assert.equal(r.status, 1);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'bad', 'v1', 'build-report.json'), 'utf8'));
  assert.equal(rep.status, 'failed');
  assert.match(rep.error, /decode/);
  assert.ok(!fs.existsSync(path.join(dir, 'out', 'bad', 'v1', '_input')));
});
