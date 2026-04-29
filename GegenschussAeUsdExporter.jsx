/**
 * AE → Houdini USD Exporter
 *
 * Exports AE Camera, Lights, and 3D layers to a USD ASCII file.  The
 * AE↔USD coordinate conversion is fully determined by the constraint
 * "identity AE rotation must map to identity USD rotation" combined with
 * the AE (left-handed, Y-down) → USD (right-handed, Y-up) basis change:
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
    // size isn't exposed via scripting, so we ask the user via the export
    // dialog (default 36; common alternates: APS-C ≈ 24, S35 ≈ 25).
    var FILM_WIDTH_MM = 36;   // overridden from dialog below
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

    // Layer-type detection.  AE's `instanceof TextLayer` / `instanceof
    // ShapeLayer` is unreliable across versions, and matchName alone can
    // miss some cases.  Try every stable identifier we can think of and
    // accept ANY positive signal.
    function isTextLayer(l) {
        if (!l) return false;
        var mn;
        try { mn = l.matchName; } catch (e) {}
        if (mn === "ADBE Text Layer") return true;
        try { if (l instanceof TextLayer) return true; } catch (e) {}
        try { if (l.text) return true; } catch (e) {}                                  // .text exists
        try { if (l.property("ADBE Text Properties") != null) return true; } catch (e) {}
        try { if (l.property("Text") != null) return true; } catch (e) {}
        return false;
    }
    function isShapeLayer(l) {
        if (!l) return false;
        var mn;
        try { mn = l.matchName; } catch (e) {}
        if (mn === "ADBE Vector Layer") return true;
        try { if (l instanceof ShapeLayer) return true; } catch (e) {}
        try { if (l.property("ADBE Root Vectors Group") != null) return true; } catch (e) {}
        try {
            var c = l.property("Contents");
            if (c && typeof c.numProperties === "number") return true;
        } catch (e) {}
        return false;
    }

    // ── Versioned backup helper ───────────────────────────────────────────
    // Called once before any destructive AE-side change (2D-to-3D
    // conversion, shape-layer split).  Uses AE's "Increment and Save" so
    // the original .aep is preserved alongside an incremented copy that
    // becomes the active project; falls back to a manual file copy if the
    // menu command can't be found, and returns false if neither path is
    // available (e.g. the project hasn't been saved yet).
    var didBackup = false;
    function ensureBackup() {
        if (didBackup) return true;
        if (!app.project.file) {
            // Untitled project — no .aep to back up.  Warn but let the
            // user choose to proceed; Cmd-Z is still available.
            var ok = confirm(
                "The project hasn't been saved yet, so no versioned " +
                "backup can be made.\n\nProceed anyway?  Cmd-Z will " +
                "undo any layer changes the export makes.", false);
            didBackup = ok;
            return ok;
        }
        try {
            var cmdId = app.findMenuCommandId("Increment and Save");
            if (cmdId) {
                app.executeCommand(cmdId);
                didBackup = true;
                return true;
            }
        } catch (e) {}
        // Fallback: copy the .aep with a timestamp suffix
        try {
            var src = app.project.file;
            var ts  = new Date();
            var pad = function (n) { return ("0" + n).slice(-2); };
            var stamp = ts.getFullYear() + pad(ts.getMonth() + 1) +
                        pad(ts.getDate()) + "_" + pad(ts.getHours()) +
                        pad(ts.getMinutes()) + pad(ts.getSeconds());
            var dst = new File(src.fsName.replace(/\.aep$/i,
                "_pre-usd-export_" + stamp + ".aep"));
            if (src.copy(dst)) {
                didBackup = true;
                return true;
            }
        } catch (e) {}
        return false;
    }

    // ── Dialog ────────────────────────────────────────────────────────────
    var BUILD_DATE = "260429ag";  // bump on each meaningful change (YYMMDD)
    var dlg = new Window("dialog", "AE → Houdini USD Exporter");
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.spacing = 12;
    dlg.margins = 18;

    // ── Logo + build date (matches the other Gegenschuss AE panels) ────
    // Logo PNG sits next to this script.  When the file is missing (script
    // moved without copying the asset) the brand column still shows.
    var logoRow = dlg.add("group");
    logoRow.orientation = "row";
    logoRow.alignment   = ["center", "top"];
    logoRow.spacing     = 10;
    logoRow.margins     = [0, 4, 0, 4];
    try {
        var logoFile = new File((new File($.fileName)).parent.fsName + "/Gegenschuss.png");
        if (logoFile.exists) {
            var logoImg = logoRow.add("image", undefined, logoFile);
            logoImg.alignment = ["left", "center"];
        }
    } catch (e) {}
    var brandCol = logoRow.add("group");
    brandCol.orientation = "column";
    brandCol.alignment   = ["left", "center"];
    brandCol.spacing     = 2;
    var buildLbl = brandCol.add("statictext", undefined, BUILD_DATE);
    buildLbl.graphics.font = ScriptUI.newFont("Helvetica", "REGULAR", 11);
    buildLbl.graphics.foregroundColor =
        buildLbl.graphics.newPen(buildLbl.graphics.PenType.SOLID_COLOR, [0.55, 0.55, 0.55, 1], 1);
    var ghLbl = brandCol.add("statictext", undefined, "github.com/");
    ghLbl.graphics.font = ScriptUI.newFont("Helvetica", "REGULAR", 10);
    ghLbl.graphics.foregroundColor =
        ghLbl.graphics.newPen(ghLbl.graphics.PenType.SOLID_COLOR, [0.4, 0.4, 0.4, 1], 1);
    var ghName = brandCol.add("statictext", undefined, "Gegenschuss");
    ghName.graphics.font = ScriptUI.newFont("Helvetica", "REGULAR", 10);
    ghName.graphics.foregroundColor =
        ghName.graphics.newPen(ghName.graphics.PenType.SOLID_COLOR, [0.4, 0.4, 0.4, 1], 1);

    dlg.add("panel");

    // Comp + layer breakdown summary.
    var nCams = 0, nLights = 0, nNulls = 0, nSolids = 0, nFootage = 0,
        nText = 0, nShape = 0, nOther = 0;
    var n2DText = 0, n2DShape = 0;   // 2D layers users typically want exported
    for (var ic = 1; ic <= comp.numLayers; ic++) {
        var lyrC = comp.layer(ic);
        if (lyrC instanceof CameraLayer) { nCams++; continue; }
        if (lyrC instanceof LightLayer)  { nLights++; continue; }
        // Don't gate on `instanceof AVLayer` — that's been seen to fail
        // for genuine AVLayers in some AE versions.  Anything that isn't
        // a camera or light is treated as a potential AVLayer.
        var is3D = false;
        try { is3D = !!lyrC.threeDLayer; } catch (e) {}
        if (is3D) {
            var isNull3D = false;
            try { isNull3D = !!lyrC.nullLayer; } catch (e) {}
            if (isNull3D)              { nNulls++;   continue; }
            if (isTextLayer(lyrC))     { nText++;    continue; }
            if (isShapeLayer(lyrC))    { nShape++;   continue; }
            try {
                if (lyrC.source && lyrC.source.mainSource) {
                    if (lyrC.source.mainSource instanceof SolidSource) { nSolids++;  continue; }
                    if (lyrC.source.mainSource instanceof FileSource)  { nFootage++; continue; }
                }
            } catch (e) {}
            nOther++;
        } else {
            // 2D layer — flag text/shape as commonly-intended-for-3D so the
            // summary shows them even before the user flips the 3D switch
            // or selects them for the preflight.
            if      (isTextLayer(lyrC))  n2DText++;
            else if (isShapeLayer(lyrC)) n2DShape++;
        }
    }
    var compFps    = Math.round(comp.frameRate * 1000) / 1000;
    var compFrames = Math.round(comp.duration  * comp.frameRate);
    var par        = comp.pixelAspect;
    var resStr     = comp.width + " × " + comp.height +
                     (par !== 1 ? "  (PAR " + par + ")" : "");
    var compInfo   = comp.name + "  ·  " + resStr + "  ·  " +
                     compFps + " fps  ·  " + compFrames + " frames";

    var parts = [];
    if (nCams)    parts.push(nCams    + " cam");
    if (nLights)  parts.push(nLights  + " light");
    if (nNulls)   parts.push(nNulls   + " null");
    if (nSolids)  parts.push(nSolids  + " solid");
    if (nFootage) parts.push(nFootage + " footage");
    if (nText)    parts.push(nText    + " text");
    if (nShape)   parts.push(nShape   + " shape");
    if (nOther)   parts.push(nOther   + " xform");
    var layerInfo = parts.length ? parts.join("  ·  ") : "(no eligible 3D layers)";

    var twoDParts = [];
    if (n2DText)  twoDParts.push(n2DText  + " text");
    if (n2DShape) twoDParts.push(n2DShape + " shape");
    var twoDInfo = twoDParts.length
        ? "+ " + twoDParts.join("  ·  ") + " in 2D (select & re-run to include)"
        : "";

    dlg.add("statictext", undefined, compInfo);
    dlg.add("statictext", undefined, layerInfo);
    if (twoDInfo) dlg.add("statictext", undefined, twoDInfo);
    dlg.add("panel");

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

    // Film width \u2014 AE's filmSize isn't scriptable, so users with non-default
    // film backs (APS-C / S35 / etc.) override here.  Default 36mm matches
    // AE's CameraSettings default (Film Size = 36 mm, measured horizontally).
    var grpRow2 = dlg.add("group");
    grpRow2.alignChildren = ["left", "center"];
    grpRow2.add("statictext", undefined, "Film width");
    var filmInput = grpRow2.add("edittext", undefined, loadPref("filmWidth", "36"));
    filmInput.preferredSize.width = 50;
    grpRow2.add("statictext", undefined, "mm   (36 = full-frame, 24 \u2248 APS-C, 25 \u2248 S35)");

    // Hint \u2014 AE's filmSize isn't exposed via scripting; the values above are
    // matched against the AE Camera Settings default.  Mismatched film width
    // throws focal length / aperture off, so leave it alone unless you know
    // your project uses a non-default sensor back.
    var hintWarn = dlg.add("statictext", undefined,
        "Don't change the values above unless you know what you're doing \u2014 they match AE's CameraSettings defaults.",
        { multiline: true });
    hintWarn.preferredSize.width = 460;
    hintWarn.graphics.font = ScriptUI.newFont("Helvetica", "ITALIC", 10);
    hintWarn.graphics.foregroundColor =
        hintWarn.graphics.newPen(hintWarn.graphics.PenType.SOLID_COLOR, [0.55, 0.55, 0.55, 1], 1);

    dlg.add("panel");

    // Frame range inline
    var grpRange = dlg.add("group");
    grpRange.alignChildren = ["left", "center"];
    grpRange.add("statictext", undefined, "Frames");
    var rbSingle = grpRange.add("radiobutton", undefined, "Current");
    var rbWork   = grpRange.add("radiobutton", undefined, "Work area");
    var rbFull   = grpRange.add("radiobutton", undefined, "Full comp");
    var savedRange = loadPref("frameRange", "full");
    rbSingle.value = (savedRange === "single");
    rbWork.value   = (savedRange === "work");
    rbFull.value   = (savedRange === "full");

    var chkVisible = dlg.add("checkbox", undefined, "Visible only");
    chkVisible.value = (loadPref("visibleOnly", "1") === "1");

    // Per-type animation-path checkboxes — emit a sibling BasisCurves
    // trajectory for each animated layer of the chosen kind.  All default
    // off; user opts in per type when paths are wanted.
    var grpPaths = dlg.add("group");
    grpPaths.alignChildren = ["left", "center"];
    grpPaths.add("statictext", undefined, "Animation paths:");
    var chkPathCam   = grpPaths.add("checkbox", undefined, "Cameras");
    var chkPathLight = grpPaths.add("checkbox", undefined, "Lights");
    var chkPathNull  = grpPaths.add("checkbox", undefined, "Nulls");
    var chkPathAV    = grpPaths.add("checkbox", undefined, "AV layers");
    chkPathCam  .value = (loadPref("pathsCam",   "0") === "1");
    chkPathLight.value = (loadPref("pathsLight", "0") === "1");
    chkPathNull .value = (loadPref("pathsNull",  "0") === "1");
    chkPathAV   .value = (loadPref("pathsAV",    "0") === "1");

    var grpBtns = dlg.add("group");
    grpBtns.alignment = ["fill", "top"];
    var btnReset = grpBtns.add("button", undefined, "Reset");
    btnReset.alignment = ["left", "center"];
    var spacer = grpBtns.add("group");
    spacer.alignment = ["fill", "fill"];
    var btnCancel = grpBtns.add("button", undefined, "Cancel");
    btnCancel.alignment = ["right", "center"];
    var btnSave   = grpBtns.add("button", undefined, "Save\u2026");
    btnSave.alignment   = ["right", "center"];

    btnReset.onClick = function () {
        scaleInput.text   = "100";
        nearInput.text    = "0.1";
        farInput.text     = "100000";
        filmInput.text    = "36";
        rbSingle.value    = false;
        rbWork.value      = false;
        rbFull.value      = true;
        chkVisible.value  = true;
        chkPathCam.value   = false;
        chkPathLight.value = false;
        chkPathNull.value  = false;
        chkPathAV.value    = false;
    };

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

    var scale         = parseFloat(scaleInput.text) || 100;
    var clipNear      = parseFloat(nearInput.text)  || 0.1;
    var clipFar       = parseFloat(farInput.text)   || 100000;
    FILM_WIDTH_MM     = parseFloat(filmInput.text)  || 36;
    var centerOffset  = true;                  // always centre comp at world origin
    var visibleOnly   = chkVisible.value;
    var emitPathCam   = chkPathCam.value;
    var emitPathLight = chkPathLight.value;
    var emitPathNull  = chkPathNull.value;
    var emitPathAV    = chkPathAV.value;

    // Persist for next run.
    savePref("scale",       scaleInput.text);
    savePref("clipNear",    nearInput.text);
    savePref("clipFar",     farInput.text);
    savePref("filmWidth",   filmInput.text);
    savePref("frameRange",  rbSingle.value ? "single" : (rbFull.value ? "full" : "work"));
    savePref("visibleOnly", chkVisible.value  ? "1" : "0");
    savePref("pathsCam",    chkPathCam.value  ? "1" : "0");
    savePref("pathsLight",  chkPathLight.value ? "1" : "0");
    savePref("pathsNull",   chkPathNull.value  ? "1" : "0");
    savePref("pathsAV",     chkPathAV.value    ? "1" : "0");

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
        // Don't gate on `instanceof AVLayer` — see counter loop above.
        var isAV3D = false;
        if (!isCam && !isLight) {
            try { isAV3D = !!lyr.threeDLayer; } catch (e) {}
        }

        if (!isCam && !isLight && !isAV3D) continue;
        if (visibleOnly && !lyr.enabled)         continue;  // eyeball off
        if (visibleOnly && anySolo && !lyr.solo) continue;  // solo'd elsewhere

        var lt        = isLight ? lyr.lightType : null;
        var isSpot    = isLight && (lt === LightType.SPOT);
        var isAmbient = isLight && (lt === LightType.AMBIENT);
        var isSolid   = false;
        var isFootage = false;
        var isText    = false;
        var isShape   = false;
        // Detect AVLayer subtypes so writePrim can emit the right kind of
        // geometry: solids → coloured quad, footage → textured quad,
        // text/shape → bounding-box quad with a representative colour.
        // CRITICAL: AE null layers use a SolidSource internally, so the
        // SolidSource check must be guarded by !nullLayer or every null
        // gets a Mesh.  Same for the text/shape branches — null layers
        // shouldn't be classified as anything but null.
        try {
            if (isAV3D && !lyr.nullLayer) {
                isText  = isTextLayer(lyr);
                isShape = isShapeLayer(lyr);
                if (!isText && !isShape && lyr.source && lyr.source.mainSource) {
                    isSolid   = (lyr.source.mainSource instanceof SolidSource);
                    isFootage = (lyr.source.mainSource instanceof FileSource);
                }
            }
        } catch (e) {}

        layerInfos.push({
            layer:     lyr,
            isCam:     isCam,
            isLight:   isLight,
            isAV3D:    isAV3D,
            isSpot:    isSpot,
            isAmbient: isAmbient,
            isSolid:   isSolid,
            isFootage: isFootage,
            isText:    isText,
            isShape:   isShape,
            usdType:   resolveUSDType(isCam, isLight, lt),
            subtype:   resolveSubtype(isCam, isLight, lt, lyr),
            primName:  makePrimName(lyr.name, usedPrimNames)
        });
    }

    // ── Preflight: 2D AVLayers to convert ────────────────────────────────
    // Two ways a 2D layer ends up here:
    //   1. It's the parent of an exported 3D camera/light/AVLayer — the
    //      child can't compose its transform through a non-3D parent.
    //   2. It's selected in the timeline.  This is how users opt 2D text /
    //      shape / solid / footage layers into the export — flip the 3D
    //      switch on demand instead of having to do it manually first.
    var twoDByIdx = {};
    var twoDList  = [];
    function addTwoD(p, childName) {
        // p must be a non-camera, non-light, non-3D, enabled layer.
        if (!p) return;
        if (p instanceof CameraLayer || p instanceof LightLayer) return;
        var threeD;
        try { threeD = !!p.threeDLayer; } catch (e) { return; }
        if (threeD) return;
        try { if (!p.enabled) return; } catch (e) { return; }
        if (!twoDByIdx[p.index]) {
            var entry = { layer: p, children: [], selected: false };
            twoDByIdx[p.index] = entry;
            twoDList.push(entry);
        }
        if (childName) twoDByIdx[p.index].children.push(childName);
        try { if (p.selected) twoDByIdx[p.index].selected = true; } catch (e) {}
    }
    // 2D parents of existing 3D layers
    for (var pi = 0; pi < layerInfos.length; pi++) {
        addTwoD(layerInfos[pi].layer.parent, layerInfos[pi].layer.name);
    }
    // Selected non-3D layers — user-picked candidates
    for (var si = 1; si <= comp.numLayers; si++) {
        var sl = comp.layer(si);
        var slIsCam = (sl instanceof CameraLayer);
        var slIsLight = (sl instanceof LightLayer);
        if (slIsCam || slIsLight) continue;
        var sl3D = false;
        try { sl3D = !!sl.threeDLayer; } catch (e) {}
        var slEn = false;
        try { slEn = !!sl.enabled; } catch (e) {}
        var slSel = false;
        try { slSel = !!sl.selected; } catch (e) {}
        if (!sl3D && slEn && slSel) addTwoD(sl, null);
    }

    if (twoDList.length > 0) {
        var preDlg = new Window("dialog", "Preflight  ·  2D layers");
        preDlg.orientation = "column";
        preDlg.alignChildren = ["fill", "top"];
        preDlg.spacing = 8;
        preDlg.margins = 14;

        preDlg.add("statictext", undefined,
            twoDList.length + " 2D layer" + (twoDList.length === 1 ? "" : "s") +
            " ready to flip to 3D:");

        var lb = preDlg.add("listbox", undefined, [],
            { multiselect: false, numberOfColumns: 2,
              showHeaders: true, columnTitles: ["2D layer", "Why"],
              columnWidths: [220, 460] });
        lb.preferredSize.width = 700;
        lb.preferredSize.height = Math.max(180, Math.min(360, 32 + twoDList.length * 22));
        for (var ti = 0; ti < twoDList.length; ti++) {
            var entryT = twoDList[ti];
            var item = lb.add("item", entryT.layer.name);
            var why = [];
            if (entryT.selected) why.push("selected");
            if (entryT.children.length) why.push("parent of " + entryT.children.join(", "));
            item.subItems[0].text = why.join("  ·  ");
        }

        var note = preDlg.add("statictext", undefined,
            "3D switch is off on these layers — flip them to 3D and " +
            "include them in the export?", { multiline: true });
        note.preferredSize.width = 700;

        var btnGrp = preDlg.add("group");
        btnGrp.alignment = "right";
        var btnConvert = btnGrp.add("button", undefined, "Convert & Continue");
        var btnPreCancel = btnGrp.add("button", undefined, "Cancel");

        var preProceed = false;
        btnConvert.onClick   = function () { preProceed = true;  preDlg.close(); };
        btnPreCancel.onClick = function () { preProceed = false; preDlg.close(); };

        preDlg.show();
        if (!preProceed) return;
        if (!ensureBackup()) return;
        app.beginUndoGroup("AE USD Exporter — flip 2D layers to 3D");
        for (var ci3 = 0; ci3 < twoDList.length; ci3++) {
            var pl = twoDList[ci3].layer;
            try { pl.threeDLayer = true; } catch (e) {}
            // Re-detect the AVLayer subtype now that it's 3D, so the
            // mesh writer picks the right kind of geometry.
            var pIsText  = isTextLayer(pl);
            var pIsShape = isShapeLayer(pl);
            var pIsSolid = false, pIsFootage = false;
            try {
                if (!pIsText && !pIsShape && pl.source && pl.source.mainSource) {
                    pIsSolid   = (pl.source.mainSource instanceof SolidSource);
                    pIsFootage = (pl.source.mainSource instanceof FileSource);
                }
            } catch (e) {}
            var pSubtype = pl.nullLayer ? "Null" :
                           pIsText      ? "Text" :
                           pIsShape     ? "Shape" :
                           pIsSolid     ? "Solid" :
                           pIsFootage   ? "Footage" : "AVLayer";
            layerInfos.push({
                layer:     pl,
                isCam:     false,
                isLight:   false,
                isAV3D:    true,
                isSpot:    false,
                isAmbient: false,
                isSolid:   pIsSolid,
                isFootage: pIsFootage,
                isText:    pIsText,
                isShape:   pIsShape,
                usdType:   "Xform",
                subtype:   pSubtype,
                primName:  makePrimName(pl.name, usedPrimNames)
            });
        }
        app.endUndoGroup();
    }

    // ── Preflight: shape layers with multiple shape groups ───────────────
    // USD wants one mesh per Xform.  An AE shape layer can hold many
    // top-level shape Groups under "Contents".  Offer to split those
    // into separate ShapeLayers (one shape each) before export.
    var multiShapeList = [];
    for (var msi = 0; msi < layerInfos.length; msi++) {
        if (!layerInfos[msi].isShape) continue;
        var msContents;
        try { msContents = layerInfos[msi].layer.property("Contents"); }
        catch (e) { continue; }
        if (!msContents || typeof msContents.numProperties !== "number") continue;
        var msGroups = [];
        for (var msj = 1; msj <= msContents.numProperties; msj++) {
            var msp = msContents.property(msj);
            if (msp && msp.matchName === "ADBE Vector Group") msGroups.push(msp.name);
        }
        if (msGroups.length > 1) {
            multiShapeList.push({
                nfoIdx: msi,
                layer:  layerInfos[msi].layer,
                groups: msGroups
            });
        }
    }

    if (multiShapeList.length > 0) {
        var msDlg = new Window("dialog", "Preflight  ·  Multi-shape layers");
        msDlg.orientation = "column";
        msDlg.alignChildren = ["fill", "top"];
        msDlg.spacing = 8;
        msDlg.margins = 14;

        msDlg.add("statictext", undefined,
            multiShapeList.length + " shape layer" +
            (multiShapeList.length === 1 ? "" : "s") +
            " with multiple shape groups:");

        var msLb = msDlg.add("listbox", undefined, [],
            { multiselect: false, numberOfColumns: 2,
              showHeaders: true, columnTitles: ["Shape layer", "Shapes"],
              columnWidths: [220, 460] });
        msLb.preferredSize.width = 700;
        msLb.preferredSize.height = Math.max(180, Math.min(360, 32 + multiShapeList.length * 22));
        for (var msk = 0; msk < multiShapeList.length; msk++) {
            var msEntry = multiShapeList[msk];
            var msItem = msLb.add("item", msEntry.layer.name);
            msItem.subItems[0].text = msEntry.groups.length + " — " +
                                       msEntry.groups.join(", ");
        }

        var msNote = msDlg.add("statictext", undefined,
            "Each layer will be duplicated once per shape group and trimmed " +
            "down to a single group, so every USD prim has one mesh.\n" +
            "Cmd-Z reverts in AE if needed.", { multiline: true });
        msNote.preferredSize.width = 700;

        var msBtnGrp = msDlg.add("group");
        msBtnGrp.alignment = "right";
        var msBtnCancel = msBtnGrp.add("button", undefined, "Cancel");
        var msBtnSplit  = msBtnGrp.add("button", undefined, "Split & Continue");

        var msProceed = false;
        msBtnSplit.onClick  = function () { msProceed = true;  msDlg.close(); };
        msBtnCancel.onClick = function () { msProceed = false; msDlg.close(); };

        msDlg.show();
        if (!msProceed) return;
        if (!ensureBackup()) return;
        app.beginUndoGroup("AE USD Exporter — split multi-shape layers");

        // Sort high-to-low so removing earlier layerInfos entries doesn't
        // shift the indices we still need to remove.
        multiShapeList.sort(function (a, b) { return b.nfoIdx - a.nfoIdx; });

        for (var msSp = 0; msSp < multiShapeList.length; msSp++) {
            var spEntry = multiShapeList[msSp];
            var spLayer = spEntry.layer;
            var spGroupNames = spEntry.groups;
            var spNew = [];
            // Duplicate once per group, then trim other groups out.
            for (var spK = 0; spK < spGroupNames.length; spK++) {
                var dup = spLayer.duplicate();
                var dupContents = dup.property("Contents");
                // Walk in reverse, keep only the spK-th Vector Group
                var seenGroups = -1;
                for (var spJ = dupContents.numProperties; spJ >= 1; spJ--) {
                    var spProp = dupContents.property(spJ);
                    if (spProp && spProp.matchName === "ADBE Vector Group") {
                        // Find this group's original index
                    }
                }
                // Easier: count groups front-to-back, mark which to remove
                var groupIdx = 0;
                var removeIdxs = [];
                for (var spF = 1; spF <= dupContents.numProperties; spF++) {
                    var spFp = dupContents.property(spF);
                    if (spFp && spFp.matchName === "ADBE Vector Group") {
                        if (groupIdx !== spK) removeIdxs.push(spF);
                        groupIdx++;
                    }
                }
                // Remove from the end so earlier indices stay valid
                for (var spR = removeIdxs.length - 1; spR >= 0; spR--) {
                    try { dupContents.property(removeIdxs[spR]).remove(); } catch (e) {}
                }
                // ASCII-only separator so the AE layer name (which becomes the
                // USD prim doc string) doesn't introduce non-UTF-8 bytes.
                dup.name = spLayer.name + " - " + spGroupNames[spK];
                spNew.push(dup);
            }

            // Replace the original entry in layerInfos with the new split
            // layers.  Remove the original AE layer last so we don't lose
            // its reference mid-loop.
            layerInfos.splice(spEntry.nfoIdx, 1);
            for (var spI = 0; spI < spNew.length; spI++) {
                layerInfos.push({
                    layer:     spNew[spI],
                    isCam:     false,
                    isLight:   false,
                    isAV3D:    true,
                    isSpot:    false,
                    isAmbient: false,
                    isSolid:   false,
                    isFootage: false,
                    isText:    false,
                    isShape:   true,
                    usdType:   "Xform",
                    subtype:   "Shape",
                    primName:  makePrimName(spNew[spI].name, usedPrimNames)
                });
            }
            try { spLayer.remove(); } catch (e) {}
        }
        app.endUndoGroup();
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
        if (isShapeLayer(layer)) return "Shape";
        if (isTextLayer(layer))  return "Text";
        try {
            if (layer.source && layer.source.mainSource) {
                if (layer.source.mainSource instanceof SolidSource) return "Solid";
                if (layer.source.mainSource instanceof FileSource) return "Footage";
            }
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
    // Equivalent to the Euler-level substitution (rx, -ry, -rz).  The
    // formula is fully determined by the AE→USD basis change combined
    // with "identity AE → identity USD".
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

    // ── 2D vector geometry (text + shape vertex reconstruction) ───────────
    // Tessellates AE Path beziers into polylines, ear-clips into triangles,
    // and emits USD Mesh.  Used by writeShapeGeo and writeTextGeo so glyphs
    // and vector outlines become real geometry instead of bbox quads.

    function identityM3x3() {
        return [[1,0,0], [0,1,0], [0,0,1]];
    }
    function m3x3mul(a, b) {
        var r = [[0,0,0],[0,0,0],[0,0,0]];
        for (var i = 0; i < 3; i++)
            for (var j = 0; j < 3; j++)
                for (var k = 0; k < 3; k++)
                    r[i][j] += a[i][k] * b[k][j];
        return r;
    }
    function transformPoints2D(points, M) {
        var out = [];
        for (var i = 0; i < points.length; i++) {
            var p = points[i];
            out.push([
                M[0][0]*p[0] + M[0][1]*p[1] + M[0][2],
                M[1][0]*p[0] + M[1][1]*p[1] + M[1][2]
            ]);
        }
        return out;
    }

    // AE shape-group transform → 2D affine 3×3.  Composes T(pos) · R · S
    // around (-anchor) so the group's rotation/scale pivot at its anchor.
    function readVectorTransform(transformGroup, time) {
        var anchor = [0, 0], pos = [0, 0], rot = 0, scl = [100, 100];
        try { anchor = transformGroup.property("ADBE Vector Anchor")  .valueAtTime(time, false); } catch (e) {}
        try { pos    = transformGroup.property("ADBE Vector Position").valueAtTime(time, false); } catch (e) {}
        try { rot    = transformGroup.property("ADBE Vector Rotation").valueAtTime(time, false); } catch (e) {}
        try { scl    = transformGroup.property("ADBE Vector Scale")   .valueAtTime(time, false); } catch (e) {}
        var sx = scl[0] / 100, sy = scl[1] / 100;
        var rad = rot * Math.PI / 180;
        var cR = Math.cos(rad), sR = Math.sin(rad);
        // M = T(pos) * R * S * T(-anchor)  →  3x3 with translation = pos - R*S*anchor
        var a00 =  cR * sx, a01 = -sR * sy;
        var a10 =  sR * sx, a11 =  cR * sy;
        var tx  = pos[0] - (a00 * anchor[0] + a01 * anchor[1]);
        var ty  = pos[1] - (a10 * anchor[0] + a11 * anchor[1]);
        return [[a00, a01, tx], [a10, a11, ty], [0, 0, 1]];
    }

    // Cubic bezier tessellation.  AE Path: vertices[i] is the on-curve point;
    // outTangents[i] / inTangents[i] are CONTROL POINT OFFSETS from that vertex.
    // Each segment from V_i to V_{i+1} uses control points V_i + outT_i and
    // V_{i+1} + inT_{i+1}.
    function tessellatePath(shape, segs) {
        var verts = shape.vertices || [];
        var inT   = shape.inTangents  || [];
        var outT  = shape.outTangents || [];
        var closed = shape.closed !== false;
        var n = verts.length;
        if (n < 2) return [];
        var result = [];
        function emit(P0, T0o, P1, T1i, includeFirst) {
            var c0 = [P0[0] + T0o[0], P0[1] + T0o[1]];
            var c1 = [P1[0] + T1i[0], P1[1] + T1i[1]];
            if (includeFirst) result.push([P0[0], P0[1]]);
            for (var s = 1; s <= segs; s++) {
                var t = s / segs;
                var u = 1 - t;
                var x = u*u*u*P0[0] + 3*u*u*t*c0[0] + 3*u*t*t*c1[0] + t*t*t*P1[0];
                var y = u*u*u*P0[1] + 3*u*u*t*c0[1] + 3*u*t*t*c1[1] + t*t*t*P1[1];
                result.push([x, y]);
            }
        }
        for (var i = 0; i < n - 1; i++) {
            emit(verts[i], outT[i] || [0,0], verts[i+1], inT[i+1] || [0,0], i === 0);
        }
        if (closed) {
            emit(verts[n-1], outT[n-1] || [0,0], verts[0], inT[0] || [0,0], false);
        }
        return result;
    }

    // Drop near-duplicate adjacent vertices (cubic-bezier tessellation can
    // emit them when in/out tangents are zero) and the closing duplicate
    // when the polyline ends where it started.
    function dedupAdjacent(poly) {
        var out = [];
        for (var i = 0; i < poly.length; i++) {
            var p = poly[i];
            if (out.length === 0) { out.push(p); continue; }
            var last = out[out.length - 1];
            if (Math.abs(p[0] - last[0]) > 1e-5 || Math.abs(p[1] - last[1]) > 1e-5) {
                out.push(p);
            }
        }
        if (out.length > 1) {
            var first = out[0], lastV = out[out.length - 1];
            if (Math.abs(first[0] - lastV[0]) < 1e-5 && Math.abs(first[1] - lastV[1]) < 1e-5) {
                out.pop();
            }
        }
        return out;
    }

    // Ear-clipping triangulation.  Handles simple (non-self-intersecting)
    // polygons; assumes a single closed loop.  Polygons with holes (e.g.
    // letter "O") render filled — outer + inner outline both get filled
    // and the hole isn't subtracted.  Acceptable v1 trade-off; libtess-quality
    // hole handling is a future polish item.
    function earClipTriangulate(verts) {
        var n = verts.length;
        if (n < 3) return [];
        if (n === 3) return [[0, 1, 2]];

        // Signed area picks the winding; force CCW so isEar's positive-cross
        // convex test works.  We keep the original index mapping in `idx`.
        var area = 0;
        for (var i = 0; i < n; i++) {
            var j = (i + 1) % n;
            area += verts[i][0] * verts[j][1] - verts[j][0] * verts[i][1];
        }
        var idx = [];
        if (area > 0) { for (var i = 0; i < n; i++) idx.push(i); }
        else          { for (var i = n - 1; i >= 0; i--) idx.push(i); }

        var tris = [];
        var safety = n * n;   // bail before worst-case O(n^3)
        while (idx.length > 3 && safety-- > 0) {
            var clipped = false;
            for (var i = 0; i < idx.length; i++) {
                var prev = idx[(i - 1 + idx.length) % idx.length];
                var curr = idx[i];
                var next = idx[(i + 1) % idx.length];
                if (isEar(verts, idx, prev, curr, next)) {
                    tris.push([prev, curr, next]);
                    idx.splice(i, 1);
                    clipped = true;
                    break;
                }
            }
            if (!clipped) break;   // self-intersecting / degenerate; emit partial
        }
        if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
        return tris;
    }

    function isEar(verts, idx, i0, i1, i2) {
        var p0 = verts[i0], p1 = verts[i1], p2 = verts[i2];
        // Convex check: cross > 0 (we forced CCW).
        var cross = (p1[0]-p0[0])*(p2[1]-p0[1]) - (p1[1]-p0[1])*(p2[0]-p0[0]);
        if (cross <= 0) return false;
        // No other vertex of the polygon lies inside the candidate triangle.
        for (var k = 0; k < idx.length; k++) {
            var j = idx[k];
            if (j === i0 || j === i1 || j === i2) continue;
            if (pointInTriangle(verts[j], p0, p1, p2)) return false;
        }
        return true;
    }
    function pointInTriangle(p, a, b, c) {
        function s(p, a, b) {
            return (p[0]-b[0]) * (a[1]-b[1]) - (a[0]-b[0]) * (p[1]-b[1]);
        }
        var d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
        var hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        var hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        return !(hasNeg && hasPos);
    }

    // Parametric primitive → Path (bezier vertex+tangent form).  Rect with
    // roundness > 0 uses 4 cubics with k = 0.5523 to approximate the corner;
    // ellipse uses 4 cubics for the full curve.
    var BEZIER_K = 0.5522847498;
    function makeRectShape(rectProp, time) {
        var size = [100, 100], pos = [0, 0], rounded = 0;
        try { size    = rectProp.property("ADBE Vector Rect Size")     .valueAtTime(time, false); } catch (e) {}
        try { pos     = rectProp.property("ADBE Vector Rect Position") .valueAtTime(time, false); } catch (e) {}
        try { rounded = rectProp.property("ADBE Vector Rect Roundness").valueAtTime(time, false); } catch (e) {}
        var w = size[0], h = size[1];
        var x1 = pos[0] - w/2, x2 = pos[0] + w/2;
        var y1 = pos[1] - h/2, y2 = pos[1] + h/2;
        if (rounded < 0.5) {
            return {
                vertices:    [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
                inTangents:  [[0,0], [0,0], [0,0], [0,0]],
                outTangents: [[0,0], [0,0], [0,0], [0,0]],
                closed:      true
            };
        }
        var r = Math.min(rounded, w/2, h/2);
        var k = BEZIER_K * r;
        return {
            vertices: [
                [x1+r, y1], [x2-r, y1], [x2, y1+r], [x2, y2-r],
                [x2-r, y2], [x1+r, y2], [x1, y2-r], [x1, y1+r]
            ],
            inTangents: [
                [-k, 0], [0,  0], [0, -k], [0, 0],
                [ k, 0], [0,  0], [0,  k], [0, 0]
            ],
            outTangents: [
                [0, 0], [ k,  0], [0, 0], [0,  k],
                [0, 0], [-k,  0], [0, 0], [0, -k]
            ],
            closed: true
        };
    }
    function makeEllipseShape(ellProp, time) {
        var size = [100, 100], pos = [0, 0];
        try { size = ellProp.property("ADBE Vector Ellipse Size")    .valueAtTime(time, false); } catch (e) {}
        try { pos  = ellProp.property("ADBE Vector Ellipse Position").valueAtTime(time, false); } catch (e) {}
        var rx = size[0] / 2, ry = size[1] / 2;
        var cx = pos[0], cy = pos[1];
        var kx = BEZIER_K * rx, ky = BEZIER_K * ry;
        return {
            vertices:    [[cx, cy-ry], [cx+rx, cy], [cx, cy+ry], [cx-rx, cy]],
            inTangents:  [[-kx, 0], [0, -ky], [ kx, 0], [0,  ky]],
            outTangents: [[ kx, 0], [0,  ky], [-kx, 0], [0, -ky]],
            closed: true
        };
    }

    // Star / Polygon primitive.  Type 1 = polygon (N points around outer
    // radius); Type 2 = star (2N points alternating inner/outer).  Roundness
    // is approximated by zeroing out tangents — sharp points only in v1.
    function makeStarShape(starProp, time) {
        var type = 2, n = 5, pos = [0, 0], rot = 0, outR = 100, innR = 50;
        try { type = starProp.property("ADBE Vector Star Type")        .valueAtTime(time, false); } catch (e) {}
        try { n    = starProp.property("ADBE Vector Star Points")      .valueAtTime(time, false); } catch (e) {}
        try { pos  = starProp.property("ADBE Vector Star Position")    .valueAtTime(time, false); } catch (e) {}
        try { rot  = starProp.property("ADBE Vector Star Rotation")    .valueAtTime(time, false); } catch (e) {}
        try { outR = starProp.property("ADBE Vector Star Outer Radius").valueAtTime(time, false); } catch (e) {}
        try { innR = starProp.property("ADBE Vector Star Inner Radius").valueAtTime(time, false); } catch (e) {}
        n = Math.max(3, Math.round(n));
        var nVerts = (type === 2) ? n * 2 : n;
        var verts = [], zeroT = [];
        var step = (2 * Math.PI) / nVerts;
        var phase = (rot - 90) * Math.PI / 180;     // AE 0° points up; -90° offset
        for (var i = 0; i < nVerts; i++) {
            var theta = phase + i * step;
            var r = (type === 2 && (i % 2 === 1)) ? innR : outR;
            verts.push([pos[0] + r * Math.cos(theta), pos[1] + r * Math.sin(theta)]);
            zeroT.push([0, 0]);
        }
        return {
            vertices: verts,
            inTangents: zeroT,
            outTangents: zeroT.slice(),
            closed: true
        };
    }

    // Sub-property lookup helpers — try matchName first (locale-stable),
    // fall back to display name, then index-scan.  A previous version
    // relied on `p.property("Path")` / `p.property("Color")` exclusively;
    // those quietly returned null in some AE configurations and the whole
    // shape went unwalked (extractedPaths empty → bbox fallback).
    function findShapePathProp(shapeGroup) {
        var hit = null;
        try { hit = shapeGroup.property("ADBE Vector Shape"); } catch (e) {}
        if (hit) return hit;
        try { hit = shapeGroup.property("Path"); } catch (e) {}
        if (hit) return hit;
        try {
            for (var i = 1; i <= shapeGroup.numProperties; i++) {
                var sub = shapeGroup.property(i);
                if (sub && sub.matchName === "ADBE Vector Shape") return sub;
            }
        } catch (e) {}
        return null;
    }
    function findFillColorValue(fillProp, time) {
        var col = null;
        try {
            var byMn = fillProp.property("ADBE Vector Fill Color");
            if (byMn) col = byMn.valueAtTime(time, false);
        } catch (e) {}
        if (!col) {
            try {
                var byDn = fillProp.property("Color");
                if (byDn) col = byDn.valueAtTime(time, false);
            } catch (e) {}
        }
        return col;
    }
    function findTransformGroup(vectorGroupContents) {
        try {
            for (var i = 1; i <= vectorGroupContents.numProperties; i++) {
                var sub = vectorGroupContents.property(i);
                if (sub && sub.matchName === "ADBE Vector Transform Group") return sub;
            }
        } catch (e) {}
        return null;
    }

    // Walks layer.property("Contents") of a shape layer, applying each
    // Vector Group's Transform stack and propagating Fill colour.  Returns
    // an array of { poly, color, closed } where poly is in layer-local
    // coords (NOT yet anchor-shifted — caller does that in writeVectorMesh).
    function extractShapePaths(layer, time) {
        var out = [];
        var contents;
        try { contents = layer.property("Contents"); } catch (e) { return out; }
        if (!contents || typeof contents.numProperties !== "number") return out;
        walkVectorGroup(contents, identityM3x3(), [0.5, 0.5, 0.5], out, time);
        return out;
    }

    function walkVectorGroup(groupProp, parentXform, parentColor, out, time) {
        // First pass: pick up the local Transform Group (if any) and the
        // first Fill (so nested shapes inherit it).
        var localXform = identityM3x3();
        var color = parentColor;
        for (var i = 1; i <= groupProp.numProperties; i++) {
            var p;
            try { p = groupProp.property(i); } catch (e) { continue; }
            if (!p) continue;
            var mn;
            try { mn = p.matchName; } catch (e) { continue; }
            if (mn === "ADBE Vector Transform Group") {
                localXform = readVectorTransform(p, time);
            } else if (mn === "ADBE Vector Graphic - Fill") {
                var col = findFillColorValue(p, time);
                if (col) color = [col[0], col[1], col[2]];
            }
        }
        var fullXform = m3x3mul(parentXform, localXform);

        // Second pass: recurse into Vector Groups, emit paths for shapes.
        for (var i = 1; i <= groupProp.numProperties; i++) {
            var p;
            try { p = groupProp.property(i); } catch (e) { continue; }
            if (!p) continue;
            var mn;
            try { mn = p.matchName; } catch (e) { continue; }

            if (mn === "ADBE Vector Group") {
                // Vector Group's Transform Group sits inside its Contents
                // (alongside the shape primitives), so the recursive call
                // picks it up via the first pass above.
                var nested;
                try { nested = p.property("Contents"); } catch (e) { continue; }
                if (!nested) {
                    try { nested = p.property("ADBE Vectors Group"); } catch (e) {}
                }
                if (nested) walkVectorGroup(nested, fullXform, color, out, time);

            } else if (mn === "ADBE Vector Shape - Group") {
                var pathProp = findShapePathProp(p);
                if (!pathProp) continue;
                try {
                    var shape = pathProp.valueAtTime(time, false);
                    if (shape && shape.vertices && shape.vertices.length >= 2) {
                        var poly = tessellatePath(shape, 8);
                        poly = transformPoints2D(poly, fullXform);
                        out.push({ poly: poly, color: color,
                                   closed: shape.closed !== false });
                    }
                } catch (e) {}

            } else if (mn === "ADBE Vector Shape - Rect") {
                var rs = makeRectShape(p, time);
                if (rs) {
                    var rp = tessellatePath(rs, 8);
                    rp = transformPoints2D(rp, fullXform);
                    out.push({ poly: rp, color: color, closed: true });
                }

            } else if (mn === "ADBE Vector Shape - Ellipse") {
                var es = makeEllipseShape(p, time);
                if (es) {
                    var ep = tessellatePath(es, 12);
                    ep = transformPoints2D(ep, fullXform);
                    out.push({ poly: ep, color: color, closed: true });
                }

            } else if (mn === "ADBE Vector Shape - Star") {
                var st = makeStarShape(p, time);
                if (st) {
                    var sp = tessellatePath(st, 1);   // sharp points, linear segs
                    sp = transformPoints2D(sp, fullXform);
                    out.push({ poly: sp, color: color, closed: true });
                }

            }
            // Skipped: Stroke, Trim Paths, Merge Paths, Repeater,
            // Pucker & Bloat, Wiggle Paths, etc.  Document in
            // known-limitations if they end up biting users.
        }
    }

    // Convert a text layer to a shape layer via AE's "Create Shapes from
    // Text" menu command, on a duplicate so the original stays intact.
    // Returns { shape, dup, success }; the caller MUST call cleanupConvertedText
    // to dispose both temp layers (within the same undo group).
    function convertTextToShapes(textLayer) {
        var textComp = textLayer.containingComp;

        var savedSel = [];
        for (var si = 1; si <= textComp.numLayers; si++) {
            var sl = textComp.layer(si);
            try { if (sl.selected) savedSel.push(sl); sl.selected = false; } catch (e) {}
        }

        var dup = null, newShape = null, success = false;
        try {
            dup = textLayer.duplicate();
            dup.selected = true;
            var cmdId = app.findMenuCommandId("Create Shapes from Text");
            if (!cmdId) {
                try { dup.remove(); } catch (e) {}
                dup = null;
            } else {
                // Snapshot pre-existing layer references so we can spot the
                // newly-created shape layer (the command adds it at the top
                // of the comp; identity comparison avoids index-shift bugs).
                var preRefs = [];
                for (var ri = 1; ri <= textComp.numLayers; ri++) preRefs.push(textComp.layer(ri));

                app.executeCommand(cmdId);

                for (var ai = 1; ai <= textComp.numLayers; ai++) {
                    var L = textComp.layer(ai);
                    var seen = false;
                    for (var pi = 0; pi < preRefs.length; pi++) {
                        if (preRefs[pi] === L) { seen = true; break; }
                    }
                    if (seen) continue;
                    var isShape = false;
                    try {
                        if (L instanceof ShapeLayer) isShape = true;
                        else if (L.matchName === "ADBE Vector Layer") isShape = true;
                    } catch (e) {}
                    if (isShape) { newShape = L; success = true; break; }
                }
            }
        } catch (e) {}

        // Restore selection regardless of outcome.
        for (var ri2 = 0; ri2 < savedSel.length; ri2++) {
            try { savedSel[ri2].selected = true; } catch (e) {}
        }

        return { shape: newShape, dup: dup, success: success };
    }

    function cleanupConvertedText(result) {
        if (!result) return;
        if (result.shape) try { result.shape.remove(); } catch (e) {}
        if (result.dup)   try { result.dup  .remove(); } catch (e) {}
    }

    // Detect whether a text layer's CONTENT animates (per-frame text changes).
    // Layer-level transform animation (position / rotation / scale on the
    // text layer itself) is captured by the matrix sampler regardless and
    // doesn't require per-frame mesh extraction.
    function isTextAnimated(textLayer) {
        try {
            var st = textLayer.text.sourceText;
            if (st && st.numKeys && st.numKeys > 0) return true;
            try {
                if (st && st.expressionEnabled && st.expression && st.expression.length > 0) return true;
            } catch (e) {}
        } catch (e) {}
        // Per-character / range-selector animators live under
        // "ADBE Text Properties" → "ADBE Text Animators".  Their presence is
        // a strong signal that the rendered glyphs differ frame to frame.
        try {
            var ta = textLayer.property("ADBE Text Properties").property("ADBE Text Animators");
            if (ta && ta.numProperties > 0) return true;
        } catch (e) {}
        return false;
    }

    // POI-probe trick — `Layer.fromWorld()` isn't directly callable from
    // ExtendScript, only inside an expression.  For a parented 2-node camera
    // / light we need the camera's pointOfInterest expressed in the parent's
    // local frame so it composes with the camera's parent-local position.
    // We create a null parented to the camera's parent and bind its
    // `position` to `parent.fromWorld(camera.pointOfInterest)` — reading
    // `position.valueAtTime(t)` then gives us per-frame parent-local POI.
    function exprQuoteName(s) {
        // AE expressions use double-quoted layer names; escape backslashes
        // and double-quotes.  Names with newlines aren't worth supporting.
        return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }
    function createPoiProbe(camLayer, primName) {
        if (!camLayer || !camLayer.parent) return null;
        var pComp = camLayer.containingComp;
        var n;
        try {
            n = pComp.layers.addNull();
            n.threeDLayer = true;
            n.parent = camLayer.parent;
            n.name = "_AE2USD_poi_probe_" + (primName || camLayer.index);
            n.enabled = false;            // never render the probe
            n.shy = true;                 // tuck it away in the UI
            var camRef = 'thisComp.layer("' + exprQuoteName(camLayer.name) + '")';
            var parRef = 'thisComp.layer("' + exprQuoteName(camLayer.parent.name) + '")';
            n.position.expression = parRef + '.fromWorld(' + camRef + '.pointOfInterest)';
        } catch (e) {
            if (n) try { n.remove(); } catch (e2) {}
            return null;
        }
        return n;
    }

    // World-path probe — same trick, but reads `layer.toWorld([0,0,0])` so the
    // null's per-frame position equals the layer's WORLD-space origin.  Lets
    // us emit a static `BasisCurves` showing the trajectory of an animated
    // camera / light even when the layer is parented to an animated null.
    function createWorldPathProbe(targetLayer, primName) {
        if (!targetLayer) return null;
        var pComp = targetLayer.containingComp;
        var n;
        try {
            n = pComp.layers.addNull();
            n.threeDLayer = true;
            // No parent — null position is in comp world space directly.
            n.name = "_AE2USD_path_probe_" + (primName || targetLayer.index);
            n.enabled = false;
            n.shy = true;
            var ref = 'thisComp.layer("' + exprQuoteName(targetLayer.name) + '")';
            n.position.expression = ref + '.toWorld([0, 0, 0])';
        } catch (e) {
            if (n) try { n.remove(); } catch (e2) {}
            return null;
        }
        return n;
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

    // ── Pre-extract text + shape vertex paths ─────────────────────────────
    // Walks each shape layer's "Contents" tree and tessellates beziers into
    // 2D polylines.  Text layers are routed through AE's "Create Shapes from
    // Text" command (acting on a duplicate so the original is preserved);
    // both temp layers are removed before the export continues.  Result
    // lands on nfo.extractedPaths and is consumed by writeShapeGeo /
    // writeTextGeo when emitting the USD Mesh.  Skips silently on failure
    // (writeBoundsGeo fallback covers the no-paths case).
    var anyTextOrShape = false;
    for (var ext1 = 0; ext1 < layerInfos.length; ext1++) {
        if (layerInfos[ext1].isText || layerInfos[ext1].isShape) {
            anyTextOrShape = true; break;
        }
    }
    if (anyTextOrShape) {
        // Text routing through `Create Shapes from Text` is AE-side destructive
        // (on a duplicate; original is preserved); match the 2D-flip / multi-
        // shape preflights and gate behind ensureBackup so the user always
        // has Cmd-Z + a versioned .aep to fall back on.  Falls through with
        // bbox quad fallback if the user declines.
        if (ensureBackup()) {
            app.beginUndoGroup("AE USD Exporter — extract text/shape paths");
            // Animated text needs comp.time bumped before each conversion
            // (the menu command bakes the rendered text at currentTime); we
            // restore comp.time after the loop.
            var origCompTime = comp.time;
            try {
                for (var ext2 = 0; ext2 < layerInfos.length; ext2++) {
                    var nfoX = layerInfos[ext2];
                    if (nfoX.isText) {
                        if (isTextAnimated(nfoX.layer)) {
                            // Per-frame extraction.  Slow (one menu command
                            // per frame per text layer), but the only way to
                            // capture sourceText / range-selector animation.
                            nfoX.extractedPathsByFrame = [];
                            for (var f = startFrame; f <= endFrame; f++) {
                                var tF = f / fps;
                                try { comp.time = tF; } catch (e) {}
                                var convF = convertTextToShapes(nfoX.layer);
                                var pathsF = (convF && convF.success && convF.shape)
                                    ? extractShapePaths(convF.shape, tF)
                                    : [];
                                cleanupConvertedText(convF);
                                nfoX.extractedPathsByFrame.push({ frame: f, paths: pathsF });
                            }
                        } else {
                            // Static text — single conversion at startFrame.
                            var snapTime = startFrame / fps;
                            try { comp.time = snapTime; } catch (e) {}
                            var conv = convertTextToShapes(nfoX.layer);
                            if (conv && conv.success && conv.shape) {
                                nfoX.extractedPaths = extractShapePaths(conv.shape, snapTime);
                            }
                            cleanupConvertedText(conv);
                        }
                    } else if (nfoX.isShape) {
                        nfoX.extractedPaths = extractShapePaths(nfoX.layer, startFrame / fps);
                    }
                }
            } catch (e) {}
            try { comp.time = origCompTime; } catch (e) {}
            app.endUndoGroup();
        }
    }

    // ── Sample all frames ─────────────────────────────────────────────────
    // We create temporary null layers to read values that ExtendScript
    // can't compute directly:
    //   - POI probes — parent.fromWorld(camera.pointOfInterest) for parented
    //     2-node cameras / lights.
    //   - Path probes — layer.toWorld([0,0,0]) for cam / light / null /
    //     AVLayer when the matching dialog checkbox is on, so we can emit
    //     a static BasisCurves trajectory under AE_Scene.
    // All probes live for the sampling phase only and are removed before
    // the next phase; the whole pass is wrapped in one undo group so
    // Cmd-Z reverts cleanly if anything errors out.
    function shouldEmitPath(nfo) {
        if (nfo.isCam)   return emitPathCam;
        if (nfo.isLight) return emitPathLight;
        if (nfo.isAV3D) {
            var isNull = false;
            try { isNull = !!nfo.layer.nullLayer; } catch (e) {}
            return isNull ? emitPathNull : emitPathAV;
        }
        return false;
    }
    var anyProbeNeeded = false;
    for (var li0 = 0; li0 < layerInfos.length; li0++) {
        var nfo0 = layerInfos[li0];
        if ((nfo0.isCam || nfo0.isLight) || shouldEmitPath(nfo0)) {
            anyProbeNeeded = true; break;
        }
    }
    if (anyProbeNeeded) app.beginUndoGroup("AE USD Exporter — sample (probes)");

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

        // For parented 2-node cameras / lights, build a POI probe that
        // evaluates parent.fromWorld(camera.pointOfInterest) per frame —
        // ExtendScript can't call fromWorld directly so we route through an
        // expression null.  Probe is removed below after sampling completes.
        var poiProbe = null;
        if (nfo.use2Node && layer.parent) {
            poiProbe = createPoiProbe(layer, nfo.primName);
        }
        // Path probe — toWorld([0,0,0]) gives the layer's world-space origin;
        // we sample once per frame and emit a BasisCurves trajectory under
        // AE_Scene so animated paths are visible in Houdini.  Gated by the
        // per-type checkboxes (cam / light / null / AVLayer).
        var pathProbe = null;
        if (shouldEmitPath(nfo)) {
            pathProbe = createWorldPathProbe(layer, nfo.primName);
        }

        // mS[i] = [frame, m00..m22, tx, ty, tz]  (9 rotation + 3 translation values)
        // pathS[i] = [frame, wx, wy, wz]          (cam/light world-space origin)
        var mS=[], flS=[], fdS=[], intS=[], colS=[], caS=[], cfS=[], pathS=[];

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
                var poi;
                if (poiProbe) {
                    // Probe null reads parent-local POI via expression — works
                    // when both camera AND parent animate; ExtendScript's own
                    // Layer.fromWorld is undefined here.
                    try { poi = poiProbe.position.valueAtTime(t, false); }
                    catch (e) { poi = null; }
                }
                if (!poi) {
                    // No probe (root-parented / probe creation failed): POI is
                    // already in the right space (world == parent for roots).
                    try { poi = layer.pointOfInterest.valueAtTime(t, false); }
                    catch (e) { poi = [rawPos[0], rawPos[1], rawPos[2]]; }
                }
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

            // Build 3×3 with scale baked in.  USD's xformOp:transform is
            // row-vector (post-multiply), so the bilateral conjugation
            // converts AE's column-vector R*S to row-vector S*R_usd_row,
            // i.e. row i is scaled by s_i — NOT column j by s_j.  Uniform
            // scale produces identical numbers either way, but non-uniform
            // and negative scale only land correctly with row scaling.
            mS.push([frame,
                Rusd[0][0]*sx, Rusd[0][1]*sx, Rusd[0][2]*sx,
                Rusd[1][0]*sy, Rusd[1][1]*sy, Rusd[1][2]*sy,
                Rusd[2][0]*sz, Rusd[2][1]*sz, Rusd[2][2]*sz,
                tx, ty, tz
            ]);

            // World-space path sample for animated-trajectory BasisCurves.
            // Stored in AE comp pixel coords (sign-flip + scale conversion
            // happens at emit time, matching the regular position pipeline).
            if (pathProbe) {
                try {
                    var wp = pathProbe.position.valueAtTime(t, false);
                    pathS.push([frame, wp[0],
                        (wp.length > 1 ? wp[1] : 0),
                        (wp.length > 2 ? wp[2] : 0)]);
                } catch (e) {}
            }

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
        nfo.pathS = pathS;

        if (poiProbe)  { try { poiProbe.remove();  } catch (e) {} }
        if (pathProbe) { try { pathProbe.remove(); } catch (e) {} }
    }

    if (anyProbeNeeded) app.endUndoGroup();

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

    // Animation paths — sibling BasisCurves prims under AE_Scene, one per
    // animated layer whose type checkbox is on.  Static paths skipped
    // (single-position trajectories aren't useful and 1-vertex curves
    // render as nothing).
    for (var pli = 0; pli < layerInfos.length; pli++) {
        var pNfo = layerInfos[pli];
        if (!shouldEmitPath(pNfo)) continue;
        if (!pNfo.pathS || pNfo.pathS.length < 2) continue;
        if (isStaticSamples(pNfo.pathS, 3)) continue;
        out.push('');
        writePathCurve(out, I1, pNfo);
    }

    out.push('}');
    out.push('');

    // ── Write file ────────────────────────────────────────────────────────
    // ExtendScript writeln() uses CR-only on Mac regardless of lineFeed setting.
    // Write the entire file as one string with explicit LF characters (\u000A).
    var content = out.join('\u000A') + '\u000A';
    //
    // Encoding: ExtendScript "binary" writes only the low byte of each UCS-2
    // char, mangling anything above U+007F (e.g. U+00B7 "·" → raw byte 0xB7,
    // invalid UTF-8). Hand-encode to UTF-8 so AE layer names with accents,
    // umlauts, CJK etc. parse cleanly in USD/Houdini.
    outFile.encoding = "binary";
    outFile.open("w");
    outFile.write(toUtf8Bytes(content));
    outFile.close();

    // ── Success confirmation ──────────────────────────────────────────────
    var nCams=0, nLights=0, nNulls=0, nSolidsX=0, nFootageX=0, nTextX=0,
        nShapeX=0, nOtherX=0, nParented=0;
    for (var ci2 = 0; ci2 < layerInfos.length; ci2++) {
        var n = layerInfos[ci2];
        if      (n.isCam)     nCams++;
        else if (n.isLight)   nLights++;
        else if (n.layer.nullLayer) nNulls++;
        else if (n.isSolid)   nSolidsX++;
        else if (n.isFootage) nFootageX++;
        else if (n.isText)    nTextX++;
        else if (n.isShape)   nShapeX++;
        else                  nOtherX++;
        if (n.layer.parent) nParented++;
    }
    var nFrames = endFrame - startFrame + 1;
    var doneParts = [];
    if (nCams)     doneParts.push(nCams     + " cam");
    if (nLights)   doneParts.push(nLights   + " light");
    if (nNulls)    doneParts.push(nNulls    + " null");
    if (nSolidsX)  doneParts.push(nSolidsX  + " solid");
    if (nFootageX) doneParts.push(nFootageX + " footage");
    if (nTextX)    doneParts.push(nTextX    + " text");
    if (nShapeX)   doneParts.push(nShapeX   + " shape");
    if (nOtherX)   doneParts.push(nOtherX   + " xform");
    var summary =
        "Exported " + layerInfos.length + " prims  (" +
        doneParts.join(", ") + "; " + nParented + " parented)\n" +
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
            // Normalise: decouples intensity from light shape/size so
            // treatAsPoint sphere lights don't get nuked by zero surface
            // area, and intensity values translate predictably across
            // renderers.  Karma in particular needs this on for the
            // intensity scaling we set in samplePhase to read sensibly.
            out.push(ind2 + 'bool inputs:normalize = 1');
            if (nfo.usdType === 'SphereLight') {
                // Small positive radius instead of treatAsPoint=1.  A
                // zero-radius sphere with treatAsPoint is ambiguous in
                // USDLux and Karma renders it as black.  10 cm is small
                // enough to feel point-like at typical scene scales (~m)
                // while still being a well-defined area light.
                out.push(ind2 + 'float inputs:radius = 0.1');
            }
            if (nfo.isSpot && nfo.caS.length) {
                writeScalar(out, ind2, 'float', 'inputs:shaping:cone:angle',    nfo.caS);
                writeScalar(out, ind2, 'float', 'inputs:shaping:cone:softness', nfo.cfS);
            }
            if (nfo.usdType === 'DistantLight') {
                out.push(ind2 + 'float inputs:angle = 0.53');
            }
        }

        // Visibility: AE layers have inPoint/outPoint defining when they're
        // active in the comp.  Outside that window, mark the prim invisible
        // so Houdini hides it at the right times.  No-op if the layer is
        // visible across the entire export range.
        writeVisibility(out, ind2, nfo.layer);

        if (!nfo.isAmbient) writeMat4(out, ind2, nfo.mS);

        // Geometry: solids → flat quad with displayColor; footage layers
        // → flat quad with a UsdPreviewSurface material binding the source
        // file as a texture.  Both use the AE anchor as the mesh local
        // origin so rotation/scale pivot correctly.
        if (nfo.isSolid)        writeSolidGeo(out, ind2, nfo);
        else if (nfo.isFootage) writeFootageGeo(out, ind2, nfo);
        else if (nfo.isText)    writeTextGeo(out, ind2, nfo);
        else if (nfo.isShape)   writeShapeGeo(out, ind2, nfo);

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

    // Footage layer (still image / video file) → flat quad with a
    // UsdPreviewSurface material binding the source file as a texture.
    // Same vertex layout as solids; UVs are corner-mapped (full image).
    // Renders cleanly in Karma; Houdini's Hydra viewport shows the texture
    // in real time.  Falls back to plain mesh + grey displayColor if the
    // source file path can't be resolved.
    function writeFootageGeo(arr, ind, nfo) {
        var src = nfo.layer.source;
        var w = src.width, h = src.height;
        var anchor = [w/2, h/2, 0];
        try { anchor = nfo.layer.anchorPoint.value; } catch (e) {}

        var assetPath = "";
        try { assetPath = src.mainSource.file.fsName.replace(/\\/g, '/'); }
        catch (e) {}

        var tl = [0 - anchor[0], 0 - anchor[1], 0];
        var tr = [w - anchor[0], 0 - anchor[1], 0];
        var br = [w - anchor[0], h - anchor[1], 0];
        var bl = [0 - anchor[0], h - anchor[1], 0];
        function toUsd(p) {
            return '(' + fmt(p[0] / scale) + ', ' + fmt(-p[1] / scale) + ', 0)';
        }

        var ind2 = ind + I1;
        var ind3 = ind2 + I1;

        arr.push(ind + 'def Mesh "geo" (');
        if (assetPath) arr.push(ind2 + 'prepend apiSchemas = ["MaterialBindingAPI"]');
        arr.push(ind + ')');
        arr.push(ind + '{');
        arr.push(ind2 + 'point3f[] points = [' +
            toUsd(bl) + ', ' + toUsd(br) + ', ' + toUsd(tr) + ', ' + toUsd(tl) + ']');
        arr.push(ind2 + 'int[] faceVertexCounts = [4]');
        arr.push(ind2 + 'int[] faceVertexIndices = [0, 1, 2, 3]');
        arr.push(ind2 + 'bool doubleSided = 1');
        arr.push(ind2 + 'texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (');
        arr.push(ind3 + 'interpolation = "vertex"');
        arr.push(ind2 + ')');
        if (assetPath) {
            arr.push(ind2 + 'rel material:binding = <mat>');
        } else {
            arr.push(ind2 + 'color3f[] primvars:displayColor = [(0.5, 0.5, 0.5)]');
        }
        arr.push(ind + '}');

        if (!assetPath) return;

        // Material: PreviewSurface with a UsdUVTexture sampling the AE
        // footage file via a PrimvarReader on the "st" primvar.
        arr.push(ind + 'def Material "mat"');
        arr.push(ind + '{');
        arr.push(ind2 + 'token outputs:surface.connect = <Shader.outputs:surface>');
        arr.push('');
        arr.push(ind2 + 'def Shader "Shader"');
        arr.push(ind2 + '{');
        arr.push(ind3 + 'uniform token info:id = "UsdPreviewSurface"');
        arr.push(ind3 + 'color3f inputs:diffuseColor.connect = <../Tex.outputs:rgb>');
        arr.push(ind3 + 'float inputs:opacity.connect = <../Tex.outputs:a>');
        arr.push(ind3 + 'int inputs:useSpecularWorkflow = 0');
        arr.push(ind3 + 'token outputs:surface');
        arr.push(ind2 + '}');
        arr.push('');
        arr.push(ind2 + 'def Shader "Tex"');
        arr.push(ind2 + '{');
        arr.push(ind3 + 'uniform token info:id = "UsdUVTexture"');
        arr.push(ind3 + 'asset inputs:file = @' + assetPath + '@');
        arr.push(ind3 + 'float2 inputs:st.connect = <../PrimvarReader.outputs:result>');
        arr.push(ind3 + 'float3 outputs:rgb');
        arr.push(ind3 + 'float outputs:a');
        arr.push(ind2 + '}');
        arr.push('');
        arr.push(ind2 + 'def Shader "PrimvarReader"');
        arr.push(ind2 + '{');
        arr.push(ind3 + 'uniform token info:id = "UsdPrimvarReader_float2"');
        arr.push(ind3 + 'token inputs:varname = "st"');
        arr.push(ind3 + 'float2 outputs:result');
        arr.push(ind2 + '}');
        arr.push(ind + '}');
    }

    // Bounding-box quad mesh — fallback for text / shape layers when
    // vector reconstruction failed (no Path data, no "Create Shapes from
    // Text" command available, etc.).  Points are anchor-shifted so
    // rotation / scale pivot at the AE anchor (matches writeSolidGeo /
    // writeFootageGeo).  Sampled at the export start frame.
    function writeBoundsGeo(arr, ind, nfo, color) {
        var rect;
        try { rect = nfo.layer.sourceRectAtTime(startFrame / fps, false); }
        catch (e) { return; }
        if (!rect || rect.width <= 0 || rect.height <= 0) return;

        var anchor = [0, 0, 0];
        try { anchor = nfo.layer.anchorPoint.value; } catch (e) {}

        var L = rect.left  - anchor[0], T = rect.top   - anchor[1];
        var R = L + rect.width,         B = T + rect.height;
        var c = color || [0.5, 0.5, 0.5];

        function toUsd(x, y) {
            return '(' + fmt(x / scale) + ', ' + fmt(-y / scale) + ', 0)';
        }
        var ind2 = ind + I1;
        arr.push(ind + 'def Mesh "geo"');
        arr.push(ind + '{');
        arr.push(ind2 + 'point3f[] points = [' +
            toUsd(L, B) + ', ' + toUsd(R, B) + ', ' + toUsd(R, T) + ', ' + toUsd(L, T) + ']');
        arr.push(ind2 + 'int[] faceVertexCounts = [4]');
        arr.push(ind2 + 'int[] faceVertexIndices = [0, 1, 2, 3]');
        arr.push(ind2 + 'bool doubleSided = 1');
        arr.push(ind2 + 'color3f[] primvars:displayColor = [(' +
            fmt(c[0]) + ', ' + fmt(c[1]) + ', ' + fmt(c[2]) + ')]');
        arr.push(ind + '}');
    }

    // Builds per-frame mesh data: point strings (anchor-shifted, AE→USD
    // Y-flipped), per-face vertex counts, vertex indices, and the first
    // fill colour found.  Returns null when nothing useful triangulated.
    function buildMeshSnapshot(paths, anchor) {
        var pointStrs = [], faceCounts = [], faceIndices = [];
        var displayColor = [0.5, 0.5, 0.5], foundColor = false;
        var vertCount = 0;

        for (var pi = 0; pi < paths.length; pi++) {
            var p = paths[pi];
            if (!p.poly) continue;
            var poly = dedupAdjacent(p.poly);
            if (poly.length < 3) continue;
            var tris = earClipTriangulate(poly);
            if (!tris.length) continue;
            var startIdx = vertCount;
            for (var v = 0; v < poly.length; v++) {
                var ux = (poly[v][0] - anchor[0]) / scale;
                var uy = -(poly[v][1] - anchor[1]) / scale;
                pointStrs.push('(' + fmt(ux) + ', ' + fmt(uy) + ', 0)');
                vertCount++;
            }
            for (var ti = 0; ti < tris.length; ti++) {
                faceCounts.push(3);
                faceIndices.push(startIdx + tris[ti][0]);
                faceIndices.push(startIdx + tris[ti][1]);
                faceIndices.push(startIdx + tris[ti][2]);
            }
            if (!foundColor && p.color) {
                displayColor = [p.color[0], p.color[1], p.color[2]];
                foundColor = true;
            }
        }
        if (!pointStrs.length) return null;
        return {
            pointStrs:    pointStrs,
            faceCounts:   faceCounts,
            faceIndices:  faceIndices,
            displayColor: displayColor
        };
    }

    // Vector mesh — emits a real triangulated USD Mesh from extracted shape
    // paths (each path = closed polyline + fill colour).  Anchor-shifts the
    // points so AE's rotation/scale pivot lines up.  AE Y-down → USD Y-up.
    // First fill colour wins for displayColor (USD Mesh has one displayColor
    // per prim; per-path colour would need separate sub-prims).
    function writeVectorMesh(arr, ind, nfo, paths) {
        var anchor = [0, 0, 0];
        try { anchor = nfo.layer.anchorPoint.value; } catch (e) {}

        var snap = buildMeshSnapshot(paths, anchor);
        if (!snap) return false;

        var ind2 = ind + I1;
        arr.push(ind + 'def Mesh "geo"');
        arr.push(ind + '{');
        arr.push(ind2 + 'point3f[] points = [' + snap.pointStrs.join(', ') + ']');
        arr.push(ind2 + 'int[] faceVertexCounts = [' + snap.faceCounts.join(', ') + ']');
        arr.push(ind2 + 'int[] faceVertexIndices = [' + snap.faceIndices.join(', ') + ']');
        arr.push(ind2 + 'bool doubleSided = 1');
        arr.push(ind2 + 'color3f[] primvars:displayColor = [(' +
            fmt(snap.displayColor[0]) + ', ' + fmt(snap.displayColor[1]) + ', ' + fmt(snap.displayColor[2]) + ')]');
        arr.push(ind + '}');
        return true;
    }

    // Animated vector mesh — emits a Mesh whose points (and, if vertex count
    // changes between frames, faceVertexCounts/Indices too) animate.  Used
    // when text content keyframes or per-character animators were detected.
    // Static topology + animated points is the cheap path; animated topology
    // is the fallback when characters appear/disappear (USD allows it but
    // some viewers may not interpolate nicely — acceptable for layout
    // preview).  Consecutive identical samples are dropped to keep file size
    // manageable on long-held animations.
    function writeAnimatedVectorMesh(arr, ind, nfo, framedPaths) {
        var anchor = [0, 0, 0];
        try { anchor = nfo.layer.anchorPoint.value; } catch (e) {}

        var samples = [];   // [{ frame, snap }]
        for (var fi = 0; fi < framedPaths.length; fi++) {
            var snap = buildMeshSnapshot(framedPaths[fi].paths, anchor);
            if (snap) samples.push({ frame: framedPaths[fi].frame, snap: snap });
        }
        if (!samples.length) return false;

        // Are vertex count + face indices identical across all frames?
        // If so we only need to animate the points string.
        var topoConstant = true;
        var first = samples[0].snap;
        for (var si = 1; si < samples.length; si++) {
            var s = samples[si].snap;
            if (s.pointStrs.length   !== first.pointStrs.length ||
                s.faceCounts.length  !== first.faceCounts.length ||
                s.faceIndices.length !== first.faceIndices.length) {
                topoConstant = false; break;
            }
            for (var k = 0; k < s.faceIndices.length; k++) {
                if (s.faceIndices[k] !== first.faceIndices[k]) { topoConstant = false; break; }
            }
            if (!topoConstant) break;
            for (var k2 = 0; k2 < s.faceCounts.length; k2++) {
                if (s.faceCounts[k2] !== first.faceCounts[k2]) { topoConstant = false; break; }
            }
            if (!topoConstant) break;
        }

        // Drop interior of held runs (matches the dedupSamples optimisation
        // we use for matrix4d / scalar / colour timeSamples).
        function dedupRuns(samples, equal) {
            if (samples.length <= 2) return samples;
            var out = [samples[0]];
            for (var i = 1; i < samples.length - 1; i++) {
                if (!equal(samples[i].snap, samples[i-1].snap) ||
                    !equal(samples[i].snap, samples[i+1].snap)) {
                    out.push(samples[i]);
                }
            }
            out.push(samples[samples.length - 1]);
            return out;
        }
        function pointsEqual(a, b) {
            if (a.pointStrs.length !== b.pointStrs.length) return false;
            for (var i = 0; i < a.pointStrs.length; i++) {
                if (a.pointStrs[i] !== b.pointStrs[i]) return false;
            }
            return true;
        }
        function fullEqual(a, b) {
            if (!pointsEqual(a, b)) return false;
            if (a.faceCounts.length !== b.faceCounts.length ||
                a.faceIndices.length !== b.faceIndices.length) return false;
            for (var i = 0; i < a.faceCounts.length; i++) if (a.faceCounts[i] !== b.faceCounts[i]) return false;
            for (var j = 0; j < a.faceIndices.length; j++) if (a.faceIndices[j] !== b.faceIndices[j]) return false;
            return true;
        }
        var keys = topoConstant ? dedupRuns(samples, pointsEqual) : dedupRuns(samples, fullEqual);
        var displayColor = samples[0].snap.displayColor;

        var ind2 = ind + I1;
        arr.push(ind + 'def Mesh "geo"');
        arr.push(ind + '{');
        if (topoConstant) {
            arr.push(ind2 + 'point3f[] points.timeSamples = {');
            for (var ki = 0; ki < keys.length; ki++) {
                arr.push(ind2 + '    ' + keys[ki].frame + ': [' + keys[ki].snap.pointStrs.join(', ') + '],');
            }
            arr.push(ind2 + '}');
            arr.push(ind2 + 'int[] faceVertexCounts = [' + first.faceCounts.join(', ') + ']');
            arr.push(ind2 + 'int[] faceVertexIndices = [' + first.faceIndices.join(', ') + ']');
        } else {
            arr.push(ind2 + 'point3f[] points.timeSamples = {');
            for (var ki2 = 0; ki2 < keys.length; ki2++) {
                arr.push(ind2 + '    ' + keys[ki2].frame + ': [' + keys[ki2].snap.pointStrs.join(', ') + '],');
            }
            arr.push(ind2 + '}');
            arr.push(ind2 + 'int[] faceVertexCounts.timeSamples = {');
            for (var ki3 = 0; ki3 < keys.length; ki3++) {
                arr.push(ind2 + '    ' + keys[ki3].frame + ': [' + keys[ki3].snap.faceCounts.join(', ') + '],');
            }
            arr.push(ind2 + '}');
            arr.push(ind2 + 'int[] faceVertexIndices.timeSamples = {');
            for (var ki4 = 0; ki4 < keys.length; ki4++) {
                arr.push(ind2 + '    ' + keys[ki4].frame + ': [' + keys[ki4].snap.faceIndices.join(', ') + '],');
            }
            arr.push(ind2 + '}');
        }
        arr.push(ind2 + 'bool doubleSided = 1');
        arr.push(ind2 + 'color3f[] primvars:displayColor = [(' +
            fmt(displayColor[0]) + ', ' + fmt(displayColor[1]) + ', ' + fmt(displayColor[2]) + ')]');
        arr.push(ind + '}');
        return true;
    }

    // Text layer → triangulated glyph outlines via "Create Shapes from Text".
    // Animated text (sourceText keys / range-selector animators) gets
    // per-frame extraction and time-sampled mesh data; static text falls
    // through to the cheap single-snapshot path.  Last-resort fallback:
    // bounding-box quad coloured with the text's fill colour.
    // Polygons-with-holes (letter "O") render filled as a v1 limit.
    function writeTextGeo(arr, ind, nfo) {
        if (nfo.extractedPathsByFrame && nfo.extractedPathsByFrame.length) {
            if (writeAnimatedVectorMesh(arr, ind, nfo, nfo.extractedPathsByFrame)) return;
        }
        if (nfo.extractedPaths && nfo.extractedPaths.length) {
            if (writeVectorMesh(arr, ind, nfo, nfo.extractedPaths)) return;
        }
        var c = [1, 1, 1];
        try {
            var td = nfo.layer.text.sourceText.valueAtTime(startFrame / fps, false);
            if (td && td.fillColor) c = td.fillColor;
        } catch (e) {}
        writeBoundsGeo(arr, ind, nfo, c);
    }

    // Shape layer → triangulated outline of every Path / Rect / Ellipse
    // primitive in the layer's "Contents" tree.  Falls back to a bbox quad
    // coloured with the first Fill when no paths could be extracted (e.g.
    // a Star primitive, or a stroke-only / repeater-only layer).
    function writeShapeGeo(arr, ind, nfo) {
        if (nfo.extractedPaths && nfo.extractedPaths.length) {
            if (writeVectorMesh(arr, ind, nfo, nfo.extractedPaths)) return;
        }
        var c = [0.5, 0.5, 0.5];
        try {
            var found = findFirstFill(nfo.layer.property("Contents"));
            if (found) c = found;
        } catch (e) {}
        writeBoundsGeo(arr, ind, nfo, c);
    }

    function findFirstFill(prop) {
        if (!prop || !prop.numProperties) return null;
        for (var i = 1; i <= prop.numProperties; i++) {
            var sub;
            try { sub = prop.property(i); } catch (e) { continue; }
            if (sub && sub.matchName === "ADBE Vector Graphic - Fill") {
                try {
                    var col = sub.property("Color").value;
                    if (col) return col;
                } catch (e) {}
            }
            if (sub && sub.numProperties) {
                var found = findFirstFill(sub);
                if (found) return found;
            }
        }
        return null;
    }

    // Animated layer → linear BasisCurves trajectory.  Points are the layer's
    // per-frame world-space origin (from the path probe), so the curve is
    // static in world space — no further xform inside this prim.  Useful
    // as a layout / motion-tracking reference in Houdini; not meant for
    // rendering (renderable curves would need widths matched to scene scale).
    // Per-type displayColor: cam = yellow, light = orange, null = cyan,
    // AVLayer = green — easy to spot in the viewport.
    function writePathCurve(arr, ind, nfo) {
        if (!nfo.pathS || nfo.pathS.length < 2) return;
        var ind2 = ind + I1;
        var ind3 = ind2 + I1;

        // Convert probe samples (AE comp px) → AE_Scene-local USD coords.
        // Same sign-flip + scale conversion as the regular position pipeline,
        // so a curve point lines up with the layer's xform translation when
        // the layer was unparented (and stays correct under nesting).
        var pts = [];
        for (var i = 0; i < nfo.pathS.length; i++) {
            var s = nfo.pathS[i];
            var ux =  s[1] / scale;
            var uy = -s[2] / scale;
            var uz = -s[3] / scale;
            pts.push('(' + fmt(ux) + ', ' + fmt(uy) + ', ' + fmt(uz) + ')');
        }

        var col, label;
        if (nfo.isCam) {
            col = [1.0, 0.95, 0.2];   label = 'Camera path';
        } else if (nfo.isLight) {
            col = [1.0, 0.55, 0.15];  label = 'Light path';
        } else {
            var isNull = false;
            try { isNull = !!nfo.layer.nullLayer; } catch (e) {}
            if (isNull) {
                col = [0.2, 0.85, 1.0];  label = 'Null path';
            } else {
                col = [0.4, 1.0, 0.35];  label = 'Layer path';
            }
        }

        arr.push(ind + 'def BasisCurves "' + nfo.primName + '_path" (');
        arr.push(ind2 + 'doc = "' + esc(nfo.layer.name) + '  [' + label + ']"');
        arr.push(ind + ')');
        arr.push(ind + '{');
        arr.push(ind2 + 'uniform token type = "linear"');
        arr.push(ind2 + 'int[] curveVertexCounts = [' + pts.length + ']');
        arr.push(ind2 + 'point3f[] points = [' + pts.join(', ') + ']');
        // 1cm widths so the curve renders as a thin tube in viewports that
        // honour widths; renderers without curve support fall back to lines.
        var widths = [];
        for (var w = 0; w < pts.length; w++) widths.push('0.01');
        arr.push(ind2 + 'float[] widths = [' + widths.join(', ') + '] (');
        arr.push(ind3 + 'interpolation = "vertex"');
        arr.push(ind2 + ')');
        arr.push(ind2 + 'color3f[] primvars:displayColor = [(' +
            fmt(col[0]) + ', ' + fmt(col[1]) + ', ' + fmt(col[2]) + ')]');
        arr.push(ind + '}');
    }

    // Layer in/out points → USD visibility.  No emission if the layer is
    // visible across the entire export range (default = "inherited" = visible).
    // If layer is fully outside the range, emit a single static "invisible".
    // Otherwise emit timeSamples at the in/out boundaries.
    function writeVisibility(arr, ind, layer) {
        var inFrame, outFrame;
        try {
            inFrame  = Math.round(layer.inPoint  * fps);
            outFrame = Math.round(layer.outPoint * fps) - 1;   // outPoint exclusive
        } catch (e) { return; }

        var enters = (inFrame  > startFrame);
        var exits  = (outFrame < endFrame);

        // Visible across the whole range — nothing to emit.
        if (!enters && !exits) return;

        // Fully outside our range — mark static invisible.
        if (outFrame < startFrame || inFrame > endFrame) {
            arr.push(ind + 'token visibility = "invisible"');
            return;
        }

        // Partial overlap — emit transition timeSamples.  Token attrs hold
        // their value until the next sample, so two or three keys are enough.
        arr.push(ind + 'token visibility.timeSamples = {');
        if (enters) {
            arr.push(ind + '    ' + startFrame + ': "invisible",');
            arr.push(ind + '    ' + inFrame    + ': "inherited",');
        } else {
            arr.push(ind + '    ' + startFrame + ': "inherited",');
        }
        if (exits) {
            arr.push(ind + '    ' + (outFrame + 1) + ': "invisible",');
        }
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

    // UCS-2 JS string → UTF-8 byte string (each char's low byte == one UTF-8
    // byte, suitable for File.write() under encoding = "binary").
    function toUtf8Bytes(s) {
        var out = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c < 0x80) {
                out += String.fromCharCode(c);
            } else if (c < 0x800) {
                out += String.fromCharCode(0xC0 | (c >>> 6));
                out += String.fromCharCode(0x80 | (c & 0x3F));
            } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
                // Surrogate pair → 4-byte sequence
                var c2 = s.charCodeAt(i + 1);
                if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
                    var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
                    out += String.fromCharCode(0xF0 | (cp >>> 18));
                    out += String.fromCharCode(0x80 | ((cp >>> 12) & 0x3F));
                    out += String.fromCharCode(0x80 | ((cp >>> 6)  & 0x3F));
                    out += String.fromCharCode(0x80 | ( cp         & 0x3F));
                    i++;
                    continue;
                }
                // Lone high surrogate — fall through to 3-byte emit
                out += String.fromCharCode(0xE0 | (c >>> 12));
                out += String.fromCharCode(0x80 | ((c >>> 6) & 0x3F));
                out += String.fromCharCode(0x80 | (c & 0x3F));
            } else {
                out += String.fromCharCode(0xE0 | (c >>> 12));
                out += String.fromCharCode(0x80 | ((c >>> 6) & 0x3F));
                out += String.fromCharCode(0x80 | (c & 0x3F));
            }
        }
        return out;
    }

})();
