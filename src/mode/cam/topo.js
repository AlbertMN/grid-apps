/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    let KIRI = self.kiri,
        BASE = self.base,
        CAM = KIRI.driver.CAM,
        PRO = CAM.process,
        POLY = BASE.polygons,
        RAD2DEG = 180 / Math.PI,
        newSlice = KIRI.newSlice,
        newLine = BASE.newLine,
        newSlope = BASE.newSlope,
        newPoint = BASE.newPoint,
        newPolygon = BASE.newPolygon,
        noop = function() {};

    class Topo {
        constructor(widget, settings, options) {
            const opt = options || {},
                ondone = opt.ondone || noop,
                onupdate = opt.onupdate || noop,
                shadow = opt.shadow,
                proc = settings.process,
                inside = proc.camContourIn,
                resolution = proc.camTolerance,
                tool = new CAM.Tool(settings, proc.camContourTool),
                toolOffset = tool.generateProfile(resolution).profile,
                toolDiameter = tool.fluteDiameter(),
                toolStep = toolDiameter * proc.camContourOver,
                traceJoin = toolDiameter / 2,
                pocketOnly = proc.camOutlinePocket,
                bounds = widget.getBoundingBox().clone(),
                minX = bounds.min.x,
                maxX = bounds.max.x,
                minY = bounds.min.y,
                maxY = bounds.max.y,
                zBottom = proc.camZBottom,
                zMin = Math.max(bounds.min.z, zBottom) + 0.0001,
                boundsX = maxX - minX,
                boundsY = maxY - minY,
                maxangle = proc.camContourAngle,
                curvesOnly = proc.camContourCurves,
                R2A = 180 / Math.PI,
                stepsx = Math.ceil(boundsX / resolution),
                stepsy = Math.ceil(boundsY / resolution),
                data = new Float32Array(stepsx * stepsy),
                topo = this.topo = widget.topo = {
                    data: data,
                    stepsx: stepsx,
                    stepsy: stepsy,
                    bounds: bounds,
                    diameter: toolDiameter,
                    resolution: resolution,
                    profile: toolOffset,
                    widget: widget
                },
                newslices = [],
                tabsOn = proc.camTabsOn,
                tabHeight = proc.camTabsHeight + zBottom,
                clipTab = tabsOn ? [] : null,
                clipTo = inside ? shadow : POLY.expand(shadow, toolDiameter/2 + resolution * 3),
                partOff = inside ? 0 : toolDiameter / 2 + resolution,
                gridDelta = Math.floor(partOff / resolution),
                center = opt.center,
                debug = false,
                debug_clips = debug && true,
                debug_topo = debug && false,
                debug_topo_lines = debug && false,
                debug_topo_shells = debug && false;

            if (proc.camTabsOn) {
                CAM.createTabLines(
                    center,
                    toolDiameter,
                    proc.camTabsWidth,
                    proc.camTabsCount,
                    proc.camTabsAngle
                ).forEach(tab => {
                    const { o1, o2, c1, c2 } = tab;
                    const poly = newPolygon().addPoints([
                        o1, c1, c2, o2
                    ]);
                    clipTab.push(poly);
                });
            }

            // debug clipTab and clipTo
            if (debug_clips) {
                const debug = newSlice(-1);
                const output = debug.output();
                // if (clipTab) output.setLayer("clip.tab", { line: 0xff0000 }).addPolys(clipTab);
                if (clipTo) output.setLayer("clip.to", { line: 0x00dd00 }).addPolys(clipTo);
                newslices.push(debug);
            }

            let newtrace,
                sliceout,
                latent,
                lastP,
                slice, lx, ly,
                startTime = time(),
                stepsTaken = 0,
                stepsTotal = 0;

            // return the touching z given topo x,y and a tool profile
            function toolAtZ(x,y) {
                const profile = toolOffset,
                    sx = stepsx,
                    sy = stepsy,
                    xl = sx - 1,
                    yl = sy - 1;

                let tx, ty, tz, gv, i = 0, mz = -1;

                while (i < profile.length) {
                    // tool profile point x, y, and z offsets
                    const tx = profile[i++] + x;
                    const ty = profile[i++] + y;
                    const tz = profile[i++];
                    if (tx < 0 || tx > xl || ty < 0 || ty > yl) {
                        // if outside max topo steps, use zMin
                        gv = zMin;
                    } else {
                        // lookup grid value @ tx, ty
                        gv = topo.data[tx * sy + ty] || zMin;
                    }
                    // update the rest
                    mz = Math.max(tz + gv, mz);
                }

                return Math.max(mz, 0);
            }

            function push_point(x,y,z) {
                const newP = newPoint(x,y,z);
                // todo: merge co-linear, not just co-planar
                if (lastP && lastP.z === z) {
                    if (curvesOnly) {
                        end_poly();
                    } else {
                        latent = newP;
                    }
                } else {
                    if (latent) {
                        newtrace.push(latent);
                        latent = null;
                    }
                    if (curvesOnly && lastP) {
                        // maxangle
                        const dz = Math.abs(lastP.z - z);
                        const dxy = Math.max(Math.abs(lastP.x - x), Math.abs(lastP.y - y));
                        const angle = Math.atan2(dz, dxy) * RAD2DEG;
                        // if (lastP.z < 0.1) console.log('pp', {dz, dxy, angle});
                        if (angle > maxangle) {
                            lastP = newP;
                            return;
                        }
                    }
                    newtrace.push(newP);
                }
                lastP = newP;
            }

            function end_poly() {
                if (latent) {
                    newtrace.push(latent);
                }
                if (newtrace.length > 0) {
                    // add additional constraint on min perimeter()
                    if (newtrace.length > 1) {
                        sliceout.push(newtrace);
                    }
                    newtrace = newPolygon().setOpen();
                }
                latent = undefined;
                lastP = undefined;
            }

            function processSlices(slices) {
                let gridx = 0,
                    gridy,
                    gridi, // index
                    gridv, // value
                    i, il, j, jl, x, y, tv, ltv;

                // filter lines pairs to only surface "up-facing", "uncovered" lines
                slices.map(slice => {
                    newslices.push(slice);
                    const points = [];
                    // emit an array of valid line-pairs
                    const lines = slice.lines;
                    const len = lines.length;
                    outer: for (let i=0; i<len; i++) {
                        let l1 = lines[i], p1 = l1.p1, p2 = l1.p2;
                        // eliminate vertical
                        if (p1.y === p2.y) continue;
                        // eliminate if both points below cutoff
                        if (p1.z < zMin && p2.z < zMin) continue;
                        // sort p1,p2 by y for comparison
                        if (p1.y > p2.y) { const tp = p1; p1 = p2; p2 = tp };
                        // eliminate if points "under" other lines
                        for (let j=0; j<len; j++) {
                            // skip self and adjacent
                            if (j >= i-1 && j <= i+1) continue;
                            let l2 = lines[j], p3 = l2.p1, p4 = l2.p2;
                            // sort p3,p4 by y for comparison
                            if (p3.y > p4.y) { const tp = p3; p3 = p4; p4 = tp };
                            // it's under the other line
                            if (Math.max(p1.z,p2.z) < Math.min(p3.z,p4.z)) {
                                // it's inside the other line, too, so skip
                                if (p1.y >= p3.y && p2.y <= p4.y) continue outer;
                            }
                        }
                        points.push(p1, p2);
                    }
                    slice.points = points;
                    if (debug_topo_lines) slice.output()
                        .setLayer("topo lines", {face: 0xff00ff, line: 0x880088})
                        .addLines(points);
                    if (debug_topo_shells) slice.output()
                        .setLayer("topo shells", {face: 0xff00ff, line: 0x008888})
                        .addPolys(slice.topPolys());
                });

                // raster grid: for each Y slice, find z grid value (x/z swapped)
                for (j=0, jl=slices.length; j<jl; j++) {
                    const slice = slices[j];
                    const points = slice.points;
                    gridy = 0;
                    // rasterize one x slice
                    for (y = minY; y < maxY && gridy < stepsy; y += resolution) {
                        gridi = gridx * stepsy + gridy;
                        gridv = data[gridi] || 0;
                        // strategy using raw lines (faster slice, but more lines)
                        for (i=0, il=points.length; i<il; i += 2) {
                            const p1 = points[i], p2 = points[i+1];
                            // one endpoint above grid
                            const crossz = (p1.z > gridv || p2.z > gridv);
                            // segment crosses grid y
                            const spansy = (p1.y <= y && p2.y >= y);
                            if (crossz && spansy) {
                                // compute intersection of z ray up
                                // and segment at this grid point
                                const dy = p1.y - p2.y,
                                    dz = p1.z - p2.z,
                                    pct = (p1.y - y) / dy,
                                    nz = p1.z - (dz * pct);
                                // save if point is greater than existing grid point
                                if (nz > gridv) {
                                    gridv = data[gridi] = Math.max(nz, zMin);
                                    if (debug_topo) slice.output()
                                        .setLayer("topo", {face: 0, line: 0})
                                        .addLine(
                                            newPoint(p1.x, y, 0),
                                            newPoint(p1.x, y, gridv)
                                        );
                                }
                            }
                        }
                        gridy++;
                    }
                    gridx++;
                    onupdate(++stepsTaken, stepsTotal, "raster surface");
                }

                const checkr = newPoint(0,0);
                const inClip = function(polys) {
                    checkr.x = x;
                    checkr.y = y;
                    for (let i=0; i<polys.length; i++) {
                        if (checkr.isInPolygon(polys[i])) {
                            return true;
                        }
                    }
                    return false;
                };

                // x contouring
                if (proc.camContourXOn) {
                    startTime = time();
                    // emit slice per X
                    for (x = minX - partOff; x <= maxX + partOff; x += toolStep) {
                        gridx = Math.round(((x - minX) / boundsX) * stepsx);
                        ly = gridy = -gridDelta;
                        slice = newSlice(gridx);
                        slice.camMode = PRO.CONTOUR_X;
                        newtrace = newPolygon().setOpen();
                        sliceout = [];
                        for (y = minY - partOff; y < maxY + partOff; y += resolution) {
                            // find tool z at grid point
                            tv = toolAtZ(gridx, gridy);
                            // when tabs are on and this point is inside the
                            // tab polygon, ensure z is at least tabHeight
                            if (tabsOn && tv < tabHeight && inClip(clipTab)) {
                                tv = tabHeight;
                            }
                            // if the value is on the floor and inside the clip
                            // poly (usually shadow), end the segment
                            if (clipTo && !inClip(clipTo)) {
                                end_poly();
                                gridy++;
                                ly = -gridDelta;
                                continue;
                            }
                            push_point(x,y,tv);
                            ly = y;
                            ltv = tv;
                            gridy++;
                        }
                        end_poly();
                        if (sliceout.length > 0) {
                            newslices.push(slice);
                            slice.camLines = sliceout;
                            slice.output()
                                .setLayer("contour x", {face: 0, line: 0})
                                .addPolys(sliceout);
                        }
                        onupdate(++stepsTaken, stepsTotal, "contour x");
                    }
                }

                // y contouring
                if (proc.camContourYOn) {
                    startTime = time();
                    // emit slice per Y
                    for (y = minY - partOff; y <= maxY + partOff; y += toolStep) {
                        gridy = Math.round(((y - minY) / boundsY) * stepsy);
                        lx = gridx = -gridDelta;
                        slice = newSlice(gridy);
                        slice.camMode = PRO.CONTOUR_Y;
                        newtrace = newPolygon().setOpen();
                        sliceout = [];
                        for (x = minX - partOff; x <= maxX + partOff; x += resolution) {
                            tv = toolAtZ(gridx, gridy);
                            if (tabsOn && tv < tabHeight && inClip(clipTab)) {
                                tv = tabHeight;
                            }
                            if (clipTo && !inClip(clipTo)) {
                                end_poly();
                                gridx++;
                                lx = -gridDelta;
                                continue;
                            }
                            push_point(x,y,tv);
                            lx = x;
                            ltv = tv;
                            gridx++;
                        }
                        end_poly();
                        if (sliceout.length > 0) {
                            newslices.push(slice);
                            slice.camLines = sliceout;
                            slice.output()
                                .setLayer("contour y", {face: 0, line: 0})
                                .addPolys(sliceout);
                        }
                        onupdate(++stepsTaken, stepsTotal, "contour y");
                    }
                }

                ondone(newslices);
            }

            let slicer = new KIRI.slicer2(widget.getPoints(), { swapX: true });
            let sindex = slicer.interval(resolution);
            stepsTotal += sindex.length * 2;
            if (proc.camContourXOn) stepsTotal += (maxX-minX) / toolStep;
            if (proc.camContourYOn) stepsTotal += (maxY-minY) / toolStep;

            let slices = slicer.slice(sindex, { each: (data, index, total) => {
                onupdate(++stepsTaken, stepsTotal, "topo slice");
            }, genso: true });

            processSlices(slices.filter(s => s.lines).map(data => data.slice));
        }
    }

    CAM.Topo = Topo;

})();
