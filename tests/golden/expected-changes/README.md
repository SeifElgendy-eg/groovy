# Expected golden changes

When a PR changes how a golden scenario renders on purpose, add **one file for that PR** here,
named after its branch (for example `feat-lip-edge-snap.txt`), listing the scenario names one per
line (`#` starts a comment):

```
# Lips: colour outline snapped to the real lip border
lips-color-28
```

CI (`.github/workflows/golden.yml`) honours only the files the PR itself adds or edits, so a list
never carries over to later PRs, and two open PRs never touch the same file (no merge conflicts).
Old files can be deleted at any time; deleting one has no effect on CI.

The changed renders are still produced and uploaded as the `golden-renders` artifact for review.
