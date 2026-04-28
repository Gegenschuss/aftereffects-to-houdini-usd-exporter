# CLAUDE.md

Guidance for Claude (and contributors) working on this exporter. The conventions below were verified empirically against AE preview — please don't change them based on Adobe / forum / community sources without first re-running the probe in `Verifying against AE` below.

## Coordinate convention (TresSims)

```
position:  (x,  -y, -z)     # AE world → USD world
rotation:  (rx, -ry, -rz)
```

At the matrix level: bilateral conjugation by `S = diag(1, -1, -1)`:

```
M_usd_col = S · R_ae · S         (column-vector form)
M_usd_row = S · R_ae^T · S       (row-vector form for USD storage)
```

Identity AE → identity USD. Applied uniformly to cameras, lights, nulls, AVLayers — no per-prim-type branching. If you find yourself wanting to add a sign-flip for one prim type only, you've probably misdiagnosed something else.

## AE Orientation Euler order is `X*Y*Z`

In `aeRotMatrix`:

```javascript
var Mo = m3mul(rotX(ori[0]), m3mul(rotY(ori[1]), rotZ(ori[2])));   // ✓ correct
// NOT: m3mul(rotY(ori[1]), m3mul(rotX(ori[0]), rotZ(ori[2])));     // ✗ Y*X*Z is wrong
```

**Verified empirically** with the probe-null script (`Verifying against AE` below). The `Y*X*Z` order — which various Adobe docs, ProVideoCoalition articles, and community plugins assume — produces a ~2° drift on animated 2-node cameras. `X*Y*Z` matches AE's rendered camera matrix to ~1e-4 across all tested frames.

The X/Y/Z Rotation order (`Mi`) is currently `Z*Y*X`. Untested empirically (test cameras have all-zero individual rotations). If a similar drift appears on cameras/nulls with non-zero X/Y/Z Rotation values, suspect that order next.

## 2-node camera composition

For an AE 2-node camera with `autoOrient = CAMERA_OR_POINT_OF_INTEREST`:

```javascript
Rae = m3mul(lookAtMatrix(rawPos, poi),
            aeRotMatrix(rp.ori, rp.xr, rp.yr, rp.zr));
```

(column-vector form — `aeRotMatrix` is applied first, then `lookAt`)

For 1-node cameras (`NO_AUTO_ORIENT` or `ALONG_PATH`) and nulls:

```javascript
Rae = aeRotMatrix(rp.ori, rp.xr, rp.yr, rp.zr);
```

Other compositions tested and rejected (all worse than the above):

| Composition | Result |
|---|---|
| `lookAt × aeRotMatrix` (X\*Y\*Z order) | ✅ matches AE to ~1e-4 |
| `aeRotMatrix × lookAt` | wrong — R rotates in world, not camera-local |
| `lookAt` only | wrong — ignores user's keyframed orientation |
| `aeRotMatrix` only | wrong — ignores POI auto-orient |

So Adobe DOES apply orientation values on top of POI lookAt for 2-node cameras, despite some doc text suggesting they're "ignored". Don't tear out the composition.

## Verifying against AE (probe-null trick)

When the script's camera matrix doesn't match AE preview, **don't iterate on math fixes by guessing**. Run this to get AE's ground-truth camera matrix at sample frames, then compare and solve.

`Layer.toWorld()` is not directly callable on a `CameraLayer` from ExtendScript (errors `Function layer.toWorld is undefined`), but it IS available in expressions. We use that.

Run with the target camera selected. Cleans up after itself:

```javascript
(function () {
    var comp = app.project.activeItem;
    var cam = comp.selectedLayers[0];
    if (!cam || !(cam instanceof CameraLayer)) {
        alert("Select a camera layer first"); return;
    }
    var fps = comp.frameRate;
    var frames = [0, 30, 60];   // edit as needed
    var probes = [[0,0,0], [100,0,0], [0,100,0], [0,0,100]];
    var nulls = [];
    app.beginUndoGroup("camera matrix probe");
    try {
        for (var i = 0; i < probes.length; i++) {
            var n = comp.layers.addNull();
            n.threeDLayer = true;
            n.name = "_PROBE_" + i;
            n.transform.position.expression =
                'thisComp.layer("' + cam.name + '").toWorld([' + probes[i].join(",") + '])';
            nulls.push(n);
        }
        var out = "Camera: " + cam.name + "  autoOrient=" + cam.autoOrient + "\n\n";
        for (var f = 0; f < frames.length; f++) {
            var t = frames[f] / fps;
            var o = nulls[0].transform.position.valueAtTime(t, false);
            out += "Frame " + frames[f] + ":\n  origin: (" + o.join(", ") + ")\n";
            var labels = ["+X", "+Y", "+Z"];
            for (var ax = 1; ax < 4; ax++) {
                var p = nulls[ax].transform.position.valueAtTime(t, false);
                var d = [(p[0]-o[0])/100, (p[1]-o[1])/100, (p[2]-o[2])/100];
                out += "  " + labels[ax-1] + ":     (" +
                       d[0].toFixed(4) + ", " + d[1].toFixed(4) + ", " + d[2].toFixed(4) + ")\n";
            }
            out += "\n";
        }
        alert(out);
    } finally {
        for (var i = nulls.length - 1; i >= 0; i--) { try { nulls[i].remove(); } catch (e) {} }
        app.endUndoGroup();
    }
})();
```

The `+X / +Y / +Z` lines are the camera's local axes expressed in AE world coordinates — i.e. the columns of the camera's rotation matrix. That's the ground truth to compare against the script's output.

## Camera focal length

Read per-frame from `cameraOption.zoom` (pixels) and converted via:

```javascript
flS.push([frame, FILM_WIDTH_MM * zoom / comp.width * MM_TO_USD]);
```

`FILM_WIDTH_MM = 36` is hardcoded — AE's `filmSize` property isn't exposed via ExtendScript. If a project uses a non-default film back (e.g. APS-C 24 mm), edit the constant at the top of the script or expose it in the dialog.

USD `focalLength` units are "tenths of scene unit" with `metersPerUnit = 1`. A 50 mm AE camera lands as `focalLength = 0.5`, which Houdini reads correctly.

## Build version

Bump `BUILD_DATE` (YYMMDD format with optional letter suffix) at the top of the script on each meaningful change. Shown in the dialog title.

## What's verified vs not

End-to-end against AE preview:
- ✅ Translation, hierarchy, comp-centre offset
- ✅ 1-node camera (static + animated)
- ✅ 2-node camera (static + animated, with keyframed Orientation)
- ✅ Camera focal length, aperture, focus distance
- ✅ Static-value optimisation, dedup of held timeSamples
- ✅ Visibility filter (eyeball off, solo)
- ✅ Solid → quad mesh + displayColor
- ✅ Footage → quad mesh + UsdPreviewSurface (texture, UV reader)
- ✅ Text/Shape → bounding-box quad + detected fill colour
- ✅ 2D parent / 2D-selected preflight (interactive convert-to-3D)
- ✅ Multi-shape preflight (split layers with >1 Vector Group)
- ✅ Versioned backup (Increment-and-Save / `.aep` copy fallback) before destructive AE ops
- ✅ UTF-8 file writer (non-ASCII layer names round-trip)
- ✅ Layer in/out → `visibility.timeSamples`

Not yet visually verified:
- ⚠️ All four light types (data is exported, framing/falloff in Houdini not confirmed)
- ⚠️ 3D AVLayer anchor point (currently ignored — will mis-pivot for non-default anchors)
- ⚠️ Parented 2-node camera with animated parent (POI is in world space, position in parent space — mixed-space lookAt)
- ⚠️ Negative scale on AVLayers
- ⚠️ Layer time-stretch / time-remap (script ignores)

When chasing one of these, run the probe trick first if rotation/orientation is involved.

## Pending follow-ups

Use this section to resume across sessions. Remove items as they ship.

### 1. Functional gaps (not yet addressed)

Already listed in *What's verified vs not* above, repeated here as actionable TODO:

- **Light visual verification in Houdini/Karma.** All four types export data; per-type intensity tuning (Sphere × 1.0, Distant × 0.05, Dome × 0.01, plus `inputs:normalize = 1` and `radius = 0.1` for SphereLight) is the current convention. Needs a render-comparison sweep: AE preview vs Houdini render, all four types.
- **3D AVLayer anchor point.** Currently ignored. Non-default anchors → wrong rotation/scale pivot. Plumb anchor into the transform composition (anchor-translate, then rot/scale, then anchor-untranslate, then position) when this becomes user-visible.
- **Parented 2-node camera with animated parent.** AE stores `pointOfInterest` in *world* space while position is in *parent* space — mixed-space lookAt. Untested; suspect this breaks when both the camera and its parent are animated.
- **Negative scale on AVLayers.** Untested; likely flips winding order without our handling.
- **Layer time-stretch / time-remap.** Currently ignored — output uses comp-time samples, not source-time samples.
- **X/Y/Z Rotation order (`Mi`) is `Z*Y*X`, untested.** All test cameras have zero individual X/Y/Z Rotations. If a `~2°` drift appears on cameras/nulls with non-zero values, suspect this Euler order next and run the probe trick.
- **`FILM_WIDTH_MM` hardcoded to 36.** AE's `filmSize` isn't exposed via ExtendScript. If users with APS-C / S35 / etc. backs ask, expose it in the dialog.

### How to resume a session

1. Re-read this section first; tick off anything the user has confirmed since.
2. For the README: read current `README.md`, apply the diff sketched above. Keep existing tone (early-release warning, TresSims convention block, terse install/usage).
3. For functional gaps: run the probe-null trick before guessing math fixes.
4. Bump `BUILD_DATE` at the top of `GegenschussAeUsdExporter.jsx` for each meaningful change (after `260428aa` continue alphabetically: `260428ab`, `ac`, …, or roll the date).
5. **Never auto-commit.** Make the edit, save, tell the user briefly what changed, wait for `ship`.
