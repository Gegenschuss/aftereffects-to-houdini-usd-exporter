# AE → Houdini USD Exporter

> 🚧 Early release — cameras, nulls, hierarchy, translations, solids, footage, text and shape layers are verified against AE preview. Light render output and 3D AVLayer anchor handling are not yet exhaustively tested. Open an issue if you hit something off.

ExtendScript that exports an After Effects composition's 3D layers — cameras, lights, nulls, AVLayers, solids, footage, text and shape layers — to a USD ASCII file ready for import into Houdini.

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

| AE                          | USD                                                                                |
|-----------------------------|------------------------------------------------------------------------------------|
| Camera                      | `Camera`                                                                           |
| Ambient light               | `DomeLight`                                                                        |
| Parallel light              | `DistantLight`                                                                     |
| Point light                 | `SphereLight` (`radius = 0.1`, `inputs:normalize = 1`)                             |
| Spot light                  | `SphereLight` + `ShapingAPI`                                                       |
| Null / non-geo AVLayer      | `Xform`                                                                            |
| Solid                       | `Xform` + `Mesh` (flat quad, `primvars:displayColor` = solid colour)               |
| Footage (image / video)     | `Xform` + `Mesh` + `Material` (`UsdPreviewSurface` + `UsdUVTexture` + `UsdPrimvarReader_float2`) |
| Text layer                  | `Xform` + `Mesh` (bounding-box quad, fill colour from text properties)             |
| Shape layer                 | `Xform` + `Mesh` (bounding-box quad, fill colour from first `ADBE Vector Graphic - Fill`) |

AE parent/child relationships are preserved as nested USD prims. AE's local position/rotation/scale composes correctly through the nesting.

Text and shape geometry is the layer's **bounding box** — not the actual glyph/vector outlines. Gradients, strokes, multi-fill effects, trim paths etc. are not represented.

## Install

1. Save `GegenschussAeUsdExporter.jsx` to your AE Scripts folder, or anywhere on disk.
2. In After Effects: `File → Scripts → Run Script File…` and pick the `.jsx`.
3. Optional: drop it in `Adobe After Effects/Scripts/ScriptUI Panels/` to dock it as a panel.

## Usage

1. Open the comp you want to export and make sure it's the active item.
2. Run the script. The dialog offers:
   - **Scale** — AE pixels per USD scene unit (default 100, so 1 m in Houdini = 100 AE px)
   - **Clip near / far** — written into the USD camera
   - **Frames** — Current / Work area / Full comp
   - **Visible only** — when on, only layers with the eyeball enabled (and inside any active solo set) are exported
   - **Reset** — restore default values
3. Pick a save path. Defaults to `<compname>.usda` in the project folder.
4. After write, a confirmation dialog offers **Reveal in Finder** and **Open .usda**.

The comp is always wrapped in a parent translate so its centre lands at world `(0, 0, 0)` instead of AE's native top-left. Last-used dialog settings are remembered between runs.

## Preflight conversions

Before writing the USD file, the script may offer one or both of these interactive preflights when the comp needs adjustment:

- **2D layers** — a 3D layer parented to a 2D layer (or any 2D layer that's selected when "Visible only" is off) won't export correctly. The preflight lists offenders and offers to flip them to 3D in one click.
- **Multi-shape layers** — a shape layer with more than one *Vector Group* is split into one layer per group (each group becomes its own USD prim with its own bounds and fill colour).

Either preflight is destructive on the AE project, so before any change a **versioned backup** runs first: `Increment and Save` if the project has been saved (the standard AE menu command), otherwise a timestamped `.aep` copy next to the original. Cmd-Z also undoes the changes within the same AE session.

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

- Text and shape geometry is a flat **bounding-box quad**, not the actual glyph or vector outlines. Colour is the detected fill; gradients, strokes, multi-fill effects, trim paths, repeaters etc. are not represented.
- Anchor points on 3D AVLayers are not yet handled — rotation/scale pivot will be at the prim origin, not the AE anchor.
- Layers parented to a non-exported (2D) layer become roots with a parent-relative transform — world position will be wrong. The 2D-layer preflight catches this when the parent is in the same comp.
- Camera focal length math assumes AE's default 36 mm horizontal film. If you change Film Size in AE camera settings, edit `FILM_WIDTH_MM` at the top of the script.
- Lights export the AE light type and intensity/colour/cone params but haven't been visually verified across all four light types in Houdini/Karma.
- Layer **time-stretch** and **time-remap** are ignored — output is sampled at comp time directly.

## Convention sources

- [TresSims / After-Effects-3D-Camera-to-Houdini](https://github.com/TresSims/After-Effects-3D-Camera-to-Houdini)
- [howiemnet — AE camera data into Houdini gist](https://gist.github.com/howiemnet/8784cf04568c849271730965eaf35159)
- Adobe — [Cameras, lights, and points of interest](https://helpx.adobe.com/after-effects/using/cameras-lights-points-interest.html)

## Licence

MIT.
