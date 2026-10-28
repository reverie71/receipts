import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanLine, duration, summarize, wrap } from '../skills/receipts/scripts/receipts.mjs';

const cases = [
  [
    'jest',
    'Test Suites: 1 failed, 9 passed, 10 total\nTests:       1 failed, 211 passed, 212 total\nSnapshots:   0 total\nTime:        3.2 s\nRan all test suites.',
    1,
    '1 failed, 211 passed, 212 total',
  ],
  [
    'vitest',
    ' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)\n   Start at  10:00:00\n   Duration  1.20s',
    1,
    '2 failed, 40 passed (42)',
  ],
  ['pytest', '=================== 1 failed, 211 passed in 3.21s ===================', 1, '1 failed, 211 passed'],
  ['pytest with a long run', '===== 3 passed, 1 warning in 65.21s (0:01:05) =====', 0, '3 passed, 1 warning'],
  ['pytest -q', '........\n212 passed in 0.52s', 0, '212 passed'],
  [
    'go test',
    'ok  \texample.com/a\t0.012s\n--- FAIL: TestB (0.00s)\nFAIL\nFAIL\texample.com/b\t0.010s\n?   \texample.com/c\t[no test files]\nFAIL',
    1,
    '1 package ok, 1 failed (1 test)',
  ],
  ['go test, cached', 'ok  \texample.com/a\t(cached)\nok  \texample.com/b\t0.2s', 0, '2 packages ok, 0 failed'],
  [
    'cargo test',
    'running 3 tests\ntest a ... ok\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    0,
    '3 passed, 0 failed',
  ],
  ['cargo test, failing', 'test result: FAILED. 10 passed; 2 failed; 1 ignored; 0 measured; 0 filtered out', 101, '10 passed, 2 failed, 1 ignored'],
  ['node:test, tap', 'ok 1 - adds\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# skipped 1\n# duration_ms 50.8', 0, '2 passed, 0 failed, 1 skipped'],
  ['node:test, spec', 'ℹ tests 69\nℹ suites 0\nℹ pass 69\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 28000', 0, '69 passed, 0 failed'],
  ['mocha', '  212 passing (3s)\n  2 pending\n  1 failing\n\n  1) adds:\n     AssertionError', 1, '212 passed, 1 failed, 2 pending'],
  ['bun', ' 212 pass\n 0 fail\n 500 expect() calls\nRan 212 tests across 10 files. [1.20s]', 0, '212 passed, 0 failed'],
  ['deno', 'ok | 212 passed | 0 failed (3s)', 0, '212 passed, 0 failed'],
  ['unittest', '..F\n----------------------------------------------------------------------\nRan 12 tests in 0.003s\n\nFAILED (failures=1)', 1, '12 tests, FAILED (failures=1)'],
  ['dotnet', 'Passed!  - Failed:     0, Passed:   212, Skipped:     0, Total:   212, Duration: 1 s - My.dll (net8.0)', 0, '212 passed, 0 failed'],
  ['maven', '[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s\n[INFO] Tests run: 212, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS', 0, '212 run, 0 failures, 0 errors'],
  ['rspec', 'Finished in 1.2 seconds\n212 examples, 0 failures', 0, '212 examples, 0 failures'],
  ['tsc', "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 3 errors in 2 files.", 2, 'Found 3 errors in 2 files.'],
  [
    'npm noise after a crash',
    'Error: Cannot find module ./missing\nnpm error Lifecycle script `test` failed with error:\nnpm error code 1\nnpm error command failed',
    1,
    'Error: Cannot find module ./missing',
  ],
  ['color codes', '\x1b[32m\x1b[1m212 passed\x1b[22m\x1b[39m\x1b[32m in 1.2s\x1b[0m', 0, '212 passed'],
  ['nothing to report on success', 'Compiled successfully.', 0, ''],
  ['last line on failure', 'Building...\nsomething broke', 1, 'something broke'],
];

for (const [name, output, exit, want] of cases) {
  test(`summary: ${name}`, () => assert.equal(summarize(output, exit), want));
}

test('cleanLine drops colors, links and progress redraws', () => {
  assert.equal(cleanLine('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(cleanLine('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(cleanLine(' 10%\r 50%\r100% done\r'), '100% done');
});

test('wrap keeps every word and splits long ones', () => {
  assert.deepEqual(wrap('npm test -- --runInBand', 10), ['npm test', '--', '--runInBan', 'd']);
  assert.deepEqual(wrap('', 10), ['']);
  assert.deepEqual(wrap('a b c', 10, 3), ['a b', 'c']);
});

test('duration', () => {
  assert.equal(duration(12), '<0.1s');
  assert.equal(duration(41234), '41.2s');
  assert.equal(duration(185000), '3m05s');
  assert.equal(duration(3725000), '1h02m');
});
