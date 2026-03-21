<!-- markdownlint-disable-next-line MD041 -->
# Daemon Capability Expansion Register

Context:
- Issue: `#1636`
- Worktree: `C:\dev\compare-vi-cli-action.daemon-support-1636`
- Base: `upstream/develop`

Observed anchors:
- `docs/knowledgebase/Unattended-Delivery-Daemon-Surfaces.md`
- `docs/knowledgebase/Live-Agent-Model-Selection.md`
- `tools/priority/runtime-supervisor.mjs`
- `tools/priority/delivery-agent.mjs`

## Bounded Expansion Seams

| Seam | Why it matters | Concrete next step |
| --- | --- | --- |
| Worktree-safe daemon status projection | The daemon status surface should report and persist paths relative to the active worktree, not the parent control root. | Extend the status path resolution tests to cover a clean nested worktree and keep all receipts rooted at that worktree. |
| Unified daemon health view | The repo already has separate surfaces for runtime status, live-agent selection, and template verification. | Add a bounded projection that summarizes all three without changing control behavior. |
| Receipt-first lane auditing | The current support slice relied on command output and receipts, but the registers are still mostly narrative. | Add a machine-readable register schema so future slices can emit the same audit shape deterministically. |
| Capability-to-issue handoff | Expansion seams should turn into concrete work items only when they threaten RC or throughput. | Keep the register as the source of truth, and spin out issues only for findings with explicit evidence and owner scope. |

## Non-Goals

- Do not rewrite the daemon architecture.
- Do not widen the control plane beyond the current unattended delivery surfaces.
- Do not create follow-up issues for speculative expansion ideas.
