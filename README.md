# AE → Houdini USD Exporter

> 🚧 Early release — verified against AE preview for cameras (1-node and 2-node, animated and static), nulls, hierarchy and translations. Lights and 3D AVLayer anchor handling are not yet exhaustively tested. Open an issue if you hit something off.

ExtendScript that exports an After Effects composition's 3D layers (cameras, lights, nulls, 3D AVLayers) to a USD ASCII file ready for import into Houdini.

## Why

Direct AE → USD without going through Cinema4D / Alembic round-trips. Smaller files, preserved hierarchy, no per-layer Z stacking, no time stretching from fps mismatches.

## Conventions

The script follows the **TresSims AE→Houdini convention**:

```
position: (x, -y, -z)
rotation: (rx, -ry, -rz)
```

— a bilateral conjugation by `S = diag(1, -1, -1)` that maps AE's left-handed Y-down coordinate system into USD's right-handed Y-up. Identity in AE → identity in USD.

## Layer mapping

| AE                       | USD                                  |
|--------------------------|--------------------------------------|
| Camera                   | `Camera`                             |
| Ambient light            | `DomeLight`                          |
| Parallel light           | `DistantLight`                       |
| Point light              | `SphereLight` (`treatAsPoint = 1`)   |
| Spot light               | `SphereLight + ShapingAPI`           |
| 3D AVLayer / Null / Solid | `Xform`                             |

AE parent/child relationships are preserved as nested USD prims. AE's local position/rotation/scale composes correctly through the nesting.

## Install

1. Save `export_to_houdini_draft.jsx` to your AE Scripts folder, or anywhere on disk.
2. In After Effects: `File → Scripts → Run Script File…` and pick the `.jsx`.
3. Optional: drop it in `Adobe After Effects/Scripts/ScriptUI Panels/` to dock it as a panel.

## Usage

1. Open the comp you want to export and make sure it's the active item.
2. Run the script. The dialog offers:
   - **Scale** — AE pixels per USD scene unit (default 100, so 1 m in Houdini = 100 AE px)
   - **Clipping near / far** — written into the USD camera
   - **Frame range** — Current frame / Work area / Full comp
   - **Export ALL eligible layers** vs selected only
   - **Centre comp at world origin** — wraps the scene in a parent translate so the comp centre lands at world `(0, 0, 0)` instead of the AE-native top-left
3. Pick a save path. Defaults to `<compname>.usda` in the project folder.
4. After write, a confirmation dialog offers **Reveal in Finder** and **Open .usda**.

The dialog remembers your last-used settings between runs.

## Optimisations

- Static prims emit plain values (no `timeSamples`).
- Pure-translation prims (no rotation/scale) emit `xformOp:translate` instead of a full `matrix4d`.
- Held animation runs (consecutive equal samples) are de-duplicated to bookend keys only.
- Negative-zero / trailing-zero formatting is cleaned up for readability.

## Visibility filter

Matches AE's render-time visibility:

| AE state                              | Exported? |
|---------------------------------------|-----------|
| Eyeball on                            | ✅        |
| Eyeball off                           | ❌        |
| Solo active anywhere in the comp      | only solo'd layers |
| Shy (UI-hidden but rendered)          | ✅        |
| Locked                                | ✅        |
| 3D switch off on an AVLayer           | ❌        |

## Known limitations

- Layers parented to a non-exported layer (e.g. parented to a 2D layer) become roots with a parent-relative transform — world position will be wrong in that case.
- Anchor points on 3D AVLayers are not yet handled — rotation/scale pivot will be at the prim origin, not the AE anchor.
- Camera focal length math assumes AE's default 36 mm horizontal film. If you change Film Size in AE camera settings, edit `FILM_WIDTH_MM` at the top of the script.
- Lights export the AE light type and intensity/colour/cone params but haven't been visually verified across all four light types.

## Convention sources

- [TresSims / After-Effects-3D-Camera-to-Houdini](https://github.com/TresSims/After-Effects-3D-Camera-to-Houdini)
- [howiemnet — AE camera data into Houdini gist](https://gist.github.com/howiemnet/8784cf04568c849271730965eaf35159)
- Adobe — [Cameras, lights, and points of interest](https://helpx.adobe.com/after-effects/using/cameras-lights-points-interest.html)

## Licence

MIT.
