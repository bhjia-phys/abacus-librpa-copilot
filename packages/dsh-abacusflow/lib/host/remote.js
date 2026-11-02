/**
 * Remote ABACUS/LibRPA runs over SSH, without a filesystem mount.
 *
 * ## Why not a mount
 *
 * Measured on this machine against the dongfang login node: one SSH command costs
 * **~11.5 s** even for `true`, and that cost is connection setup, not the command. A
 * directory mount (`sshfs`) turns every `readdir` and every `stat` into its own round
 * trip, so listing one real `OUT.*` directory with 1473 files would issue thousands of
 * them. The panel would feel frozen and the network traffic would dwarf the data.
 *
 * ## What this module does instead
 *
 * One connection per user action, doing as much as possible server-side:
 *
 *   - `manifest()`  — one `find` returns every task directory and its marker files;
 *   - `pull()`      — one `tar` of just the plot-relevant files, streamed back;
 *
 * The result is written into the local topics tree, so the panel then reads it exactly
 * like a local run: 130-400 ms per operation instead of tens of seconds.
 *
 * ## What it deliberately does not do
 *
 * It does not pretend the remote tree is browsable. You pull a run, then look at it. A
 * stale local copy is possible; `pulledAt` records when it was taken so the panel can say
 * so rather than implying it is live.
 *
 * @module abacusflow/host/remote
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Longest we will wait for the remote listing; connection setup alone is ~12 s. */
const MANIFEST_TIMEOUT_MS = 180_000;
/** Packing + transfer for a plot subset of a big run. */
const PULL_TIMEOUT_MS = 900_000;

/**
 * Run one command over SSH and resolve with stdout.
 *
 * `BatchMode=yes` so a missing key fails fast instead of hanging on a password prompt.
 *
 * @param {string} host SSH alias from ~/.ssh/config
 * @param {string} command remote shell command
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok:boolean, stdout:string, stderr:string, error:string }>}
 */
export function sshExec(host, command, timeoutMs = MANIFEST_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    execFile(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=25',
        '-o', 'StrictHostKeyChecking=accept-new',
        host,
        command,
      ],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: String(error.message || error),
          });
          return;
        }
        resolvePromise({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '', error: '' });
      },
    );
  });
}

/** Quote a path for safe interpolation into a remote shell command. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse the manifest emitted by `remote-task-manifest.sh`.
 *
 * Lines are tab separated:
 *   `#RUN <abs>`               header
 *   `TASK <rel> <markers> <outdirs>`
 *
 * @param {string} text
 * @returns {{ run:string|null, tasks: Array<{ relPath:string, markers:string[], outputDirs:string[] }> }}
 */
export function parseManifest(text) {
  let run = null;
  const tasks = [];
  for (const raw of String(text ?? '').split(/\r\n|\n|\r/)) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts[0] === '#RUN') {
      run = parts[1] ?? null;
      continue;
    }
    if (parts[0] !== 'TASK') continue;
    const relPath = parts[1] ?? '.';
    const markers = (parts[2] ?? '').split(/\s+/).filter(Boolean);
    const outputDirs = (parts[3] ?? '').split(',').filter(Boolean);
    tasks.push({ relPath, markers, outputDirs });
  }
  return { run, tasks };
}

/**
 * Classify a remote directory the same way the local scanner would.
 *
 * Kept in step with `scanner.js`: ABACUS needs INPUT (+STRU for a usable task), LibRPA
 * needs `librpa.in`. A directory with only `INPUT` is reported as incomplete rather than
 * silently dropped, because that is exactly what an aborted run looks like.
 *
 * @param {{ markers:string[] }} task
 * @returns {'abacus'|'librpa'|'coupled'|null}
 */
export function classifyRemoteTask(task) {
  const has = (name) => task.markers.includes(name);
  const abacus = has('INPUT');
  const librpa = has('librpa.in');
  if (abacus && librpa) return 'coupled';
  if (abacus) return 'abacus';
  if (librpa) return 'librpa';
  return null;
}

/**
 * List the tasks of a remote run in one connection.
 *
 * @param {string} host
 * @param {string} remoteRun absolute path on the remote host
 * @returns {Promise<{ run:string|null, tasks:Array, elapsedMs:number, error:string }>}
 */
export async function listRemoteTasks(host, remoteRun) {
  const started = Date.now();
  const script = REMOTE_MANIFEST_SCRIPT;
  // base64 keeps the script intact regardless of quoting or CRLF in transit.
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const command =
    `printf %s ${shellQuote(encoded)} | base64 -d > /tmp/af-manifest.sh && ` +
    `bash /tmp/af-manifest.sh ${shellQuote(remoteRun)}`;
  const result = await sshExec(host, command);
  if (!result.ok) {
    return { run: null, tasks: [], elapsedMs: Date.now() - started, error: result.error };
  }
  const parsed = parseManifest(result.stdout);
  const tasks = parsed.tasks
    .map((task) => ({ ...task, kind: classifyRemoteTask(task) }))
    .filter((task) => task.kind !== null);
  return {
    run: parsed.run ?? remoteRun,
    tasks,
    elapsedMs: Date.now() - started,
    error: '',
  };
}

/**
 * Pull the plot-relevant files of one remote run into a local directory.
 *
 * @param {{ host:string, remoteRun:string, localRoot:string, withEigenvalues?:boolean,
 *           onProgress?:(message:string)=>void }} options
 * @returns {Promise<{ ok:boolean, localPath:string|null, error:string, message:string }>}
 */
export async function pullRemoteRun(options) {
  const { host, remoteRun, localRoot } = options;
  const name = remoteRun.replace(/\/+$/, '').split('/').pop();
  const target = resolve(localRoot, name);
  if (!existsSync(localRoot)) mkdirSync(localRoot, { recursive: true });

  const extra = options.withEigenvalues ? ' --with-eigenvalues' : '';
  const archive = `${name}-plot.tar.gz`;
  const command =
    `python3 ~/pack-plot-anyrun.py ${shellQuote(remoteRun)} ${shellQuote('~/' + archive)}${extra} ` +
    `&& ls -la ~/${shellQuote(archive)}`;

  options.onProgress?.('正在远端打包（只取绘图需要的文件）…');
  const packed = await sshExec(host, command, PULL_TIMEOUT_MS);
  if (!packed.ok) {
    return { ok: false, localPath: null, error: packed.error, message: '远端打包失败' };
  }

  options.onProgress?.('正在下载…');
  const scpResult = await new Promise((resolvePromise) => {
    execFile(
      'scp',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', `${host}:${archive}`, resolve(localRoot, archive)],
      { timeout: PULL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolvePromise({ ok: !error, error: error ? String(error.message) : '', stderr: stderr ?? '' }),
    );
  });
  if (!scpResult.ok) {
    return { ok: false, localPath: null, error: scpResult.error, message: '下载失败' };
  }

  return {
    ok: true,
    localPath: target,
    error: '',
    message: `已下载到 ${target}`,
  };
}

/** The manifest script, kept here so the host does not depend on a checkout path. */
const REMOTE_MANIFEST_SCRIPT = `set -u
RUN="\${1:?}"
printf '#RUN\\t%s\\n' "$RUN"
find "$RUN" -maxdepth 6 -type d \\
  \\( -name '.git' -o -name '__pycache__' -o -name 'build' -o -name 'source' \\
     -o -name 'CMakeFiles' -o -name 'thirdparty' \\) -prune \\
  -o -type d -print 2>/dev/null | while IFS= read -r d; do
    rel="\${d#$RUN/}"
    [ "$rel" = "$d" ] && rel="."
    markers=""
    for f in INPUT STRU KPT librpa.in; do
      [ -e "$d/$f" ] && markers="$markers $f"
    done
    [ -z "$markers" ] && continue
    outdirs=$(cd "$d" 2>/dev/null && ls -d OUT.* 2>/dev/null | tr '\\n' ',' | sed 's/,$//')
    printf 'TASK\\t%s\\t%s\\t%s\\n' "$rel" "\${markers# }" "\${outdirs:-}"
  done
`;
