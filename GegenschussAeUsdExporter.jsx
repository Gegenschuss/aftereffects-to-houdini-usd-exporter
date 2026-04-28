/**
 * AE → Houdini USD Exporter  (TresSims convention)
 *
 * Exports AE Camera, Lights, and 3D layers to a USD ASCII file using the
 * AE→Houdini camera-importer convention documented by TresSims:
 *
 *     position:  (x,  -y, -z)
 *     rotation:  (rx, -ry, -rz)
 *
 * At the matrix level this is a bilateral conjugation with S = diag(1,-1,-1):
 *
 *     M_usd_col = S · R_ae · S                (column-vector form)
 *     M_usd_row = S · R_ae^T · S              (row-vector form for USD)
 *
 * Identity AE rotation → identity USD matrix.  Applied uniformly to cameras,
 * lights, nulls, and 3D AVLayers — no per-prim-type branching.
 *
 * Units: metersPerUnit = 1 (Houdini's default).  USD camera focalLength and
 * aperture are in tenths of scene unit, so physical mm values are divided by
 * 100 before writing (matches Houdini's own test.usda: focal ≈ 0.5).
 *
 * Layer mapping:
 *   AE Camera        → Camera
 *   AE Ambient       → DomeLight
 *   AE Parallel      → DistantLight
 *   AE Point         → SphereLight (treatAsPoint)
 *   AE Spot          → SphereLight + ShapingAPI
 *   AE 3D AVLayer    → Xform
 *
 * Hierarchy: AE parent/child relationships are preserved as nested USD prims.
 * Each prim's matrix is its LOCAL transform relative to its USD parent, so
 * AE's local position/rotation/scale composes correctly through nesting.
 * (AE.position is in parent space when parented; we reuse that directly.)
 *
 * Optimisations:
 *   - Static samples (no animation) are emitted as plain values, not timeSamples.
 *   - Optional comp-center offset wraps the scene in a parent translate so the
 *     comp centre lands at world origin, matching C4D's AE-roundtrip convention.
 */

(function aeToHoudiniUSD() {

    // ── Guard ─────────────────────────────────────────────────────────────
    if (!app.project || !app.project.activeItem ||
        !(app.project.activeItem instanceof CompItem)) {
        alert("Please make a composition active before running this script.");
        return;
    }
    var comp = app.project.activeItem;

    // AE's default camera uses 36 mm film width, measured horizontally
    // (CameraSettings → Film Size: 36 mm, Measure: Horizontally).  The film
    // size isn't exposed via scripting, so we assume the default — change
    // here if your AE project uses a different film back.
    var FILM_WIDTH_MM = 36;
    var PREFS_SECTION = "AE_USD_Exporter";

    // Persist dialog choices between runs via app.settings (per-user).
    function loadPref(key, fallback) {
        try {
            if (app.settings.haveSetting(PREFS_SECTION, key)) {
                return app.settings.getSetting(PREFS_SECTION, key);
            }
        } catch (e) {}
        return fallback;
    }
    function savePref(key, value) {
        try { app.settings.saveSetting(PREFS_SECTION, key, String(value)); }
        catch (e) {}
    }

    // ── Dialog ────────────────────────────────────────────────────────────
    var BUILD_DATE = "260428e";  // bump on each meaningful change (YYMMDD)
    var dlg = new Window("dialog", "AE \u2192 Houdini USD  " + BUILD_DATE);
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.spacing = 6;
    dlg.margins = 14;

    // Scale + Clip near/far on one row
    var grpRow1 = dlg.add("group");
    grpRow1.alignChildren = ["left", "center"];
    grpRow1.add("statictext", undefined, "Scale");
    var scaleInput = grpRow1.add("edittext", undefined, loadPref("scale", "100"));
    scaleInput.preferredSize.width = 50;
    grpRow1.add("statictext", undefined, "px / m   Clip");
    var nearInput = grpRow1.add("edittext", undefined, loadPref("clipNear", "0.1"));
    nearInput.preferredSize.width = 45;
    grpRow1.add("statictext", undefined, "\u2013");
    var farInput = grpRow1.add("edittext", undefined, loadPref("clipFar", "100000"));
    farInput.preferredSize.width = 65;

    // Frame range inline
    var grpRange = dlg.add("group");
    grpRange.alignChildren = ["left", "center"];
    grpRange.add("statictext", undefined, "Frames");
    var rbSingle = grpRange.add("radiobutton", undefined, "Current");
    var rbWork   = grpRange.add("radiobutton", undefined, "Work area");
    var rbFull   = grpRange.add("radiobutton", undefined, "Full comp");
    var savedRange = loadPref("frameRange", "work");
    rbSingle.value = (savedRange === "single");
    rbWork.value   = (savedRange === "work");
    rbFull.value   = (savedRange === "full");

    var chkAll = dlg.add("checkbox", undefined, "Export all 3D layers");
    chkAll.value = (loadPref("exportAll", "1") === "1");

    var chkCenter = dlg.add("checkbox", undefined, "Centre comp at world origin");
    chkCenter.value = (loadPref("centerOffset", "1") === "1");

    var grpBtns = dlg.add("group");
    grpBtns.alignment = "right";
    var btnSave   = grpBtns.add("button", undefined, "Save\u2026");
    var btnCancel = grpBtns.add("button", undefined, "Cancel");

    var outFile = null;
    btnCancel.onClick = function () { dlg.close(); };
    btnSave.onClick = function () {
        var defaultName = (comp.name || "untitled").replace(/[^a-zA-Z0-9_]/g, '_') + ".usda";
        var defaultDir  = (app.project.file ? app.project.file.parent : Folder.desktop);
        var defaultFile = new File(defaultDir.fsName + "/" + defaultName);
        outFile = defaultFile.saveDlg("Save USD ASCII file", "*.usda");
        if (outFile) dlg.close();
    };

    dlg.show();
    if (!outFile) return;

    var outPath = outFile.fsName;
    if (!/\.usda$/i.test(outPath)) outPath += '.usda';
    outFile = new File(outPath);

    var scale        = parseFloat(scaleInput.text) || 100;
    var clipNear     = parseFloat(nearInput.text)  || 0.1;
    var clipFar      = parseFloat(farInput.text)   || 100000;
    var centerOffset = chkCenter.value;

    // Persist for next run.
    savePref("scale",        scaleInput.text);
    savePref("clipNear",     nearInput.text);
    savePref("clipFar",      farInput.text);
    savePref("frameRange",   rbSingle.value ? "single" : (rbFull.value ? "full" : "work"));
    savePref("exportAll",    chkAll.value    ? "1" : "0");
    savePref("centerOffset", chkCenter.value ? "1" : "0");

    // ── Frame range ───────────────────────────────────────────────────────
    var fps = comp.frameRate;
    var startFrame, endFrame;
    if (rbSingle.value) {
        startFrame = Math.round(comp.time * fps);
        endFrame   = startFrame;
    } else if (rbWork.value) {
        startFrame = Math.round(comp.workAreaStart * fps);
        endFrame   = Math.round((comp.workAreaStart + comp.workAreaDuration) * fps) - 1;
    } else {
        startFrame = 0;
        endFrame   = Math.round(comp.duration * fps) - 1;
    }

    // USD aperture/focal = tenths of scene unit.  metersPerUnit = 1, so
    // 0.1 unit = 10 mm → divide physical mm values by 100.
    // AE's "Film Size" is measured horizontally by default, so apertureH
    // matches FILM_WIDTH_MM and apertureV is scaled by comp aspect.
    var MM_TO_USD = 1 / 100;
    var apertureH = FILM_WIDTH_MM * MM_TO_USD;
    var apertureV = FILM_WIDTH_MM * comp.height / comp.width * MM_TO_USD;

    // ── Collect eligible layers ───────────────────────────────────────────
    // Match AE's render-time visibility:
    //   - eyeball off  → exclude
    //   - any layer in the comp is solo'd → exclude non-solo'd layers
    //   - shy/locked   → exported normally (they still render)
    var layerInfos    = [];
    var usedPrimNames = {};

    var anySolo = false;
    for (var s = 1; s <= comp.numLayers; s++) {
        if (comp.layer(s).solo) { anySolo = true; break; }
    }

    for (var idx = 1; idx <= comp.numLayers; idx++) {
        var lyr     = comp.layer(idx);
        var isCam   = (lyr instanceof CameraLayer);
        var isLight = (lyr instanceof LightLayer);
        var isAV3D  = (lyr instanceof AVLayer) && lyr.threeDLayer;

        if (!isCam && !isLight && !isAV3D) continue;
        if (!lyr.enabled)                   continue;  // eyeball off
        if (anySolo && !lyr.solo)           continue;  // solo'd elsewhere → invisible
        if (!chkAll.value && !lyr.selected)  continue;

        var lt        = isLight ? lyr.lightType : null;
        var isSpot    = isLight && (lt === LightType.SPOT);
        var isAmbient = isLight && (lt === LightType.AMBIENT);
        var isSolid   = false;
        // AE solids are FootageItems whose mainSource is a SolidSource —
        // the solid colour and metadata live on the source, not the layer.
        try {
            isSolid = isAV3D && lyr.source && lyr.source.mainSource &&
                      (lyr.source.mainSource instanceof SolidSource);
        } catch (e) {}

        layerInfos.push({
            layer:     lyr,
            isCam:     isCam,
            isLight:   isLight,
            isAV3D:    isAV3D,
            isSpot:    isSpot,
            isAmbient: isAmbient,
            isSolid:   isSolid,
            usdType:   resolveUSDType(isCam, isLight, lt),
            subtype:   resolveSubtype(isCam, isLight, lt, lyr),
            primName:  makePrimName(lyr.name, usedPrimNames)
        });
    }

    if (layerInfos.length === 0) {
        alert("No eligible layers found.\n(3D switch must be on for AVLayers.)");
        return;
    }

    // ── Build parent/child tree (AE parents → nested USD Xforms) ──────────
    // AE's position/rotation/scale are LOCAL to the parent layer when parented,
    // so nesting in USD reproduces world-space correctly without baking.  Layers
    // whose AE parent is not exported (e.g. parented to an audio-only layer)
    // become roots and keep their parent-relative transform — a known limitation.
    var byLayerIndex = {};
    for (var hi = 0; hi < layerInfos.length; hi++) {
        layerInfos[hi].children = [];
        byLayerIndex[layerInfos[hi].layer.index] = layerInfos[hi];
    }
    var roots = [];
    for (var hj = 0; hj < layerInfos.length; hj++) {
        var nfoJ   = layerInfos[hj];
        var pLayer = nfoJ.layer.parent;
        var pNfo   = (pLayer && byLayerIndex[pLayer.index]) ? byLayerIndex[pLayer.index] : null;
        if (pNfo) pNfo.children.push(nfoJ);
        else      roots.push(nfoJ);
    }

    // ── Type helpers ──────────────────────────────────────────────────────
    function resolveUSDType(isCam, isLight, lt) {
        if (isCam)    return "Camera";
        if (!isLight) return "Xform";
        if (lt === LightType.AMBIENT)  return "DomeLight";
        if (lt === LightType.PARALLEL) return "DistantLight";
        return "SphereLight";
    }

    function resolveSubtype(isCam, isLight, lt, layer) {
        if (isCam) return "Camera";
        if (isLight) {
            if (lt === LightType.AMBIENT)  return "Ambient";
            if (lt === LightType.PARALLEL) return "Parallel";
            if (lt === LightType.POINT)    return "Point";
            if (lt === LightType.SPOT)     return "Spot";
            return "Light";
        }
        if (layer.nullLayer) return "Null";
        try { if (layer instanceof ShapeLayer) return "Shape"; } catch (e) {}
        try { if (layer instanceof TextLayer)  return "Text";  } catch (e) {}
        try {
            if (layer.source && layer.source.mainSource &&
                layer.source.mainSource instanceof SolidSource) return "Solid";
        } catch (e) {}
        return "AVLayer";
    }

    function makePrimName(name, used) {
        var n = name.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(n) || n.length === 0) n = '_' + n;
        var base = n, cnt = 2;
        while (used[n]) { n = base + '_' + cnt++; }
        used[n] = true;
        return n;
    }

    // ── Math helpers ──────────────────────────────────────────────────────
    function d2r(d) { return d * Math.PI / 180; }

    function m3mul(a, b) {
        var r = [[0,0,0],[0,0,0],[0,0,0]];
        for (var i = 0; i < 3; i++)
            for (var j = 0; j < 3; j++)
                for (var k = 0; k < 3; k++)
                    r[i][j] += a[i][k] * b[k][j];
        return r;
    }

    function rotX(deg) {
        var c = Math.cos(d2r(deg)), s = Math.sin(d2r(deg));
        return [[1,0,0],[0,c,-s],[0,s,c]];
    }
    function rotY(deg) {
        var c = Math.cos(d2r(deg)), s = Math.sin(d2r(deg));
        return [[c,0,s],[0,1,0],[-s,0,c]];
    }
    function rotZ(deg) {
        var c = Math.cos(d2r(deg)), s = Math.sin(d2r(deg));
        return [[c,-s,0],[s,c,0],[0,0,1]];
    }

    // AE rotation: Orientation (X*Y*Z order) then individual X/Y/Z rotations.
    // Verified empirically by probing AE's rendered camera matrix with
    // toWorld() expressions and comparing to script output: matches AE
    // ground truth to ~1e-4 across all tested frames.  The previous Y*X*Z
    // order was the source of the persistent ~2° rotation drift.
    function aeRotMatrix(ori, xr, yr, zr) {
        var Mo = m3mul(rotX(ori[0]), m3mul(rotY(ori[1]), rotZ(ori[2])));
        var Mi = m3mul(rotZ(zr),    m3mul(rotY(yr),     rotX(xr)));
        return m3mul(Mo, Mi);
    }

    // Look-at matrix for 2-node camera (AE space)
    function vecNorm(v) {
        var l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
        return l < 1e-10 ? [0,0,1] : [v[0]/l, v[1]/l, v[2]/l];
    }
    function vecCross(a, b) {
        return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    }
    function vecDot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

    // Builds the AE rotation matrix that aims +Z toward poi from pos.
    // Must match aeRotMatrix convention: COLUMNS = local axes in AE world space,
    // so that m3mul(lookAtMatrix, aeRotMatrix(ori...)) composes correctly.
    //
    // right   = cross(fwd, worldUp)  — world up in AE = -Y (screen up)
    // upOrtho = cross(fwd, right)    — gives AE local +Y = world +Y (AE down)
    // fwd                            — AE local +Z = look direction
    //
    // Verify: for fwd=(0,0,1) this gives identity, matching aeRotMatrix(0,0,0,0,0,0).
    function lookAtMatrix(pos, poi) {
        var fwd = vecNorm([poi[0]-pos[0], poi[1]-pos[1], poi[2]-pos[2]]);
        var worldUp = [0, -1, 0]; // AE screen-up = world -Y
        if (Math.abs(vecDot(fwd, worldUp)) > 0.999) worldUp = [0, 0, 1];
        var right   = vecNorm(vecCross(fwd, worldUp));
        var upOrtho = vecCross(fwd, right); // AE local +Y = world +Y (down)
        // Store as COLUMNS (local axes in AE world) to match aeRotMatrix
        return [
            [right[0],   upOrtho[0],  fwd[0]],
            [right[1],   upOrtho[1],  fwd[1]],
            [right[2],   upOrtho[2],  fwd[2]]
        ];
    }

    // ── AE → USD rotation  (bilateral conjugation) ─────────────────────────
    // M_usd_row = S · R_ae^T · S,  with S = diag(1, -1, -1).
    // Equivalent to the Euler-level substitution (rx, -ry, -rz) used by the
    // TresSims AE→Houdini importer.  Identity AE → identity USD.
    //
    //   (S · R^T · S)[i][j] = sign(i) · R[j][i] · sign(j)
    //   signs: i/j = 0 → +1,  i/j = 1,2 → −1
    function toUSDMat3(R) {
        return [
            [ R[0][0], -R[1][0], -R[2][0]],
            [-R[0][1],  R[1][1],  R[2][1]],
            [-R[0][2],  R[1][2],  R[2][2]]
        ];
    }

    function readRot(layer, t) {
        var ori=[0,0,0], xr=0, yr=0, zr=0;
        try { ori = layer.orientation.valueAtTime(t, false); } catch(e) {}
        try { xr  = layer.xRotation.valueAtTime(t, false);  } catch(e) {}
        try { yr  = layer.yRotation.valueAtTime(t, false);  } catch(e) {}
        try { zr  = layer.zRotation.valueAtTime(t, false);  } catch(e) {
            try { zr = layer.rotation.valueAtTime(t, false); } catch(e2) {}
        }
        return { ori:ori, xr:xr, yr:yr, zr:zr };
    }

    // Detect 2-node camera via AE's autoOrient flag.  Only cameras with
    // CAMERA_OR_POINT_OF_INTEREST aim at pointOfInterest; 1-node cameras have
    // NO_AUTO_ORIENT (or ALONG_PATH) and use orientation/rotation directly.
    // The earlier pos→POI heuristic mis-flagged translated 1-node cameras
    // because AE keeps pointOfInterest at its default (comp centre) regardless.
    function is2NodeCamera(layer) {
        try { return layer.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST; }
        catch(e) { return false; }
    }

    // 10-decimal format with -0 cleanup; trims trailing zeros for compactness.
    function fmt(n) {
        if (Math.abs(n) < 1e-12) return '0';
        if (Math.abs(n - 1) < 1e-12) return '1';
        if (Math.abs(n + 1) < 1e-12) return '-1';
        var s = n.toFixed(10);
        s = s.replace(/(\.\d*?)0+$/, '$1');
        s = s.replace(/\.$/, '');
        return s;
    }

    // ── Sample all frames ─────────────────────────────────────────────────
    for (var li = 0; li < layerInfos.length; li++) {
        var nfo   = layerInfos[li];
        var layer = nfo.layer;

        // Cameras AND lights use 2-node lookAt math when their autoOrient is
        // CAMERA_OR_POINT_OF_INTEREST.  AE Parallel and Spot lights default to
        // this — they aim from position toward pointOfInterest exactly like
        // 2-node cameras.  Without this, a Parallel light's direction
        // defaults to -Z (USD DistantLight convention) regardless of POI,
        // which breaks shading on import.
        nfo.use2Node = (nfo.isCam || nfo.isLight) ? is2NodeCamera(layer) : false;

        // mS[i] = [frame, m00..m22, tx, ty, tz]  (9 rotation + 3 translation values)
        var mS=[], flS=[], fdS=[], intS=[], colS=[], caS=[], cfS=[];

        for (var frame = startFrame; frame <= endFrame; frame++) {
            var t = frame / fps;

            // Position → USD world translation
            var rawPos = layer.position.valueAtTime(t, false);
            var tx =  rawPos[0] / scale;
            var ty = -(rawPos.length > 1 ? rawPos[1] : 0) / scale;
            var tz = -(rawPos.length > 2 ? rawPos[2] : 0) / scale;

            // Rotation matrix in AE space.
            //
            // 2-node cameras: lookAt(pos, POI) × aeRotMatrix(ori, xr, yr, zr).
            // This is the empirically-best composition we found in testing
            // against AE preview — translations match perfectly and rotation
            // matches to within ~2° at the end of long animations.  Other
            // compositions tried (R × lookAt, lookAt only, R only) were all
            // further off.  The remaining ~2° residual hasn't been root-
            // caused but requires empirical AE-side testing to investigate.
            //
            // 1-node cameras / nulls: aeRotMatrix only.
            var rp = readRot(layer, t);
            var Rae;
            if (nfo.use2Node) {
                var poi = [rawPos[0], rawPos[1], rawPos[2]];
                try { poi = layer.pointOfInterest.valueAtTime(t, false); } catch(e) {}
                Rae = m3mul(lookAtMatrix(rawPos, poi),
                            aeRotMatrix(rp.ori, rp.xr, rp.yr, rp.zr));
            } else {
                Rae = aeRotMatrix(rp.ori, rp.xr, rp.yr, rp.zr);
            }

            // Convert AE (column-vector, left-handed Y-down) → USD
            // (row-vector, right-handed Y-up).  Identity AE → identity USD
            // for every prim type, so grafted Y-up geometry stays Y-up.
            var Rusd = toUSDMat3(Rae);

            // Scale (AVLayers only) — scale columns by sx/sy/sz
            var sx=1, sy=1, sz=1;
            if (nfo.isAV3D) {
                try {
                    var rs = layer.scale.valueAtTime(t, false);
                    sx = rs[0] / 100;
                    sy = rs.length > 1 ? rs[1] / 100 : sx;
                    sz = rs.length > 2 ? rs[2] / 100 : sy;
                } catch(e) {}
            }

            // Build 3×3 with scale baked in (scale columns of rotation matrix)
            mS.push([frame,
                Rusd[0][0]*sx, Rusd[0][1]*sy, Rusd[0][2]*sz,
                Rusd[1][0]*sx, Rusd[1][1]*sy, Rusd[1][2]*sz,
                Rusd[2][0]*sx, Rusd[2][1]*sy, Rusd[2][2]*sz,
                tx, ty, tz
            ]);

            // Camera
            if (nfo.isCam) {
                var zoom = layer.cameraOption.zoom.valueAtTime(t, false);
                flS.push([frame, FILM_WIDTH_MM * zoom / comp.width * MM_TO_USD]);
                try {
                    fdS.push([frame,
                        layer.cameraOption.focusDistance.valueAtTime(t, false) / scale]);
                } catch(e) {}
            }

            // Light
            if (nfo.isLight) {
                // AE intensity is a percentage (100 = "100%").  USD/Karma
                // expects physical-ish units: DomeLight ≈ 1, DistantLight ≈ 5,
                // SphereLight in the 100s+ to overcome inverse-square at
                // typical scene distances.  Scale per type so AE 100% lands
                // in the right ballpark for each:
                var aePct = layer.lightOption.intensity.valueAtTime(t, false);
                var inten;
                switch (nfo.usdType) {
                    case 'DomeLight':    inten = aePct * 0.01; break;  // 100% → 1
                    case 'DistantLight': inten = aePct * 0.05; break;  // 100% → 5
                    case 'SphereLight':  inten = aePct * 1.0;  break;  // 100% → 100
                    default:             inten = aePct * 0.01;
                }
                var col = layer.lightOption.color.valueAtTime(t, false);
                intS.push([frame, inten]);
                colS.push([frame, col[0], col[1], col[2]]);
                if (nfo.isSpot) {
                    try {
                        caS.push([frame,
                            layer.lightOption.coneAngle.valueAtTime(t, false) / 2]);
                        cfS.push([frame,
                            layer.lightOption.coneFeather.valueAtTime(t, false) / 100]);
                    } catch(e) {}
                }
            }
        }

        nfo.mS=mS; nfo.flS=flS; nfo.fdS=fdS;
        nfo.intS=intS; nfo.colS=colS; nfo.caS=caS; nfo.cfS=cfS;
    }

    // ── Build USD ASCII document ──────────────────────────────────────────
    var I1 = "    ";
    var I2 = "        ";
    var I3 = "            ";
    var out = [];

    // #usda 1.0 MUST be the very first line — no comments before it
    out.push('#usda 1.0');
    out.push('(');
    out.push(I1 + 'defaultPrim = "AE_Scene"');
    out.push(I1 + 'upAxis = "Y"');
    out.push(I1 + 'metersPerUnit = 1');
    out.push(I1 + 'framesPerSecond = ' + fps);
    out.push(I1 + 'timeCodesPerSecond = ' + fps);
    out.push(I1 + 'startTimeCode = ' + startFrame);
    out.push(I1 + 'endTimeCode = ' + endFrame);
    out.push(')');
    out.push('');
    out.push('# AE to Houdini USD Export');
    out.push('# Comp: ' + comp.name + '  Frames: ' + startFrame + '-' + endFrame + '  @ ' + fps + ' fps');
    out.push('# Scale: 1 AE px = ' + (1/scale).toFixed(6) + ' unit' +
             '  Aperture: ' + apertureH.toFixed(4) + ' x ' + apertureV.toFixed(4) + ' mm');
    out.push('');

    out.push('def Xform "AE_Scene" (');
    out.push(I1 + 'kind = "group"');
    out.push(')');
    out.push('{');

    // Optional comp-centre offset: shift origin from comp top-left to comp
    // centre, matching C4D's AE-roundtrip convention.
    if (centerOffset) {
        var cx = (-comp.width  / 2) / scale;
        var cy = ( comp.height / 2) / scale;
        out.push(I1 + 'double3 xformOp:translate = (' + fmt(cx) + ', ' + fmt(cy) + ', 0)');
        out.push(I1 + 'uniform token[] xformOpOrder = ["xformOp:translate"]');
    }

    for (var ri = 0; ri < roots.length; ri++) {
        out.push('');
        writePrim(roots[ri], I1);
    }

    out.push('}');
    out.push('');

    // ── Write file ────────────────────────────────────────────────────────
    // ExtendScript writeln() uses CR-only on Mac regardless of lineFeed setting.
    // Write the entire file as one string with explicit LF characters (\u000A).
    var content = out.join('\u000A') + '\u000A';
    outFile.encoding = "binary";
    outFile.open("w");
    outFile.write(content);
    outFile.close();

    // ── Success confirmation ──────────────────────────────────────────────
    var nCams=0, nLights=0, nXforms=0, nParented=0;
    for (var ci2 = 0; ci2 < layerInfos.length; ci2++) {
        if (layerInfos[ci2].isCam)        nCams++;
        else if (layerInfos[ci2].isLight) nLights++;
        else                              nXforms++;
        if (layerInfos[ci2].layer.parent) nParented++;
    }
    var nFrames = endFrame - startFrame + 1;
    var summary =
        "Exported " + layerInfos.length + " prims  (" +
        nCams + " cam, " + nLights + " light, " + nXforms + " xform; " +
        nParented + " parented)\n" +
        "Frames: " + startFrame + "–" + endFrame + "  (" + nFrames + ")\n" +
        outPath;

    var doneDlg = new Window("dialog", "Export complete");
    doneDlg.alignChildren = ["fill", "top"];
    doneDlg.margins = 16;
    doneDlg.spacing = 12;
    var msg = doneDlg.add("statictext", undefined, summary, { multiline: true });
    msg.preferredSize.width = 460;
    var grpDoneBtns = doneDlg.add("group");
    grpDoneBtns.alignment = "right";
    var btnReveal = grpDoneBtns.add("button", undefined, "Reveal in Finder");
    var btnOpen   = grpDoneBtns.add("button", undefined, "Open .usda");
    var btnDone   = grpDoneBtns.add("button", undefined, "Done");
    btnReveal.onClick = function () { try { outFile.parent.execute(); } catch (e) {} };
    btnOpen.onClick   = function () { try { outFile.execute();        } catch (e) {} };
    btnDone.onClick   = function () { doneDlg.close(); };
    doneDlg.show();

    // ── USD writer helpers ────────────────────────────────────────────────

    // Recursive prim writer — emits a `def` block at the given indent and
    // recurses into nfo.children with one extra level of indentation.
    function writePrim(nfo, ind) {
        var ind2 = ind + I1;

        var camNote = nfo.isCam
            ? '  cam:' + (nfo.use2Node ? '2-node' : '1-node') + '(auto)' : '';
        if (nfo.isSpot) {
            out.push(ind + 'def ' + nfo.usdType + ' "' + nfo.primName + '" (');
            out.push(ind2 + 'prepend apiSchemas = ["ShapingAPI"]');
            out.push(ind2 + 'doc = "' + esc(nfo.layer.name) + '  [' + nfo.subtype + camNote + ']"');
            out.push(ind + ')');
        } else {
            out.push(ind + 'def ' + nfo.usdType + ' "' + nfo.primName + '" (');
            out.push(ind2 + 'doc = "' + esc(nfo.layer.name) + '  [' + nfo.subtype + camNote + ']"');
            out.push(ind + ')');
        }
        out.push(ind + '{');

        if (nfo.isCam) {
            out.push(ind2 + 'token projection = "perspective"');
            out.push(ind2 + 'float horizontalAperture = ' + apertureH.toFixed(6));
            out.push(ind2 + 'float verticalAperture = '   + apertureV.toFixed(6));
            out.push(ind2 + 'float2 clippingRange = (' + clipNear + ', ' + clipFar + ')');
            out.push(ind2 + 'float horizontalApertureOffset = 0');
            out.push(ind2 + 'float verticalApertureOffset = 0');
            writeScalar(out, ind2, 'float', 'focalLength',   nfo.flS);
            if (nfo.fdS.length) writeScalar(out, ind2, 'float', 'focusDistance', nfo.fdS);
        }

        if (nfo.isLight) {
            writeScalar(out, ind2, 'float',   'inputs:intensity', nfo.intS);
            writeTuple3(out, ind2, 'color3f', 'inputs:color',     nfo.colS);
            if (nfo.usdType === 'SphereLight') {
                out.push(ind2 + 'float inputs:radius = 0');
                out.push(ind2 + 'bool inputs:treatAsPoint = 1');
            }
            if (nfo.isSpot && nfo.caS.length) {
                writeScalar(out, ind2, 'float', 'inputs:shaping:cone:angle',    nfo.caS);
                writeScalar(out, ind2, 'float', 'inputs:shaping:cone:softness', nfo.cfS);
            }
            if (nfo.usdType === 'DistantLight') {
                out.push(ind2 + 'float inputs:angle = 0.53');
            }
        }

        if (!nfo.isAmbient) writeMat4(out, ind2, nfo.mS);

        // Solid → emit a flat quad Mesh inside the Xform so the layer shows
        // up as actual geometry in Houdini.  Coordinates are in AE pixels
        // local to the layer, scaled to USD units and Y-flipped, with the
        // anchor point treated as the local origin (so rotation pivots
        // correctly around AE's anchor).  doubleSided so both sides render
        // — AE solids are flat 2D layers without a defined back face.
        if (nfo.isSolid) writeSolidGeo(out, ind2, nfo);

        for (var ci = 0; ci < nfo.children.length; ci++) {
            out.push('');
            writePrim(nfo.children[ci], ind2);
        }

        out.push(ind + '}');
    }

    function writeSolidGeo(arr, ind, nfo) {
        // FootageItem.width/height for dimensions; SolidSource (mainSource)
        // owns the colour.
        var src = nfo.layer.source;
        var w = src.width, h = src.height;
        var c = [0.5, 0.5, 0.5];
        try { c = src.mainSource.color || c; } catch (e) {}
        var anchor = [w/2, h/2, 0];   // default = centred
        try { anchor = nfo.layer.anchorPoint.value; } catch (e) {}

        // Corners in AE-layer-local pixels (top-left of layer is (0,0,0)),
        // shifted so anchor sits at origin.
        var tl = [0 - anchor[0], 0 - anchor[1], 0];
        var tr = [w - anchor[0], 0 - anchor[1], 0];
        var br = [w - anchor[0], h - anchor[1], 0];
        var bl = [0 - anchor[0], h - anchor[1], 0];

        // AE → USD: x stays, Y flips, /scale.  Z is 0 anyway so its sign
        // flip doesn't matter.  CCW order from +Z (USD camera-facing side):
        // BL, BR, TR, TL.
        function toUsd(p) {
            return '(' + fmt(p[0] / scale) + ', ' + fmt(-p[1] / scale) + ', 0)';
        }
        var ind2 = ind + I1;
        arr.push(ind + 'def Mesh "geo"');
        arr.push(ind + '{');
        arr.push(ind2 + 'point3f[] points = [' +
            toUsd(bl) + ', ' + toUsd(br) + ', ' + toUsd(tr) + ', ' + toUsd(tl) + ']');
        arr.push(ind2 + 'int[] faceVertexCounts = [4]');
        arr.push(ind2 + 'int[] faceVertexIndices = [0, 1, 2, 3]');
        arr.push(ind2 + 'bool doubleSided = 1');
        arr.push(ind2 + 'color3f[] primvars:displayColor = [(' +
            fmt(c[0]) + ', ' + fmt(c[1]) + ', ' + fmt(c[2]) + ')]');
        arr.push(ind + '}');
    }

    // True iff every sample's data (indices 1..dim) matches sample[0] within ε.
    // samples row layout: [frame, v1, v2, ..., vDim].
    function isStaticSamples(samples, dim) {
        if (!samples || samples.length <= 1) return true;
        var first = samples[0];
        for (var i = 1; i < samples.length; i++) {
            for (var k = 1; k <= dim; k++) {
                if (Math.abs(first[k] - samples[i][k]) > 1e-9) return false;
            }
        }
        return true;
    }

    function sampleEq(a, b, dim) {
        for (var k = 1; k <= dim; k++) {
            if (Math.abs(a[k] - b[k]) > 1e-9) return false;
        }
        return true;
    }

    // Drop interior of consecutive-equal runs.  Preserves first/last of each
    // run so USD's linear interp stays constant across the held region — and
    // any transition is bounded by adjacent unequal keys, so motion is exact.
    // Reduces "61 keys all the same" to "2 keys", and held-then-jump animations
    // from 61 to ~5 keys.
    function dedupSamples(samples, dim) {
        if (!samples || samples.length <= 2) return samples;
        var out = [samples[0]];
        for (var i = 1; i < samples.length - 1; i++) {
            if (!sampleEq(samples[i], samples[i-1], dim) ||
                !sampleEq(samples[i], samples[i+1], dim)) {
                out.push(samples[i]);
            }
        }
        out.push(samples[samples.length - 1]);
        return out;
    }

    // True if the rotation+scale 3×3 portion of a sample is the identity.
    function isPureTranslate(s) {
        return Math.abs(s[1] - 1) < 1e-9 && Math.abs(s[2])     < 1e-9 && Math.abs(s[3])     < 1e-9 &&
               Math.abs(s[4])     < 1e-9 && Math.abs(s[5] - 1) < 1e-9 && Math.abs(s[6])     < 1e-9 &&
               Math.abs(s[7])     < 1e-9 && Math.abs(s[8])     < 1e-9 && Math.abs(s[9] - 1) < 1e-9;
    }

    // Write the prim's transform — picks the most compact valid form:
    //   pure translate, static  → xformOp:translate
    //   has rotation, static    → matrix4d xformOp:transform (single value)
    //   animated                → matrix4d xformOp:transform.timeSamples
    // Also emits the matching xformOpOrder line.
    // Sample row: [frame, r00,r01,r02, r10,r11,r12, r20,r21,r22, tx,ty,tz]
    function writeMat4(arr, ind, samples) {
        if (!samples || !samples.length) return;
        function rowStr(s) {
            return '( ' +
                '(' + fmt(s[1])  + ', ' + fmt(s[2])  + ', ' + fmt(s[3])  + ', 0), ' +
                '(' + fmt(s[4])  + ', ' + fmt(s[5])  + ', ' + fmt(s[6])  + ', 0), ' +
                '(' + fmt(s[7])  + ', ' + fmt(s[8])  + ', ' + fmt(s[9])  + ', 0), ' +
                '(' + fmt(s[10]) + ', ' + fmt(s[11]) + ', ' + fmt(s[12]) + ', 1) )';
        }
        var isStatic = isStaticSamples(samples, 12);
        var opName;
        if (isStatic && isPureTranslate(samples[0])) {
            var s = samples[0];
            arr.push(ind + 'double3 xformOp:translate = (' +
                fmt(s[10]) + ', ' + fmt(s[11]) + ', ' + fmt(s[12]) + ')');
            opName = 'xformOp:translate';
        } else if (isStatic) {
            arr.push(ind + 'matrix4d xformOp:transform = ' + rowStr(samples[0]));
            opName = 'xformOp:transform';
        } else {
            var keys = dedupSamples(samples, 12);
            arr.push(ind + 'matrix4d xformOp:transform.timeSamples = {');
            for (var i = 0; i < keys.length; i++) {
                arr.push(ind + '    ' + keys[i][0] + ': ' + rowStr(keys[i]) + ',');
            }
            arr.push(ind + '}');
            opName = 'xformOp:transform';
        }
        arr.push(ind + 'uniform token[] xformOpOrder = ["' + opName + '"]');
    }

    function writeScalar(arr, ind, type, name, samples) {
        if (!samples || !samples.length) return;
        if (isStaticSamples(samples, 1)) {
            arr.push(ind + type + ' ' + name + ' = ' + fmt6(samples[0][1]));
        } else {
            var keys = dedupSamples(samples, 1);
            arr.push(ind + type + ' ' + name + '.timeSamples = {');
            for (var i = 0; i < keys.length; i++)
                arr.push(ind + '    ' + keys[i][0] + ': ' + fmt6(keys[i][1]) + ',');
            arr.push(ind + '}');
        }
    }

    function writeTuple3(arr, ind, type, name, samples) {
        if (!samples || !samples.length) return;
        function tupleStr(s) {
            return '(' + fmt6(s[1]) + ', ' + fmt6(s[2]) + ', ' + fmt6(s[3]) + ')';
        }
        if (isStaticSamples(samples, 3)) {
            arr.push(ind + type + ' ' + name + ' = ' + tupleStr(samples[0]));
        } else {
            var keys = dedupSamples(samples, 3);
            arr.push(ind + type + ' ' + name + '.timeSamples = {');
            for (var i = 0; i < keys.length; i++)
                arr.push(ind + '    ' + keys[i][0] + ': ' + tupleStr(keys[i]) + ',');
            arr.push(ind + '}');
        }
    }

    // 6-decimal format with -0 cleanup for camera/light/colour values.
    function fmt6(n) {
        if (Math.abs(n) < 1e-9) return '0';
        return (+n.toFixed(6)).toString();
    }

    function esc(s) {
        return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

})();
