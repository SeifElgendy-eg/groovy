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

Every push also builds this zip on GitHub Actions (workflow **windows-package**). Open the run,
download the **Groovy-Windows** artifact, and unzip it on the laptop.

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
