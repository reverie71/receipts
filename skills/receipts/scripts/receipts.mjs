#!/usr/bin/env node
// receipts: run an agent's checks, record what really happened, and print a
// receipt the agent can't write by hand. No dependencies, Node 18 or newer.
// With git it can also tell when the code changed after a check ran.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
const RECEIPT_WIDTH = 48;
const LABEL_WIDTH = 9;
const TAIL_BYTES = 64 * 1024;
const MAX_UNTRACKED = 1000;

const HELP = `receipts ${VERSION}: run your checks and print a receipt of what really happened.

Usage: node receipts.mjs <command>

  start "<task>"       start a receipt for a new task
  run "<command>"      run a check (tests, lint, build) and record the result
  unchecked "<text>"   record something you could not check
  print                print the receipt for the current task
  verify [<id>]        check a receipt against the log and the current code

The log lives in .receipts/ at the top of the repo. Git ignores it.
`;

// Paths that look like tests, snapshots or test data.
const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?|__snapshots__|testdata|fixtures)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go|rb|exs?)$|\.(test|spec)\.[cm]?[jt]sx?$|_spec\.rb$|(Tests?|Spec)\.(java|kt|cs|swift|scala)$|\.snap$/;

// Package manager and make noise that says a script failed, not why.
const WRAPPER_NOISE =
  /^(npm (ERR!|error|warn)|error Command failed with exit code|info Visit https:\/\/yarnpkg|ELIFECYCLE|make(\[\d+\])?: \*\*\*)/;

const NEXT = {
  FAILED: 'a check failed. Fix it and run it again, or say plainly that it fails.',
  'OUT OF DATE': 'the code changed after a check passed. Run the stale checks again, then print a new receipt.',
  'NO CHECKS': 'nothing was run through receipts. Run the project\'s checks with: run "<command>"',
};

// ---------------------------------------------------------------- commands

function start(args) {
  const task = oneLine(args.join(' '));
  if (!task) return usage('start needs a task, like: start "fix the login redirect"');
  const ws = workspace();
  const state = gitState(ws, true);
  append(ws, {
    v: 1,
    type: 'start',
    time: new Date().toISOString(),
    task,
    head: state?.head ?? null,
    untracked: state ? state.untracked.slice(0, MAX_UNTRACKED) : [],
  });
  note(`started a receipt for "${task}"`);
  return 0;
}

async function run(args) {
  const command = (args[0] === '--' ? args.slice(1) : args).join(' ').trim();
  if (!command) return usage('run needs a command, like: run "npm test"');
  const ws = workspace();
  const before = snapshot(ws);
  const started = new Date();
  const t0 = process.hrtime.bigint();
  const digest = createHash('sha256');
  const summary = new Summary();
  const tail = new Tail(TAIL_BYTES);
  let bytes = 0;

  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const take = (out) => {
    const lines = new Lines((line) => summary.line(line));
    return [
      (chunk) => {
        if (!out.destroyed) out.write(chunk);
        digest.update(chunk);
        bytes += chunk.length;
        tail.push(chunk);
        lines.push(chunk);
      },
      lines,
    ];
  };
  const [onOut, outLines] = take(process.stdout);
  const [onErr, errLines] = take(process.stderr);
  child.stdout.on('data', onOut);
  child.stderr.on('data', onErr);
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {}
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, forward);
  const { code, signal, error } = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  outLines.end();
  errLines.end();
  if (error) process.stderr.write(`receipts: could not start the command: ${error.message}\n`);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const exit = error ? 127 : code ?? 128 + (os.constants.signals[signal] || 0);

  const entry = {
    v: 1,
    type: 'run',
    cmd: command,
    dir: path.relative(ws.root, ws.cwd).split(path.sep).join('/'),
    start: started.toISOString(),
    ms,
    exit,
    signal: signal || null,
    before,
    after: snapshot(ws),
    out: { bytes, sha256: digest.digest('hex'), tail: tailLines(tail.text(), 20) },
    summary: clip(summary.result(exit), 160),
  };
  try {
    append(ws, entry);
  } catch (err) {
    note(`could not record this run: ${err.message}`);
    return exit;
  }
  const how = exit === 0 ? 'PASS' : `FAIL (${signal || `exit ${exit}`})`;
  note(`${how} recorded for: ${commandLine(command)} (${duration(ms)})`);
  return exit;
}

function unchecked(args) {
  const text = oneLine(args.join(' '));
  if (!text) return usage('unchecked needs a note, like: unchecked "Safari, no browser here"');
  const ws = workspace();
  append(ws, { v: 1, type: 'unchecked', time: new Date().toISOString(), text });
  note(`noted as not checked: ${text}`);
  return 0;
}

function print() {
  const ws = workspace();
  const body = buildReceipt(ws, scopeOf(readLog(ws)));
  const id = receiptId(body);
  append(ws, { v: 1, type: 'receipt', time: new Date().toISOString(), id, ...body });
  process.stdout.write(`${render(body, id)}\nCheck it: ${verifyCommand(ws, id)}\n`);
  if (NEXT[body.result]) note(NEXT[body.result]);
  return 0;
}

function verify(args) {
  const ws = workspace();
  const lines = readLog(ws);
  const want = (args[0] || '').trim().toLowerCase();
  const all = [];
  lines.forEach((line, at) => {
    if (line.entry?.type === 'receipt') all.push({ line, at });
  });
  const found = want ? all.filter(({ line }) => String(line.entry.id).startsWith(want)) : all.slice(-1);
  if (!found.length) {
    note(want ? `there is no receipt ${want} in ${ws.log}` : `there are no receipts in ${ws.log} yet`);
    return 1;
  }
  if (new Set(found.map(({ line }) => line.entry.id)).size > 1) {
    note(`${want} matches more than one receipt. Give more of the id.`);
    return 1;
  }
  const { line, at } = found[found.length - 1];
  const body = bodyOf(line.entry);
  const problems = [];

  const broken = lines.findIndex((l, i) => !l.entry || l.entry.prev !== (i ? lines[i - 1].hash : ''));
  if (broken >= 0) problems.push(`the log was edited or damaged at entry ${broken + 1} of ${lines.length}`);
  if (receiptId(body) !== line.entry.id) problems.push('the receipt was edited after it was printed');
  const earlier = new Map(lines.slice(0, at).map((l) => [l.hash, l.entry]));
  for (const c of body.checks || []) {
    const e = earlier.get(c.run);
    if (e?.type !== 'run' || e.cmd !== c.cmd || e.ms !== c.ms) {
      problems.push(`no recorded run matches "${commandLine(c.cmd)}"`);
      continue;
    }
    const status = statusOf(e, body.tree);
    if (status !== c.status) problems.push(`"${commandLine(c.cmd)}" says ${c.status}, but its run says ${status}`);
  }
  for (const n of body.notes || []) {
    const e = earlier.get(n.note);
    if (e?.type !== 'unchecked' || e.text !== n.text) problems.push(`no recorded note matches "${n.text}"`);
  }
  const [result] = resultOf(body.checks || []);
  if (result !== body.result) problems.push(`RESULT says ${body.result}, but the checks say ${result}`);

  const now = snapshot(ws);
  const same = body.tree && now ? body.tree === now : null;
  process.stdout.write(`${render(body, line.entry.id)}\n\n`);
  process.stdout.write(
    `${problems.length ? `NOT VERIFIED: ${problems.join('; ')}.` : 'VERIFIED: this receipt matches the recorded runs.'}\n` +
      `${
        same === null
          ? "Change tracking is off here, so receipts can't tell if the code changed since."
          : same
            ? 'The code has not changed since it was printed.'
            : 'The code HAS changed since it was printed, so it no longer describes the code.'
      }\n`,
  );
  return problems.length || same === false ? 1 : 0;
}

// ---------------------------------------------------------------- receipt

// Every field the receipt shows, in a fixed order, so its id can be rebuilt.
const BODY = ['task', 'repo', 'when', 'changes', 'tests', 'tree', 'checks', 'notes', 'result', 'detail'];
const bodyOf = (e) => Object.fromEntries(BODY.map((k) => [k, e[k] ?? null]));
export const receiptId = (body) => sha(JSON.stringify(bodyOf(body))).slice(0, 12);

// A task runs from its last start. Without one, from the last receipt.
function scopeOf(lines) {
  let from = -1;
  let start = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const type = lines[i].entry?.type;
    if (type === 'start') {
      from = i;
      start = lines[i];
      break;
    }
    if (type === 'receipt' && from < 0) from = i;
  }
  return { start, items: lines.slice(from + 1) };
}

export function statusOf(run, tree) {
  if (run.exit !== 0) return 'FAIL';
  if (!tree) return 'PASS'; // no change tracking
  return run.after === tree ? 'PASS' : 'STALE';
}

export function resultOf(checks) {
  const n = checks.length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const stale = checks.filter((c) => c.status === 'STALE').length;
  if (!n) return ['NO CHECKS', 'nothing was run through receipts'];
  if (failed) return ['FAILED', `${failed} of ${count(n, 'check')} failed`];
  if (stale) return ['OUT OF DATE', `${stale} of ${count(n, 'check')} ran before the last edit`];
  return ['ALL PASSED', `${n} of ${count(n, 'check')} passed on this code`];
}

function buildReceipt(ws, scope) {
  const startEntry = scope.start?.entry ?? null;
  const runs = scope.items.filter((l) => l.entry?.type === 'run');
  const notes = scope.items.filter((l) => l.entry?.type === 'unchecked');
  const state = gitState(ws, true);
  const tree = state?.fp ?? null;

  // One line per command (and folder). The last run counts.
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.entry.dir}\0${r.entry.cmd}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const checks = [...groups.values()].map((group) => {
    const last = group[group.length - 1];
    const e = last.entry;
    const status = statusOf(e, tree);
    const details = [];
    if (status === 'FAIL') {
      const how = e.signal ? `stopped by ${e.signal}` : `exit ${e.exit}`;
      details.push(e.summary ? `${how}: ${e.summary}` : how);
    } else if (e.summary) {
      details.push(e.summary);
    }
    if (status === 'STALE') details.push(e.after ? 'ran before the last code change' : 'the code could not be read when it ran');
    if (e.before && e.after && e.before !== e.after) details.push('it changed files while it ran');
    if (e.dir) details.push(`in ${e.dir}`);
    const failedBefore = group.slice(0, -1).filter((g) => g.entry.exit !== 0).length;
    if (failedBefore && status !== 'FAIL') details.push(`passed after ${count(failedBefore, 'failed run')}`);
    return { status, cmd: e.cmd, ms: e.ms, details, run: last.hash };
  });

  const began = startEntry?.time ?? runs[0]?.entry.start ?? notes[0]?.entry.time ?? null;
  const printed = new Date();
  const name = path.basename(ws.root);
  const repo = !ws.git
    ? `${name} (no git, so code changed after a check can't be seen)`
    : state
      ? `${name} (${state.branch})`
      : `${name} (git could not read the files, so change tracking is off)`;
  const changed = startEntry && state ? changes(ws, startEntry, state) : null;
  const [result, detail] = resultOf(checks);
  return bodyOf({
    task: startEntry?.task ?? null,
    repo,
    when: began ? span(new Date(began), printed) : stamp(printed),
    changes: changed?.summary ?? null,
    tests: changed?.tests ?? null,
    tree,
    checks,
    notes: notes.map((l) => ({ text: l.entry.text, note: l.hash })),
    result,
    detail,
  });
}

export function render(body, id) {
  const checks = body.checks || [];
  const notes = body.notes || [];
  const out = [];
  const rule = (c) => out.push(c.repeat(RECEIPT_WIDTH));
  // A label on the first line, then the value wrapped under it.
  const field = (key, value) => {
    wrap(value, RECEIPT_WIDTH - LABEL_WIDTH).forEach((s, i) => {
      out.push((i ? '' : key).padEnd(LABEL_WIDTH) + s);
    });
  };
  rule('=');
  out.push(' '.repeat((RECEIPT_WIDTH - 7) >> 1) + 'RECEIPT');
  rule('=');
  field('task', body.task ?? 'not recorded (no start)');
  field('repo', body.repo);
  field('when', body.when);
  if (body.changes) field('changes', body.changes);
  if (body.tests) field('tests', body.tests);
  rule('-');
  if (!checks.length) out.push('No checks were run.');
  for (const c of checks) {
    const time = duration(c.ms);
    wrap(commandLine(c.cmd), RECEIPT_WIDTH - 6, RECEIPT_WIDTH - 7 - time.length).forEach((s, i) =>
      out.push(i ? `      ${s}` : `${c.status.padEnd(6)}${s}`.padEnd(RECEIPT_WIDTH - time.length) + time),
    );
    for (const d of c.details) wrap(d, RECEIPT_WIDTH - 6).forEach((s) => out.push(`      ${s}`));
  }
  if (notes.length) {
    rule('-');
    out.push('NOT CHECKED');
    for (const n of notes) wrap(n.text, RECEIPT_WIDTH - 4).forEach((s, i) => out.push(`${i ? '    ' : '  - '}${s}`));
  }
  rule('-');
  field('RESULT', body.result);
  field('', body.detail);
  field('receipt', id);
  rule('=');
  return out.join('\n');
}

// The shortest way to run verify from the top of the repo.
function verifyCommand(ws, id) {
  const real = realpath(fileURLToPath(import.meta.url));
  const home = os.homedir();
  const inRepo = path.relative(ws.root, real);
  let script = real;
  if (/\s/.test(real)) script = `"${real}"`;
  else if (!inRepo.startsWith('..') && !path.isAbsolute(inRepo)) script = inRepo;
  else if (process.platform !== 'win32' && real.startsWith(home + path.sep)) script = `~${real.slice(home.length)}`;
  return `node ${script} verify ${id}`;
}

// ---------------------------------------------------------------- git

function git(args, cwd, input) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return { ok: r.status === 0, out: r.stdout || '' };
}

const isReceiptsPath = (p) => p === '.receipts' || p.startsWith('.receipts/') || p.includes('/.receipts/');

// A fingerprint of every file git would see (tracked or new, not ignored).
// It only reads: no index writes, no git objects. Staging or committing
// leaves it the same; editing, adding or deleting a file changes it.
function gitState(ws, full = false) {
  if (!ws.git) return null;
  const ls = git(['ls-files', '-s', '-z'], ws.root);
  const st = git(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], ws.root);
  if (!ls.ok || !st.ok) return null;
  const files = new Map();
  for (const rec of ls.out.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, blob, stage] = rec.slice(0, tab).split(' ');
    files.set(rec.slice(tab + 1), stage === '0' ? blob : 'unmerged');
  }
  const changed = [];
  const untracked = [];
  for (const rec of st.out.split('\0')) {
    if (rec.startsWith('? ')) {
      untracked.push(rec.slice(2));
      changed.push(rec.slice(2));
    } else if (rec.startsWith('1 ')) {
      const parts = rec.split(' ');
      const name = parts.slice(8).join(' ');
      if (parts[1][1] === 'D') files.delete(name);
      else if (parts[1][1] !== '.') changed.push(name);
    } else if (rec.startsWith('u ')) {
      changed.push(rec.split(' ').slice(10).join(' '));
    }
  }
  for (const [name, blob] of hashFiles(ws.root, changed)) {
    if (blob) files.set(name, blob);
    else files.delete(name);
  }
  const h = createHash('sha256');
  for (const name of [...files.keys()].sort()) if (!isReceiptsPath(name)) h.update(`${name}\0${files.get(name)}\n`);
  const state = { fp: h.digest('hex'), untracked: untracked.filter((p) => !isReceiptsPath(p)) };
  if (full) {
    const head = git(['rev-parse', '--verify', '-q', 'HEAD'], ws.root);
    const branch = git(['symbolic-ref', '-q', '--short', 'HEAD'], ws.root);
    state.head = head.ok ? head.out.trim() : null;
    state.branch = branch.ok ? branch.out.trim() : state.head ? `detached at ${state.head.slice(0, 7)}` : 'no commits';
  }
  return state;
}

const snapshot = (ws) => gitState(ws)?.fp ?? null;

// Git's ids for files on disk, with git's own filters (line endings and so on),
// so a file hashes the same before and after it is staged. Nothing is written.
function hashFiles(root, names) {
  const out = [];
  const batch = [];
  for (const name of names) {
    const file = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      out.push([name, null]);
      continue;
    }
    if (st.isSymbolicLink()) {
      const link = git(['hash-object', '--stdin'], root, fs.readlinkSync(file));
      out.push([name, link.ok ? link.out.trim() : `link:${sha(fs.readlinkSync(file))}`]);
    } else if (st.isDirectory()) out.push([name, 'dir']); // a nested repo
    else if (name.includes('\n')) out.push([name, `raw:${sha(fs.readFileSync(file))}`]);
    else batch.push(name);
  }
  if (batch.length) {
    const r = git(['hash-object', '--stdin-paths'], root, batch.join('\n') + '\n');
    const ids = r.ok ? r.out.trim().split('\n') : [];
    if (ids.length === batch.length) batch.forEach((name, i) => out.push([name, ids[i]]));
    else {
      for (const name of batch) {
        const one = git(['hash-object', '--', name], root);
        out.push([name, one.ok ? one.out.trim() : null]);
      }
    }
  }
  return out;
}

// What the task changed: the commit it started on against the files now,
// plus files that are new since the start.
function changes(ws, startEntry, state) {
  // A repo with no commits yet is compared with git's empty tree.
  const base = startEntry.head ?? git(['hash-object', '-t', 'tree', '--stdin'], ws.root, '').out.trim();
  if (!base) return null;
  const flags = ['--no-renames', '--no-ext-diff', '--no-textconv', '-z'];
  const num = git(['diff', '--numstat', ...flags, base, '--'], ws.root);
  const names = git(['diff', '--name-status', ...flags, base, '--'], ws.root);
  if (!num.ok || !names.ok) return null;
  let files = 0;
  let add = 0;
  let del = 0;
  for (const rec of num.out.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m || isReceiptsPath(m[3])) continue;
    files++;
    add += m[1] === '-' ? 0 : Number(m[1]);
    del += m[2] === '-' ? 0 : Number(m[2]);
  }
  const touched = [];
  const recs = names.out.split('\0');
  for (let i = 0; i + 1 < recs.length; i += 2) if (recs[i]) touched.push([recs[i][0], recs[i + 1]]);
  const already = new Set(startEntry.untracked || []);
  for (const p of state.untracked) {
    if (already.has(p)) continue;
    files++;
    add += lineCount(path.join(ws.root, p));
    touched.push(['A', p]);
  }
  const tests = touched.filter(([, p]) => TEST_FILE.test(p));
  const word = { A: 'added', D: 'deleted' };
  const shown = tests.slice(0, 3).map(([k, p]) => `${p} (${word[k] || 'edited'})`);
  if (tests.length > 3) shown.push(`${tests.length - 3} more`);
  let summary = 'no files changed';
  if (files) {
    summary = `${count(files, 'file')}, +${add} -${del}`;
    if (startEntry.head) summary += ` since ${startEntry.head.slice(0, 7)}`;
  }
  return { summary, tests: shown.length ? shown.join(', ') : null };
}

function lineCount(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 2 * 1024 * 1024 || buf.includes(0)) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- log

function workspace() {
  const cwd = realpath(process.cwd());
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  const isGit = top.ok && top.out.trim() !== '';
  const root = isGit ? realpath(top.out.trim()) : cwd;
  // The top of the repo, or this folder if the top can't be written (sandboxes).
  for (const base of root === cwd ? [root] : [root, cwd]) {
    const dir = path.join(base, '.receipts');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Made by receipts. Keeps this folder out of git.\n*\n');
      return { root, cwd, dir, git: isGit, log: path.join(dir, 'log.jsonl') };
    } catch (err) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw err;
    }
  }
  throw new Error(`can't write a .receipts folder in ${root}`);
}

function realpath(p) {
  // native also expands Windows short names like RUNNER~1, which git never prints.
  for (const resolve of [fs.realpathSync.native, fs.realpathSync]) {
    try {
      return resolve(p);
    } catch {}
  }
  return path.resolve(p);
}

function readLog(ws) {
  let text;
  try {
    text = fs.readFileSync(ws.log, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((raw) => raw.trim())
    .map((raw) => {
      let entry = null;
      try {
        entry = JSON.parse(raw);
      } catch {}
      return { raw, hash: sha(raw), entry };
    });
}

// Each entry carries the hash of the one before it, so edits show up.
function append(ws, entry) {
  return locked(ws, () => {
    const raw = JSON.stringify({ ...entry, prev: lastHash(ws.log) });
    fs.appendFileSync(ws.log, `${raw}\n`);
    return sha(raw);
  });
}

function lastHash(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    for (let len = Math.min(size, 65536); ; len = Math.min(size, len * 4)) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      const last = (len === size ? lines : lines.slice(1)).filter((l) => l.trim()).pop();
      if (last !== undefined) return sha(last);
      if (len === size) return '';
    }
  } finally {
    fs.closeSync(fd);
  }
}

function locked(ws, fn) {
  const lock = path.join(ws.dir, 'lock');
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`the log is locked. If no other receipts command is running, delete ${lock}`);
      // Sleep 25 ms. Everything here is synchronous, so there's no await.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- output

// Reads test runner summaries as the output streams past, in any amount.
export class Summary {
  constructor() {
    this.cargo = null;
    this.go = { ok: 0, fail: 0, tests: 0 };
    this.tap = {};
    this.bun = {};
    this.mocha = {};
    this.unittest = null;
    this.known = '';
    this.generic = '';
    this.last = '';
  }

  line(text) {
    const line = text.trim();
    if (!line) return;
    if (!WRAPPER_NOISE.test(line)) this.last = line;
    let m;
    if ((m = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line))) {
      this.cargo ??= [0, 0, 0];
      for (let i = 0; i < 3; i++) this.cargo[i] += Number(m[i + 1]);
    } else if (/^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)/.test(line)) this.go.ok++;
    else if (/^FAIL\s+\S+\s+(?:[\d.]+s|\[[^\]]+\])/.test(line)) this.go.fail++;
    else if (/^--- FAIL: /.test(line)) this.go.tests++;
    else if ((m = /^(?:#|ℹ)\s*(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)$/.exec(line))) this.tap[m[1]] = Number(m[2]);
    else if ((m = /^(\d+) (pass|fail|skip|todo)$/.exec(line))) this.bun[m[2]] = Number(m[1]);
    else if ((m = /^(\d+) (passing|failing|pending)(?: \([^)]*\))?$/.exec(line))) this.mocha[m[2]] = Number(m[1]);
    else if ((m = /^Ran (\d+) tests? in \S+$/.exec(line))) this.unittest = { ran: Number(m[1]), end: '' };
    else if (this.unittest && /^(?:OK|FAILED)(?: \(.*\))?$/.test(line)) this.unittest.end = line;
    else if ((m = /^Tests:\s+(.*\d.*)$/.exec(line))) this.known = m[1]; // jest
    else if ((m = /^Tests\s+(\d.*)$/.exec(line))) this.known = m[1].replace(/\s+\|\s+/g, ', '); // vitest
    else if ((m = /^=+ (.*\d.*?) in [\d.]+s(?: \([^)]*\))? =+$/.exec(line))) this.known = m[1]; // pytest
    else if ((m = /^(\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected)(?:, \d+ \w+)*) in [\d.]+s/.exec(line)))
      this.known = m[1]; // pytest -q
    else if ((m = /^(?:ok|FAILED) \| (\d+) passed(?: \(\d+ steps?\))? \| (\d+) failed/.exec(line)))
      this.known = `${m[1]} passed, ${m[2]} failed`; // deno
    else if ((m = /^(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+)/.exec(line)))
      this.known = counts([[m[2], 'passed'], [m[1], 'failed'], [m[3], 'skipped', true]]); // dotnet
    else if ((m = /^(?:\[\w+\]\s+)?Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)$/.exec(line)))
      this.known = `${m[1]} run, ${count(Number(m[2]), 'failure')}, ${count(Number(m[3]), 'error')}`; // maven
    else if (line.length <= 100 && /\b\d+ (?:passed|passing|failed|failing|failures?|errors?|tests?|examples?|problems?|specs?)\b/i.test(line))
      this.generic = line;
  }

  result(exit) {
    const { cargo, go, tap, bun, mocha, unittest } = this;
    if (cargo) return counts([[cargo[0], 'passed'], [cargo[1], 'failed'], [cargo[2], 'ignored', true]]);
    if (go.ok || go.fail) {
      const tests = go.tests ? ` (${count(go.tests, 'test')})` : '';
      return `${count(go.ok, 'package')} ok, ${go.fail} failed${tests}`;
    }
    if ('pass' in tap && 'fail' in tap) {
      return counts([
        [tap.pass, 'passed'],
        [tap.fail, 'failed'],
        [tap.skipped, 'skipped', true],
        [tap.todo, 'todo', true],
        [tap.cancelled, 'cancelled', true],
      ]);
    }
    if ('pass' in bun || 'fail' in bun) {
      return counts([
        [bun.pass ?? 0, 'passed'],
        [bun.fail ?? 0, 'failed'],
        [bun.skip, 'skipped', true],
        [bun.todo, 'todo', true],
      ]);
    }
    if ('passing' in mocha || 'failing' in mocha) {
      return counts([
        [mocha.passing ?? 0, 'passed'],
        [mocha.failing ?? 0, 'failed'],
        [mocha.pending, 'pending', true],
      ]);
    }
    if (unittest?.end) return `${count(unittest.ran, 'test')}, ${unittest.end}`;
    return this.known || this.generic || (exit === 0 ? '' : this.last);
  }
}

export function summarize(text, exit) {
  const s = new Summary();
  for (const line of text.split('\n')) s.line(cleanLine(line));
  return s.result(exit);
}

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function cleanLine(s) {
  s = s.replace(ANSI, '');
  if (s.endsWith('\r')) s = s.slice(0, -1);
  const cr = s.lastIndexOf('\r'); // progress bars redraw with \r
  if (cr >= 0) s = s.slice(cr + 1);
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
}

// Splits one output stream into lines as it arrives.
class Lines {
  constructor(onLine) {
    this.onLine = onLine;
    this.rest = '';
    this.decoder = new TextDecoder();
  }

  push(chunk) {
    const parts = (this.rest + this.decoder.decode(chunk, { stream: true })).split('\n');
    this.rest = parts.pop().slice(-TAIL_BYTES);
    for (const p of parts) this.onLine(cleanLine(p));
  }

  end() {
    const last = this.rest + this.decoder.decode();
    if (last) this.onLine(cleanLine(last));
    this.rest = '';
  }
}

// Keeps the last few kilobytes of output.
class Tail {
  constructor(max) {
    this.max = max;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.max) this.size -= this.chunks.shift().length;
  }

  text() {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.max)).toString('utf8');
  }
}

function tailLines(text, n) {
  return text
    .split('\n')
    .map(cleanLine)
    .filter(Boolean)
    .slice(-n)
    .map((l) => clip(l, 300));
}

// ---------------------------------------------------------------- text

export function wrap(text, width, first = width) {
  const lines = [];
  let line = '';
  let max = first;
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length <= max) {
      line += ` ${word}`;
      continue;
    }
    if (line) {
      lines.push(line);
      max = width;
    }
    while (word.length > max) {
      lines.push(word.slice(0, max));
      word = word.slice(max);
      max = width;
    }
    line = word;
  }
  lines.push(line);
  return lines;
}

export function duration(ms) {
  if (ms < 50) return '<0.1s';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function span(a, b) {
  const from = stamp(a);
  const to = stamp(b);
  const m = Math.round((b - a) / 60000);
  const length = m < 1 ? 'under 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${from} to ${from.slice(0, 10) === to.slice(0, 10) ? to.slice(11) : to} (${length})`;
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const counts = (parts) =>
  parts
    .filter(([n, , optional]) => n !== undefined && !(optional && !Number(n)))
    .map(([n, word]) => `${Number(n)} ${word}`)
    .join(', ');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const commandLine = (s) => String(s).replace(/\s*\r?\n\s*/g, ' ; ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const note = (message) => process.stderr.write(`receipts: ${message}\n`);

function usage(message) {
  process.stderr.write(`receipts: ${message}\n\n${HELP}`);
  return 2;
}

// ---------------------------------------------------------------- main

async function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'start':
      return start(args);
    case 'run':
      return run(args);
    case 'unchecked':
      return unchecked(args);
    case 'print':
      return print();
    case 'verify':
      return verify(args);
    case '--version':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      return usage(`unknown command "${command}"`);
  }
}

// Run only as a script (a skill folder may be a symlink), not when imported.
function isMain() {
  if (!process.argv[1]) return false;
  const a = realpath(process.argv[1]);
  const b = realpath(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
  // A reader like `| head` may close the pipe early. Keep running and recording.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (err) => {
      process.stderr.write(`receipts: ${err.message}\n`);
      process.exitCode = 2;
    },
  );
}
