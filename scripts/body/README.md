# Body-shaping regression tools

Check every change to the body slimming against the same set of photos, with numbers and
before/after sheets, before it goes in.

**Photos of people stay on your computer.** Keep the test photos and every output folder outside
the repository (or in an ignored folder). Never commit or share them.

## 1. Run photos through the app

```sh
npm run build
node scripts/body/run-app.mjs --out ../body-runs/base <photo folder>...
```

This opens the built app (with `?debug=body`), uploads each photo in the body service, and saves:

- `app/<name>-50.jpg`, `app/<name>-100.jpg`: the results, as the app shows them;
- `dump/<name>/`: the analysis (movement fields, body points, body parts) and the fields' inputs.

Set `CHROMIUM_PATH` if Playwright should use a particular Chromium.

## 2. Recompute the fields without the browser (fast)

```sh
node scripts/body/fields.mjs --runs ../body-runs/base --out ../body-runs/try --compare --render
```

Runs the current `src/effects/body/field.ts` on the dumped inputs. `--compare` prints how much the
fields differ from the app run (0 = identical: use it to check that a speed-up changes nothing),
`--render` writes the 100% pictures (without the backdrop). The app combines BodyPix's and MediaPipe Pose's body points
(per limb, the ones that lie on the right BodyPix body parts: `src/effects/body/joints.ts`); the
dumps keep both. `--bodypix` uses BodyPix's points alone, `--fuse` recombines them (after a change
to `joints.ts`), and `--pose <landmarks.json>` takes MediaPipe's from a file instead.

## 3. Measure and compare

```sh
node scripts/body/metrics.mjs --runs ../body-runs/base --save ../body-runs/base.json
node scripts/body/metrics.mjs --runs ../body-runs/try --baseline ../body-runs/base.json
```

Per photo: how much the arms are magnified, shrunk or sheared, how unevenly the hands move, folds
in the picture, and how much the waist and hips come in (and the waist-to-hip ratio). With
`--baseline`, photos that got worse are listed and the exit code is 1.

## 4. Look at it

```sh
node scripts/body/sheets.mjs --out ../body-runs/sheets --crop body ../body-runs/base=Before ../body-runs/try=Now
```

`--crop full|body|arms`, `--only name1,name2`.
