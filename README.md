# receipts

**Your coding agent can't say "done" without receipts.**

Coding agents say "all tests pass" when they never ran them, ran half of them, or ran them before their last edit. receipts is an agent skill that makes the agent run its checks through a small script. The script records what really ran, and the agent ends its reply with a receipt it can't write by hand.

A real receipt from Claude Code, after it added an option to a slug function:

```
================================================
                    RECEIPT
================================================
task     Add maxLength option to slugify
repo     e2e-slug2 (main)
when     2026-10-28 09:56 to 09:56 (under 1 min)
changes  2 files, +45 -3 since 2f6e362
tests    test/slug.test.mjs (edited)
------------------------------------------------
PASS  npm test                              0.2s
      10 passed, 0 failed
PASS  npm run lint                          0.1s
------------------------------------------------
RESULT   ALL PASSED
         2 of 2 checks passed on this code
receipt  fbbd5537270d
================================================
Check it: node .claude/skills/receipts/scripts/receipts.mjs verify fbbd5537270d
```

## Install

```
npx skills add reverie71/receipts
```

The [skills](https://github.com/vercel-labs/skills) installer puts it in your project for Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode and dozens of other agents. Add `-g` to install it for every project.

receipts works in any agent that supports Agent Skills and can run shell commands. It needs Node.js 18 or newer. Git is optional, but it's what lets receipts notice code that changed after a check.

## What a receipt shows

- **Every check that ran:** the exact command, how long it took, and a summary like `10 passed, 0 failed`. It reads the output of jest, vitest, pytest, go test, cargo test, node:test, mocha, bun, deno, unittest, dotnet and maven.
- **FAIL** when the last run of a check failed, and **STALE** when the code changed after a check passed.
- **What changed:** files and lines since the task started, and every test file that was added, edited or deleted.
- **NOT CHECKED:** what the agent couldn't check, listed instead of left out.
- **RESULT:** ALL PASSED only when every check passed on the code as it is now.

## How it works

1. When a task starts, the agent runs `receipts start "<task>"`.
2. It runs each check through receipts, like `receipts run "npm test"`. receipts runs the command as usual and records the exit code, the time, a summary and a fingerprint of the code.
3. At the end, it runs `receipts print` and pastes the receipt into its reply.

The record lives in `.receipts/` at the top of your repo. Git ignores it, and nothing leaves your computer.

## Check a receipt yourself

Every receipt ends with a line like this one. Run it from the top of the repo:

```
node .claude/skills/receipts/scripts/receipts.mjs verify fbbd5537270d
```

`verify` confirms that the receipt matches the recorded runs, and tells you if the code has changed since the receipt was printed.

## Make it always on

Agents load the skill when a task changes code. To be sure, add this line to your `AGENTS.md` or `CLAUDE.md`:

```
Use the receipts skill for every task that changes code.
```

## Questions

**Can't the agent just fake a receipt?** A receipt it types itself won't pass `verify`. Each log entry includes the hash of the entry before it, so editing the log breaks the chain, and editing a receipt changes its id. An agent that rewrote the whole log on purpose could still get past that. What receipts catches are the everyday problems: claims with no run behind them, failures reported as passes, and checks that ran before the last edit.

**Does it touch my git repo?** No. It only reads from git. It never stages, commits or writes git objects. Its only files are in `.receipts/`.

**Why not just tell the agent to run the tests?** That helps, but you still have to trust the agent's summary. A receipt comes from the runs themselves, and it notices when the tests ran before the last edit.

## License

MIT
