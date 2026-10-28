---
name: receipts
description: Proof before "done". Use for every task that changes code. Run the project's tests and other checks through receipts, then end your reply with the receipt it prints. Use it before you say anything is done, fixed, working or passing, and before you commit or open a pull request.
license: MIT
compatibility: Needs Node.js 18 or newer. Git is optional; with it, receipts can tell when code changed after a check.
metadata:
  version: "0.1.0"
---

# receipts

Don't say a task is done, fixed, working or passing unless a receipt shows it.

Below, `receipts` means `node <skill folder>/scripts/receipts.mjs`, where `<skill folder>` is the absolute path of the folder that holds this file. Put the path in quotes if it has spaces.

## Steps

1. Before your first edit, start a receipt:

   ```
   receipts start "<the task in a few words>"
   ```

2. Do the work.

3. Find the project's checks: tests, type checks, linters and builds. Look in package.json scripts, Makefile, pyproject.toml, Cargo.toml, go.mod, CI workflows and the README. After your last edit, run each check through receipts, build steps first:

   ```
   receipts run "npm test"
   receipts run "npm run lint"
   ```

   receipts runs the command, shows its output, records the result and exits with the command's exit code. Commands run in sh on macOS and Linux, and in cmd.exe on Windows.

4. If a check fails, fix the cause and run it again. Never skip, weaken or delete a test to get a pass. If you can't fix it, leave it failing and say why.

5. If the project has no checks, add a test for your change, or run the changed code through receipts in a way that shows it works.

6. Record anything you could not check, such as another OS, a service you can't reach, or a manual step:

   ```
   receipts unchecked "<what, and why>"
   ```

7. Print the receipt:

   ```
   receipts print
   ```

8. End your final reply with the receipt exactly as printed, in a code block, with the "Check it" line under it. Never write, edit or shorten a receipt yourself.

Say "done" only when the receipt's RESULT is ALL PASSED. Otherwise, say what failed or is out of date.

## Results

- ALL PASSED: every check passed on the code as it is now.
- FAILED: the last run of a check failed.
- OUT OF DATE: the code changed after a check ran. Run it again, then print a new receipt.
- NO CHECKS: nothing ran through receipts.
