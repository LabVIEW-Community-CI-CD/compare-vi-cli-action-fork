<!-- markdownlint-disable-next-line MD041 -->
# Daemon Debt Register

Context:
- Issue: `#1636`
- Worktree: `C:\dev\compare-vi-cli-action.daemon-support-1636`
- Base: `upstream/develop`
- Head at audit start: `7517fea1`

Commands used:
- `node tools/npm/run-script.mjs priority:delivery:agent:status`
- `node tools/npm/run-script.mjs priority:project:portfolio:check`

## RC-Threatening Findings

| Finding | Evidence | Impact | Follow-up |
| --- | --- | --- | --- |
| Worktree repo-root resolution falls back to `C:\dev` instead of the active worktree root. | `priority:delivery:agent:status` reported `repoRoot = C:\dev`, wrote runtime paths under `C:\dev\tests\results\_agent\runtime\...`, and set `workspaceQuarantine.reason = git-status-failed` with `fatal: not a git repository (or any of the parent directories): .git`. | Daemon status output is not worktree-safe and can write receipts outside the repository. That is RC-threatening because it breaks the bounded status surface in clean worktrees. | Filed as [#1658](https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action/issues/1658). |

## Current Debt Watch

- `delivery-agent-state.json` remains the primary runtime receipt.
- `runtime-state.json` is still legacy compatibility-only debt.
- `lane-marketplace-snapshot.json` is persisted, but still lacks its own dedicated checked-in schema entry.

## Audit Result

No additional RC-threatening daemon debt surfaced in this slice beyond the worktree repo-root bug above.
