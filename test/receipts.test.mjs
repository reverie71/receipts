import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../skills/receipts/scripts/receipts.mjs', import.meta.url));
const NODE = `"${process.execPath}"`;
const ok = `${NODE} -e "console.log('fine')"`;
const exitWith = (code) => `${NODE} -e "process.exit(${code})"`;
const writes = (file) => `${NODE} -e "require('fs').writeFileSync('${file}', String(Date.now()))"`;

function folder() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-test-')));
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function repo() {
  const dir = folder();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.com');
  write(dir, 'app.js', 'module.exports = 1;\n');
  write(dir, 'test/app.test.js', 'test one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function cli(cwd, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function receipt(cwd) {
  const r = cli(cwd, 'print');
  assert.equal(r.status, 0, r.stderr);
  return { text: r.stdout, id: /^receipt\s+([0-9a-f]{12})$/m.exec(r.stdout)[1] };
}

const lineOf = (text, start) => text.split('\n').find((l) => l.startsWith(start));

test('run passes output and the exit code through', () => {
  const dir = repo();
  const good = cli(dir, 'run', ok);
  assert.equal(good.status, 0);
  assert.match(good.stdout, /fine/);
  assert.match(good.stderr, /PASS recorded/);
  const bad = cli(dir, 'run', exitWith(3));
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /FAIL \(exit 3\) recorded/);
});

test('run takes a command split into words after --', () => {
  const dir = repo();
  const r = cli(dir, 'run', '--', NODE, '-e', '"process.exit(4)"');
  assert.equal(r.status, 4);
});

test('checks that passed on the current code: ALL PASSED', () => {
  const dir = repo();
  cli(dir, 'start', 'add a feature');
  write(dir, 'app.js', 'module.exports = 2;\n');
  cli(dir, 'run', ok);
  const { text } = receipt(dir);
  assert.match(text, /^task {5}add a feature$/m);
  assert.match(text, /^PASS {2}/m);
  assert.match(text, /^RESULT {3}ALL PASSED$/m);
  assert.match(text, /1 of 1 check passed on this code/);
  assert.match(text, /^changes {2}1 file, \+1 -1 since [0-9a-f]{7}$/m);
  assert.match(text, /^Check it: node .*receipts\.mjs verify [0-9a-f]{12}$/m);
});

test('an edit after a check makes it STALE and the receipt OUT OF DATE', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  write(dir, 'app.js', 'module.exports = 3;\n');
  const { text } = receipt(dir);
  assert.match(text, /^STALE /m);
  assert.match(text, /ran before the last code change/);
  assert.match(text, /^RESULT {3}OUT OF DATE$/m);
});

test('staging and committing after a check do not make it stale', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  write(dir, 'app.js', 'module.exports = 4;\n');
  write(dir, 'new.js', 'new\n');
  cli(dir, 'run', ok);
  git(dir, 'add', '-A');
  assert.match(receipt(dir).text, /^RESULT {3}ALL PASSED$/m);
  git(dir, 'commit', '-q', '-m', 'second');
  assert.match(receipt(dir).text, /^RESULT {3}ALL PASSED$/m);
});

test('deleting, adding or renaming a file after a check makes it stale', () => {
  for (const change of [
    (dir) => fs.rmSync(path.join(dir, 'app.js')),
    (dir) => write(dir, 'extra.js', 'x\n'),
    (dir) => fs.renameSync(path.join(dir, 'app.js'), path.join(dir, 'main.js')),
  ]) {
    const dir = repo();
    cli(dir, 'start', 'task');
    cli(dir, 'run', ok);
    change(dir);
    assert.match(receipt(dir).text, /^RESULT {3}OUT OF DATE$/m);
  }
});

test('ignored files do not count as code changes', () => {
  const dir = repo();
  write(dir, '.gitignore', 'build/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'ignore');
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  write(dir, 'build/out.js', 'built\n');
  assert.match(receipt(dir).text, /^RESULT {3}ALL PASSED$/m);
});

test('the last run of a command counts, and earlier failures are shown', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  write(dir, 'flag', '1');
  const flaky = `${NODE} -e "process.exit(require('fs').existsSync('flag') ? 1 : 0)"`;
  cli(dir, 'run', flaky);
  fs.rmSync(path.join(dir, 'flag'));
  cli(dir, 'run', flaky);
  const { text } = receipt(dir);
  assert.equal(text.match(/^(PASS|FAIL|STALE) /gm).length, 1);
  assert.match(text, /passed after 1 failed run/);
  assert.match(text, /^RESULT {3}ALL PASSED$/m);
});

test('one failure makes the receipt FAILED', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  cli(dir, 'run', exitWith(2));
  const { text } = receipt(dir);
  assert.match(text, /^FAIL {2}/m);
  assert.match(text, /^ {6}exit 2$/m);
  assert.match(text, /^RESULT {3}FAILED$/m);
  assert.match(text, /1 of 2 checks failed/);
});

test('a receipt covers runs since the last start', () => {
  const dir = repo();
  cli(dir, 'start', 'first task');
  cli(dir, 'run', exitWith(1));
  cli(dir, 'start', 'second task');
  cli(dir, 'run', ok);
  const { text } = receipt(dir);
  assert.match(text, /^task {5}second task$/m);
  assert.doesNotMatch(text, /^FAIL /m);
});

test('without a start, a receipt covers runs since the last receipt', () => {
  const dir = repo();
  cli(dir, 'run', exitWith(1));
  receipt(dir);
  cli(dir, 'run', ok);
  const { text } = receipt(dir);
  assert.match(text, /^task {5}not recorded \(no start\)$/m);
  assert.doesNotMatch(text, /^FAIL /m);
  assert.match(text, /^RESULT {3}ALL PASSED$/m);
});

test('no checks: NO CHECKS', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  const { text } = receipt(dir);
  assert.match(text, /No checks were run\./);
  assert.match(text, /^RESULT {3}NO CHECKS$/m);
});

test('notes go under NOT CHECKED', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'unchecked', 'Safari, no browser here');
  const { text } = receipt(dir);
  assert.match(text, /^NOT CHECKED\n {2}- Safari, no browser here$/m);
});

test('changed test files are listed', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  fs.rmSync(path.join(dir, 'test/app.test.js'));
  write(dir, 'src/util.spec.ts', 'spec\n');
  const { text } = receipt(dir);
  assert.match(text, /test\/app\.test\.js \(deleted\)/);
  assert.match(text, /src\/util\.spec\.ts \(added\)/);
});

test('a command that writes files is flagged', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', writes('out.txt'));
  const { text } = receipt(dir);
  assert.match(text, /it changed files while it ran/);
  assert.match(text, /^RESULT {3}ALL PASSED$/m);
});

test('long commands are shown in full', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  const long = `${ok} && ${NODE} -e "console.log('a second command that is long enough to wrap')"`;
  cli(dir, 'run', long);
  const { text } = receipt(dir);
  // Put the wrapped command back together, without its time at the end.
  const squash = (s) => s.replace(/\s+/g, '');
  const commandLines = text.split('\n').filter((l) => /^(PASS {2}| {6})/.test(l));
  const shown = squash(commandLines.map((l) => l.slice(6).replace(/\s+\S+s$/, '')).join(''));
  assert.ok(shown.includes(squash(long)), shown);
  for (const l of text.split('\n').filter((l) => !l.startsWith('Check it:'))) assert.ok(l.length <= 48, `too wide: ${l}`);
});

test('runs in a subfolder share the log at the top of the repo', () => {
  const dir = repo();
  const sub = path.join(dir, 'packages', 'web');
  fs.mkdirSync(sub, { recursive: true });
  cli(dir, 'start', 'task');
  cli(sub, 'run', ok);
  const { text } = receipt(dir);
  assert.match(text, /^ {6}in packages\/web$/m);
  assert.ok(!fs.existsSync(path.join(sub, '.receipts')));
});

test('receipts never touches the index, objects or status', () => {
  const dir = repo();
  write(dir, 'app.js', 'changed\n');
  write(dir, 'untracked.js', 'new\n');
  const index = fs.readFileSync(path.join(dir, '.git', 'index'));
  const objects = git(dir, 'count-objects', '-v');
  const status = git(dir, 'status', '--porcelain');
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  receipt(dir);
  assert.deepEqual(fs.readFileSync(path.join(dir, '.git', 'index')), index);
  assert.equal(git(dir, 'count-objects', '-v'), objects);
  assert.equal(git(dir, 'status', '--porcelain'), status);
  assert.equal(fs.readFileSync(path.join(dir, '.receipts', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
});

test('verify: a real receipt on unchanged code passes', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  const { id } = receipt(dir);
  const r = cli(dir, 'verify', id);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /VERIFIED: this receipt matches the recorded runs\./);
  assert.match(r.stdout, /The code has not changed since it was printed\./);
  assert.equal(cli(dir, 'verify').status, 0); // latest receipt
});

test('verify: an edited log fails', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', exitWith(1));
  const { id } = receipt(dir);
  const log = path.join(dir, '.receipts', 'log.jsonl');
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('"exit":1', '"exit":0'));
  const r = cli(dir, 'verify', id);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT VERIFIED: the log was edited or damaged/);
});

test('verify: a receipt edited to look better fails', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', exitWith(1));
  const { id } = receipt(dir);
  const log = path.join(dir, '.receipts', 'log.jsonl');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const last = JSON.parse(lines.pop());
  last.result = 'ALL PASSED';
  last.checks[0].status = 'PASS';
  fs.writeFileSync(log, [...lines, JSON.stringify(last)].join('\n') + '\n');
  const r = cli(dir, 'verify', id);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the receipt was edited after it was printed/);
  assert.match(r.stdout, /says PASS, but its run says FAIL/);
});

test('verify: code changed since the receipt fails', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  const { id } = receipt(dir);
  write(dir, 'app.js', 'later\n');
  const r = cli(dir, 'verify', id);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /The code HAS changed since it was printed/);
});

test('verify: an unknown id fails', () => {
  const dir = repo();
  cli(dir, 'run', ok);
  receipt(dir);
  assert.equal(cli(dir, 'verify', 'ffffffffffff').status, 1);
});

test('outside git it still records, without change tracking', () => {
  const dir = folder();
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  write(dir, 'file.txt', 'edit\n');
  const { text, id } = receipt(dir);
  assert.match(text.replace(/\s+/g, ' '), /no git, so code changed after a check can't be seen/);
  assert.match(text, /^RESULT {3}ALL PASSED$/m);
  const r = cli(dir, 'verify', id);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Change tracking is off here/);
});

test('help, version and bad input', () => {
  const dir = folder();
  assert.match(cli(dir, 'help').stdout, /start "<task>"/);
  assert.match(cli(dir, '--version').stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(cli(dir, 'nope').status, 2);
  assert.equal(cli(dir, 'run').status, 2);
  assert.equal(cli(dir, 'start').status, 2);
});

test('the receipt line layout', () => {
  const dir = repo();
  cli(dir, 'start', 'task');
  cli(dir, 'run', ok);
  const { text } = receipt(dir);
  const check = lineOf(text, 'PASS');
  assert.equal(check.length, 48);
  assert.match(check, /(<0\.1|\d+\.\d)s$/);
});
