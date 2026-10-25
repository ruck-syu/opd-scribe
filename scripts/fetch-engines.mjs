#!/usr/bin/env node
/**
 * Fetches the engines that OPD Scribe packages: whisper.cpp (speech) and llama.cpp (AI extraction).
 *
 *   node scripts/fetch-engines.mjs --platform win|mac --arch x64|arm64
 *
 * Writes resources/engines/<os>-<arch>/ where <os> is electron-builder's ${os} macro for the target
 * (win | mac, from Platform.buildConfigurationKey) and <arch> is its ${arch} macro (x64 | arm64).
 * electron-builder.yml copies that folder to `engines/` inside the installer.
 *
 *   whisper/whisper-cli(.exe)   plus the shared libraries it needs, flattened next to it
 *   llm/llama-completion(.exe)  plus its shared libraries (Windows: Vulkan build)
 *   llm-cpu/                    Windows only: CPU build for machines whose GPU driver lacks Vulkan
 *   engines.json                source URL, tag and sha256 of every archive used
 *
 * Archives are cached in .cache/engines (gitignored). Each one is checked against the sha256 pinned
 * below; a mismatch aborts the run. macOS whisper has no prebuilt CLI, so it is built from the pinned
 * whisper.cpp commit with a static library and Metal embedded. Windows packages also copy the Visual C++
 * runtime DLLs that whisper needs from the build machine's System32, so fetch Windows on Windows.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'engines');
const ENGINES_DIR = path.join(REPO_ROOT, 'resources', 'engines');

// whisper.cpp v1.9.5 is the same commit as release b5454, so Windows and macOS use one version.
const WHISPER_SRC = {
  repo: 'https://github.com/ggml-org/whisper.cpp',
  tag: 'v1.9.5',
  commit: 'd1be6fde11ac6e0407606b4e42fe72d34add8037',
};

// Cross-check: GitHub's asset digests for these exact files match the pins below.
const ARCHIVES = {
  'whisper-win-x64': {
    repo: 'ggml-org/whisper.cpp',
    tag: 'b5454',
    asset: 'whisper-bin-x64.zip',
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  },
  'llama-win-vulkan-x64': {
    repo: 'ggml-org/llama.cpp',
    tag: 'b11887',
    asset: 'llama-b11887-bin-win-vulkan-x64.zip',
    sha256: '21aacee44771431a4d13a66988e31a65207aefb9c74b9098b2100e597cbe6cc9',
  },
  'llama-win-cpu-x64': {
    repo: 'ggml-org/llama.cpp',
    tag: 'b11887',
    asset: 'llama-b11887-bin-win-cpu-x64.zip',
    sha256: 'cf6a48560e0c32baf875f0b84ac578b111e16115ccf2382836489b5e268809c4',
  },
  'llama-mac-arm64': {
    repo: 'ggml-org/llama.cpp',
    tag: 'b11887',
    asset: 'llama-b11887-bin-macos-arm64.tar.gz',
    sha256: '13d5a906ab066f57a937a24e345eb541cb423b249c2254ed83cb2a24bba3f502',
  },
  'llama-mac-x64': {
    repo: 'ggml-org/llama.cpp',
    tag: 'b11887',
    asset: 'llama-b11887-bin-macos-x64.tar.gz',
    sha256: '379b431a7652f22dd61c5fbf10866cd7d955e8a1ec3e70887548d14cc8dbdf0b',
  },
};

// Binaries built on macOS must run on the same minimum OS as the llama.cpp macOS builds (minos 13.3).
const MAC_MIN_OS = '13.3';

// Windows: the ggml backends are DLLs loaded at runtime, so they are not in any import table.
const WIN_BACKEND_DLL = /^(ggml-cpu-.+|ggml-vulkan)\.dll$/i;
// Visual C++ 2015-2022 runtime. Not in the archives, and a clean clinic PC may not have it, so it is
// copied from the Windows build host's System32 (the redistributable files may ship with the app).
const VC_RUNTIME_DLL = /^(vcruntime140(_1)?|msvcp140(_[a-z0-9]+)?|vcomp140)\.dll$/i;

const TARGETS = {
  'win-x64': {
    components: [
      { name: 'whisper', exe: 'whisper-cli.exe', from: 'whisper-win-x64' },
      { name: 'llm', exe: 'llama-completion.exe', from: 'llama-win-vulkan-x64' },
      { name: 'llm-cpu', exe: 'llama-completion.exe', from: 'llama-win-cpu-x64' },
    ],
  },
  'mac-arm64': {
    components: [
      { name: 'whisper', exe: 'whisper-cli', from: 'whisper-src' },
      { name: 'llm', exe: 'llama-completion', from: 'llama-mac-arm64' },
    ],
  },
  'mac-x64': {
    components: [
      { name: 'whisper', exe: 'whisper-cli', from: 'whisper-src' },
      { name: 'llm', exe: 'llama-completion', from: 'llama-mac-x64' },
    ],
  },
};

const log = (msg) => console.log(`[engines] ${msg}`);

function fail(msg) {
  console.error(`[engines] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const platform = get('--platform');
  const arch = get('--arch');
  if (!['win', 'mac'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    fail('usage: node scripts/fetch-engines.mjs --platform win|mac --arch x64|arm64');
  }
  const key = `${platform}-${arch}`;
  if (!TARGETS[key]) fail(`no engine set for ${key} (supported: ${Object.keys(TARGETS).join(', ')})`);
  return { key, platform, arch };
}

function run(cmd, args, { env, capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = capture ? `\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').slice(-60).join('\n')}` : '';
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited with ${r.status}${detail}`);
  }
  return capture ? r.stdout : '';
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function ensureArchive(key) {
  const a = ARCHIVES[key];
  const url = `https://github.com/${a.repo}/releases/download/${a.tag}/${a.asset}`;
  const dest = path.join(CACHE_DIR, 'downloads', a.asset);
  if (fs.existsSync(dest) && sha256File(dest) === a.sha256) {
    log(`cached   ${a.asset}`);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`download ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const got = sha256File(tmp);
  if (got !== a.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`sha256 mismatch for ${a.asset}\n  expected ${a.sha256}\n  got      ${got}`);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

function extract(archive, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:OPD_ARCHIVE -DestinationPath $env:OPD_DEST -Force'],
        { env: { OPD_ARCHIVE: archive, OPD_DEST: dest } },
      );
    } else {
      run('unzip', ['-q', archive, '-d', dest]);
    }
  } else {
    run('tar', ['-xzf', archive, '-C', dest]);
  }
}

function findFile(dir, name) {
  const want = process.platform === 'win32' ? name.toLowerCase() : name;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if ((process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) === want) return full;
    }
  }
  throw new Error(`${name} not found under ${dir}`);
}

// ---- dependency walking -------------------------------------------------------------------------

/** Names of the imported DLLs of a Windows PE file (import directory only). */
function peImports(file) {
  const buf = fs.readFileSync(file);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') throw new Error(`${file} is not a PE file`);
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const opt = peOff + 24;
  const magic = buf.readUInt16LE(opt);
  const dataDirs = opt + (magic === 0x20b ? 112 : 96); // PE32+ vs PE32
  const importRva = buf.readUInt32LE(dataDirs + 8); // data directory 1 = import table
  if (!importRva) return [];
  const sections = [];
  const secTable = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const rvaToOff = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`${file}: bad RVA 0x${rva.toString(16)}`);
    return rva - s.va + s.raw;
  };
  const names = [];
  for (let p = rvaToOff(importRva); ; p += 20) {
    const nameRva = buf.readUInt32LE(p + 12);
    if (!nameRva) break;
    let end = rvaToOff(nameRva);
    while (buf[end] !== 0) end++;
    names.push(buf.toString('latin1', rvaToOff(nameRva), end));
  }
  return names;
}

/** Names of the @rpath / @loader_path libraries a Mach-O file loads (system libraries are excluded). */
function machoLocalDeps(file) {
  const out = run('otool', ['-L', file], { capture: true });
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().match(/^(\S+) \(/)?.[1])
    .filter((d) => d && (d.startsWith('@rpath/') || d.startsWith('@loader_path/') || d.startsWith('@executable_path/')))
    .map((d) => path.posix.basename(d));
}

/**
 * Files needed to run `entry`: its dependencies, transitively, found in the same folder. Seeds are
 * extra files that are loaded at runtime rather than linked (Windows ggml backends).
 * Returns [{ name, src }] where src is the real file (symlinks resolved).
 */
function closure({ entry, depsOf, seedRe, norm, strict, extra }) {
  const dir = path.dirname(entry);
  const index = new Map();
  for (const name of fs.readdirSync(dir)) {
    const real = fs.realpathSync(path.join(dir, name));
    if (fs.statSync(real).isFile()) index.set(norm(name), { name, src: real });
  }
  const picked = new Map();
  const queue = [];
  const add = (item) => {
    const k = norm(item.name);
    if (picked.has(k)) return;
    picked.set(k, item);
    queue.push(item);
  };
  add({ name: path.basename(entry), src: fs.realpathSync(entry) });
  if (seedRe) for (const [k, item] of index) if (seedRe.test(k)) add(item);
  while (queue.length) {
    const cur = queue.shift();
    for (const dep of depsOf(cur.src)) {
      const k = norm(dep);
      if (picked.has(k)) continue;
      if (index.has(k)) {
        add(index.get(k));
        continue;
      }
      const external = extra?.(dep);
      if (external) {
        add({ name: dep, src: external, system: true });
        continue;
      }
      if (strict) throw new Error(`${cur.name} needs ${dep}, which is not in ${dir}`);
    }
  }
  return [...picked.values()];
}

/** Visual C++ runtime DLL from System32 (Windows hosts only; other hosts get a warning). */
let vcRuntimeWarned = false;
function systemRuntime(name) {
  if (!VC_RUNTIME_DLL.test(name)) return null;
  const sysDir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const p = path.join(sysDir, name);
  if (process.platform === 'win32') {
    if (!fs.existsSync(p)) {
      throw new Error(`${name} is needed by the engine but is missing from ${sysDir}; install the Visual C++ 2015-2022 redistributable (x64) on this machine`);
    }
    return fs.realpathSync(p);
  }
  if (!vcRuntimeWarned) {
    vcRuntimeWarned = true;
    log(`warning: Visual C++ runtime DLLs are copied only when fetching on Windows; this package will be incomplete`);
  }
  return null;
}

function hasRpath(file, value) {
  const lines = run('otool', ['-l', file], { capture: true }).split('\n');
  return lines.some((l, i) => l.includes('LC_RPATH') && (lines[i + 2] ?? '').trim().startsWith(`path ${value} `));
}

/** Makes the copied Mach-O files resolve each other from their own folder, then ad-hoc signs them. */
function fixMacho(dir, names) {
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith('.dylib')) run('install_name_tool', ['-id', `@rpath/${name}`, file]);
    if (!hasRpath(file, '@loader_path')) run('install_name_tool', ['-add_rpath', '@loader_path', file]);
  }
  for (const name of names) run('codesign', ['--force', '--sign', '-', path.join(dir, name)], { capture: true });
  // Every local dependency must now be one of the copied files; anything else is a broken install.
  for (const name of names) {
    const file = path.join(dir, name);
    const bad = run('otool', ['-L', file], { capture: true })
      .split('\n')
      .slice(1)
      .map((l) => l.trim().match(/^(\S+) \(/)?.[1])
      .filter((d) => d && !d.startsWith('/usr/lib/') && !d.startsWith('/System/'))
      .filter((d) => !(d.startsWith('@rpath/') || d.startsWith('@loader_path/')) || !fs.existsSync(path.join(dir, path.posix.basename(d))));
    if (bad.length) throw new Error(`${name} has unresolved dependencies: ${bad.join(', ')}`);
  }
}

// ---- whisper.cpp macOS source build -------------------------------------------------------------

function ensureWhisperSource() {
  const dir = path.join(CACHE_DIR, 'src', 'whisper.cpp');
  if (fs.existsSync(dir)) {
    try {
      const head = run('git', ['-C', dir, 'rev-parse', 'HEAD'], { capture: true }).trim();
      if (head === WHISPER_SRC.commit) return dir;
    } catch {
      // not a usable checkout: clone again below
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  log(`clone    ${WHISPER_SRC.repo} ${WHISPER_SRC.tag}`);
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_SRC.tag, WHISPER_SRC.repo, dir]);
  const head = run('git', ['-C', dir, 'rev-parse', 'HEAD'], { capture: true }).trim();
  if (head !== WHISPER_SRC.commit) throw new Error(`whisper.cpp ${WHISPER_SRC.tag} is ${head}, expected ${WHISPER_SRC.commit}`);
  return dir;
}

function buildWhisperMac(arch) {
  const src = ensureWhisperSource();
  const buildDir = path.join(src, `build-${arch}`);
  const flags = [
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    `-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MAC_MIN_OS}`,
    '-DGGML_NATIVE=OFF', // portable binary, not tuned to the build machine
    '-DGGML_OPENMP=OFF', // no Homebrew libomp dependency
    ...(arch === 'arm64' ? ['-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'] : ['-DGGML_METAL=OFF']),
  ];
  log(`build    whisper-cli (${arch}) from ${WHISPER_SRC.tag}`);
  run('cmake', ['-S', src, '-B', buildDir, ...flags], { capture: true });
  run('cmake', ['--build', buildDir, '-j', String(os.cpus().length), '--config', 'Release', '--target', 'whisper-cli'], { capture: true });
  return { file: path.join(buildDir, 'bin', 'whisper-cli'), flags };
}

// ---- smoke test ---------------------------------------------------------------------------------

function smokeTest(file, label) {
  const r = spawnSync(file, ['--help'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.error) throw new Error(`${label}: could not start: ${r.error.message}`);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (!(r.status === 0 || /usage/i.test(out))) {
    throw new Error(`${label}: --help exited ${r.status}\n${out.slice(0, 2000)}`);
  }
  const first = out.split('\n').find((l) => l.trim()) ?? '';
  log(`smoke    ${label} --help: exit ${r.status}, "${first.trim()}"`);
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  const { key, platform, arch } = parseArgs(process.argv.slice(2));
  const target = TARGETS[key];
  const outDir = path.join(ENGINES_DIR, key);
  const isWin = platform === 'win';
  log(`target   ${key} -> ${path.relative(REPO_ROOT, outDir)}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = { target: key, components: {} };

  for (const c of target.components) {
    const compDir = path.join(outDir, c.name);
    fs.mkdirSync(compDir, { recursive: true });

    let entry;
    let source;
    if (c.from === 'whisper-src') {
      const built = buildWhisperMac(arch);
      entry = built.file;
      source = { kind: 'source', repo: WHISPER_SRC.repo, tag: WHISPER_SRC.tag, commit: WHISPER_SRC.commit, cmakeFlags: built.flags };
    } else {
      const a = ARCHIVES[c.from];
      const archive = await ensureArchive(c.from);
      const extractDir = path.join(CACHE_DIR, 'extract', c.from);
      extract(archive, extractDir);
      entry = findFile(extractDir, c.exe);
      source = {
        kind: 'archive',
        url: `https://github.com/${a.repo}/releases/download/${a.tag}/${a.asset}`,
        tag: a.tag,
        asset: a.asset,
        sha256: a.sha256,
      };
    }

    let files;
    if (isWin) {
      files = closure({
        entry,
        depsOf: peImports,
        seedRe: WIN_BACKEND_DLL,
        norm: (n) => n.toLowerCase(),
        strict: false,
        extra: systemRuntime,
      });
    } else {
      files = closure({
        entry,
        depsOf: machoLocalDeps,
        seedRe: null,
        norm: (n) => n,
        strict: true,
      });
    }

    for (const f of files) {
      const dest = path.join(compDir, f.name);
      fs.copyFileSync(f.src, dest);
      fs.chmodSync(dest, 0o755);
    }
    const names = files.map((f) => f.name);
    if (!isWin) fixMacho(compDir, names);

    const exe = path.basename(entry);
    const systemFiles = files.filter((f) => f.system).map((f) => f.name);
    log(`copied   ${c.name}/: ${exe} + ${names.length - 1} libraries${systemFiles.length ? ` (${systemFiles.length} from System32)` : ''}`);
    manifest.components[c.name] = {
      exe,
      source,
      files: names.sort(),
      ...(systemFiles.length ? { copiedFromSystem32: systemFiles.sort() } : {}),
    };
  }

  fs.writeFileSync(path.join(outDir, 'engines.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Print sizes so the installer impact is visible in the log.
  let total = 0;
  for (const c of target.components) {
    const dir = path.join(outDir, c.name);
    let size = 0;
    for (const n of fs.readdirSync(dir)) size += fs.statSync(path.join(dir, n)).size;
    total += size;
    log(`size     ${c.name}/: ${(size / 1048576).toFixed(1)} MiB`);
  }
  log(`size     total: ${(total / 1048576).toFixed(1)} MiB`);

  // Smoke test only where the binaries can run on this machine.
  const host = process.platform === 'darwin' ? `mac-${process.arch}` : process.platform === 'win32' ? `win-${process.arch}` : null;
  if (host === key) {
    for (const c of target.components) {
      const exe = manifest.components[c.name].exe;
      smokeTest(path.join(outDir, c.name, exe), `${c.name}/${exe}`);
    }
  } else {
    log(`smoke    skipped: this machine is ${host ?? process.platform} and the target is ${key}`);
  }
  log('done');
}

main().catch((err) => fail(err.message));
