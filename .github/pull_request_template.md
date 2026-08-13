<!--
  Title must follow Conventional Commits, in English:  type: short description
  Example:  feat: send approved purchase orders to treasury

  Base branch:
    feature / fix / docs / refactor / chore  ->  develop
    hotfix (production is broken)            ->  main   [DEPLOYS ON MERGE]

  See CONTRIBUTING.md
-->

## What changes

<!-- One or two sentences. What this PR does. -->

## Why

<!-- The problem being solved, or the reason behind the change. Not the diff. -->

## How to test

<!-- Steps for the reviewer to verify it. Include the affected module (1.1 Requerimientos, 1.3 Registro OCs, ...). -->

1.
2.

## Screenshots

<!-- Required if the UI changed. Delete this section otherwise. -->

---

## Checklist

- [ ] Base branch is correct (`develop`, or `main` only for a hotfix)
- [ ] Commits follow Conventional Commits and are written in English
- [ ] No commit or description mentions AI tools
- [ ] No `.env`, `data/local.db`, `node_modules/` or logs committed
- [ ] No secrets left in the code (keys, tokens, passwords)
- [ ] Tested the affected flow locally

### Only for a hotfix into `main`

- [ ] Production is actually broken — this cannot wait for the next release
- [ ] I will merge `main` back into `develop` right after this lands
