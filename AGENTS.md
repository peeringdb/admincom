# admincom

## Repository Overview

PeeringDB Admin Committee (AC) operations repo: issue tracking for admin onboarding/deboarding and
AC support requests, plus Tampermonkey userscript tooling for CP/FP/DeskPro admin workflows.

## Repository Map

```text
.
├── .github/ISSUE_TEMPLATE/  — Admin onboarding/deboarding checklists (ADD_ADMIN.md, REMOVE_ADMIN.md)
└── user.js/                 — Tampermonkey userscripts (CP/FP/DeskPro). See user.js/AGENTS.md.
```

## Working with issues

- Most issues aren't code work — see the AC onboarding/deboarding templates above.
- Code work (the `userscript` label) happens under `user.js/` — see [`user.js/AGENTS.md`](user.js/AGENTS.md)
  for the build/edit workflow; there's nothing to build or test at the repo root.
- Tag AI-assisted issues/PRs `llm-assisted` (or `llm-built` if fully agent-authored), matching
  existing usage (e.g. #287, #289).
