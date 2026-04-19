\# Overnight Build Instructions



Read CLAUDE.md in this directory first. That file is authoritative. These instructions

layer on top.



You are running unattended. The operator is asleep. You will not get clarifying answers

until morning. When in doubt, prefer the conservative choice, commit what you have, and

continue to the next block.



\## Execution plan

Work through Sections 1, 3, 4, 5, 7 of CLAUDE.md in order. That means: scaffold the

repo, implement the system prompt + tool schemas, generate the fake store data, build

session state, build the agent loop, build the chat UI, build the debug view, wire the

JSONL logger.



Stop short of deployment. Do not run `vercel deploy` or any command that requires

browser-based authentication. Do not run `vercel login`. Those steps are for the

morning.



\## Working style for this run

1\. Work in tight loops: write a file, commit, move on. Do not let uncommitted work

&#x20;  accumulate for more than 30 minutes.

2\. After each completed block from CLAUDE.md's hour-by-hour plan, run `pnpm build`

&#x20;  locally to confirm the codebase still compiles. If it doesn't, fix before moving on.

3\. Commit messages written as if to a senior teammate. Format:

&#x20;  `feat(agent): wire tool\_use loop with streaming`, not `wip` or `update`.

4\. When you hit a decision you cannot confidently resolve from CLAUDE.md — UI layout

&#x20;  choices, ambiguous error handling, library API you haven't used — write a `TODO:

&#x20;  decide AM` comment in the code, pick the conservative option, commit, and continue.

&#x20;  Do not block on it.

5\. If a dependency install fails, try once with `--force`. If it still fails, comment

&#x20;  it out, write a TODO, and continue with the rest of the build.

6\. Run the eval harness at least once before stopping. Dump failures to

&#x20;  `evals/failures.json` as the CLAUDE.md spec instructs. Do not try to get every eval

&#x20;  passing — that's a morning task with me in the loop.



\## Status reporting

Every 45 minutes, append a one-paragraph status to `BUILD\_LOG.md` in the project root.

Format:

\- Timestamp

\- What you just finished

\- What you're working on next

\- Any TODOs you've left behind for the morning

\- Any blockers you couldn't route around



This file is my breakfast reading. Write it for someone who has not seen any of your

intermediate work.



\## Hard stops — do not attempt

\- Never run `vercel login`, `vercel deploy`, or any OAuth flow

\- Never modify `.env.local` or anything containing secrets

\- Never `git push` to any remote — local commits only

\- Never install global npm packages (the `-g` flag)

\- Never attempt any scoped action outside the project directory

\- If an action is blocked by auto mode three times in a row, stop attempting it,

&#x20; document in BUILD\_LOG.md, and move on to the next block



\## Stopping condition

Stop when any of these hit:

\- All of Sections 1, 3, 4, 5, 7 from CLAUDE.md are complete and committed

\- You've been running for 7 hours

\- You've logged three consecutive blockers you couldn't route around



Whenever you stop, write a final BUILD\_LOG.md entry titled "STOPPED" explaining why,

what state the codebase is in, and what I should tackle first in the morning.



\## Your first action

Read CLAUDE.md end-to-end. Summarize the plan back in BUILD\_LOG.md as your first entry.

Then begin Section 1 (scaffold the repo).

