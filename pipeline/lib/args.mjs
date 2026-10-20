// Command-line parsing for build.mjs (kept separate so it can be unit tested).

export const USAGE = `Usage:
  node build.mjs <input.ply|.sog|.spz|.splat|.ksplat|.zip> --name <model> [options] [-- <extra build-lod flags>]

Options:
  --name <model>             Output name (letters, digits, . _ -). Required.
  --version <vN>             Output version folder (default: next free v1, v2, ...).
  --build-lod <path>         build-lod executable (default: $SPARK_BUILD_LOD or pipeline/tools/spark/... from npm run setup).
  --no-scan                  Read the .ply header only; skip the streaming bounds/centroid pass.
  --recentre-threshold <d>   Warn when the centroid is farther than <d> scene units from the origin (default 10).
  --cleanup                  Run the cleanup/recentre hook (Phase 2 stub: currently a no-op).
  --dry-run                  Inspect input and print the build-lod command without running it or writing files.
  -h, --help                 Show this help.

Always passed to build-lod: --quality --rad-chunked --max-sh=1
Anything after "--" is appended to the build-lod command (e.g. -- --within-dist=0,0,0,50).

Output: assets/rad_output/<model>/<version>/<model>-lod.rad + <model>-lod-<N>.radc
        plus build-report.json and build-lod.log; one line is appended to reports/build-log.jsonl.`;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// build-lod flags the pipeline controls itself; overriding them after `--`
// would silently change the output format the viewer expects.
const RESERVED_EXTRA = [/^--rad$/, /^--rad-chunked$/, /^--spz(-chunked)?$/, /^--unlod$/, /^--quick$/, /^--tiny-lod/, /^--max-sh=/];

export function parseArgs(argv) {
  const opts = {
    input: null, name: null, version: null, buildLod: null,
    scan: true, recentreThreshold: 10, cleanup: false, dryRun: false, help: false,
    extra: [],
  };
  const errors = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) return a.slice(eq + 1);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { errors.push(`${a} needs a value`); return null; }
      i++;
      return v;
    };
    const flag = a.startsWith('--') ? a.split('=')[0] : a;
    if (a === '--') { opts.extra = argv.slice(i + 1); break; }
    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '--name': opts.name = takeValue(); break;
      case '--version': opts.version = takeValue(); break;
      case '--build-lod': opts.buildLod = takeValue(); break;
      case '--no-scan': opts.scan = false; break;
      case '--cleanup': opts.cleanup = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--recentre-threshold': case '--recenter-threshold': {
        const v = Number(takeValue());
        if (!Number.isFinite(v) || v < 0) errors.push('--recentre-threshold must be a non-negative number');
        else opts.recentreThreshold = v;
        break;
      }
      default:
        if (a.startsWith('-')) errors.push(`Unknown option: ${a}`);
        else positional.push(a);
    }
  }
  if (opts.help) return { opts, errors: [] };
  if (positional.length === 0) errors.push('Missing input file');
  if (positional.length > 1) errors.push(`Expected one input file, got ${positional.length}: ${positional.join(', ')}`);
  opts.input = positional[0] ?? null;
  if (!opts.name) errors.push('Missing --name <model>');
  else if (!NAME_RE.test(opts.name)) errors.push(`Invalid --name "${opts.name}" (use letters, digits, . _ -)`);
  if (opts.version !== null && opts.version !== undefined && !NAME_RE.test(opts.version)) {
    errors.push(`Invalid --version "${opts.version}"`);
  }
  for (const e of opts.extra) {
    if (RESERVED_EXTRA.some((re) => re.test(e))) errors.push(`Extra build-lod flag ${e} conflicts with the fixed scope flags`);
  }
  return { opts, errors };
}

export const BUILD_LOD_INPUT_EXTS = ['.ply', '.sog', '.spz', '.splat', '.ksplat', '.zip'];
