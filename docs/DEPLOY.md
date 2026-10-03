# Building and shipping the Windows offline package

## Build (any OS with Node 22+)

```
npm ci
npm run package:windows
```

This runs the type check and `vite build`, checks that every offline asset is present and that
`index.html` has no external URLs, then writes:

- `release/Groovy-Windows/` - the folder to copy to the laptop
- `release/Groovy-Windows.zip` - the same, zipped

Every push also builds this zip on GitHub Actions (workflow **windows-package**) and test-starts
the launcher on Windows. Open the run, download the **Groovy-Windows** artifact (kept 30 days), and
unzip it on the laptop.

For a version to keep, push a tag: `git tag v1.2.0 && git push origin v1.2.0`. The same workflow
then publishes the zip as a GitHub **release** (Releases page), which does not expire.

## Checks on every PR (workflow **ci**)

- **Type check, build, unit tests**: `npm run build`, `npm test`.
- **Golden images**: `npm run golden` renders every scenario with the PR's base and with the PR on
  the same machine and compares them (no reference images are stored). Intentional visual changes
  are listed in `tests/golden/expected-changes/<branch>.txt`.
- **UI smoke test**: `npm run smoke` (service switching, reset, debug overlay, live camera).

## On the laptop

1. Unzip to a permanent folder (not inside the ZIP viewer).
2. Double-click `Create Desktop Shortcut.vbs` once, then use the **Groovy** shortcut.
3. Allow the camera when the browser asks.

No Node, Python or internet is needed on the laptop.

## What is in the folder

```
Start Groovy.vbs               starts the launcher hidden
Create Desktop Shortcut.vbs    makes the Desktop shortcut
launcher/start-windows.ps1     tiny loopback web server (127.0.0.1 only), serves app/
app/                           the built site (index.html, assets/, models/, vendor/, ...)
offline-assets.sha256.json     SHA-256 of every file in app/
```

The launcher serves only `app/`. It picks a free port in 8019-8039 and reuses an already
running copy.

## Customising

- Logo: replace `public/images/groovy-logo.png`
- Colours: the variables at the top of `src/styles.css`
- Then run `npm run package:windows` again and ship the new zip.

## Updating an installed laptop

Unzip the new package over a new folder and recreate the Desktop shortcut (the shortcut points to
the folder it was created from).
