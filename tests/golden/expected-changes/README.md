# Expected golden changes

When a PR changes how a golden scenario renders on purpose, add **one file for that PR** here,
named after its branch (for example `feat-lip-edge-snap.txt`), listing the scenario names one per
line (`#` starts a comment):

```
# Lips: colour outline snapped to the real lip border
lips-color-28
```

The check (`npm run golden` locally, the **ci** workflow on GitHub; both run
`scripts/golden-ab.mjs`) honours only the files added or edited since the base, so a list never
carries over to later PRs, and two open PRs never touch the same file (no merge conflicts). Old
files can be deleted at any time; deleting one has no effect.

The changed renders are still produced (`tests/golden/out` vs `tests/golden/out-base`; on GitHub,
the `golden-renders` artifact) for review.
