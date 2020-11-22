/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    let KIRI = self.kiri,
        BASE = self.base,
        UTIL = BASE.util,
        CAM = KIRI.driver.CAM,
        PRO = CAM.process,
        POLY = BASE.polygons,
        newSlice = KIRI.newSlice,
        newPoint = BASE.newPoint,
        newPolygon = BASE.newPolygon;

    /**
     * DRIVER SLICE CONTRACT
     *
     * @param {Object} settings
     * @param {Widget} widget
     * @param {Function} output
     */
    CAM.slice = function(settings, widget, onupdate, ondone) {
        let conf = settings,
            proc = conf.process,
            stock = settings.stock || {},
            hasStock = stock.x && stock.y && stock.z && proc.camStockOn,
            sliceAll = widget.slices = [],
            unitsName = settings.controller.units,
            roughTool = new CAM.Tool(conf, proc.camRoughTool),
            roughToolDiam = roughTool.fluteDiameter(),
            drillTool = new CAM.Tool(conf, proc.camDrillTool),
            drillToolDiam = drillTool.fluteDiameter(),
            procFacing = proc.camRoughOn && proc.camZTopOffset && hasStock,
            procRough = proc.camRoughOn && proc.camRoughDown,
            procRoughIn = proc.camRoughIn,
            procOutlineIn = proc.camOutlineIn,
            procOutlineOn = proc.camOutlineOn,
            procOutlineWide = proc.camOutlineWide,
            procOutline = procOutlineOn && proc.camOutlineDown,
            procContourX = proc.camContourXOn && proc.camOutlinePlunge,
            procContourY = proc.camContourYOn && proc.camOutlinePlunge,
            procContour = procContourX || procContourY,
            procDrill = proc.camDrillingOn && proc.camDrillDown && proc.camDrillDownSpeed,
            procDrillReg = proc.camDrillReg,
            procTrace = proc.camTraceOn,
            roughDown = procRough ? proc.camRoughDown : Infinity,
            outlineDown = procOutline ? proc.camOutlineDown : Infinity,
            sliceDepth = Math.max(0.1, Math.min(roughDown, outlineDown) / 3),
            addTabsOutline = (procOutlineOn || procRough) && proc.camTabsOn,
            tabWidth = proc.camTabsWidth,
            tabHeight = proc.camTabsHeight,
            bounds = widget.getBoundingBox(),
            mesh = widget.mesh,
            zBottom = proc.camZBottom,
            zMin = Math.max(bounds.min.z, zBottom),
            zMax = bounds.max.z,
            zThru = zBottom === 0 ? (proc.camZThru || 0) : 0,
            ztOff = hasStock ? proc.camZTopOffset : 0,
            camRoughStock = proc.camRoughStock,
            camRoughDown = proc.camRoughDown,
            minStepDown = Math.min(1, roughDown/3, outlineDown/3),
            maxToolDiam = 0,
            thruHoles;

        if (stock.x && stock.y && stock.z) {
            if (stock.x + 0.00001 < bounds.max.x - bounds.min.x) {
                return ondone('stock X too small for part. disable stock or use offset stock');
            }

            if (stock.y + 0.00001 < bounds.max.y - bounds.min.y) {
                return ondone('stock Y too small for part. disable stock or use offset stock');
            }

            if (stock.z + 0.00001 < bounds.max.z - bounds.min.z) {
                return ondone('stock Z too small for part. disable stock or use offset stock');
            }
        }

        if (sliceDepth <= 0.05) {
            return ondone(`invalid slice depth (${sliceDepth.toFixed(2)} ${unitsName})`);
        }

        if (!(procFacing || procRough || procOutline || procContour || procDrill || procDrillReg)) {
            return ondone("no processes selected");
        }

        if (zMin >= bounds.max.z) {
            return ondone(`invalid z bottom >= bounds z max ${bounds.max.z}`);
        }

        // allows progress output to me weighted and matched to processes
        let ops = [ [ "mapping", 1.5 ] ];
        if (procRough) ops.push([ "roughing", 1 ]);
        if (procRough) ops.push([ "rough offset", 1 ]);
        if (procOutline) ops.push([ "outline", 0.5 ]);
        if (procContour) ops.push([ "contour", 4 ]);
        let opsTot = ops.map(op => op[1]).reduce((a,v) => a + v);
        let opSum = 0;
        let opTot;
        let opOn;

        function nextOp() {
            if (opOn) opSum += opOn[1];
            opOn = ops.shift();
            opTot = opOn[1] / opsTot;
        }

        function updateOp(index, total, msg) {
            onupdate((opSum/opsTot) + (index/total) * opTot, msg || opOn[0]);
        }

        // TODO pass widget.isModified() on slice and re-use cache if false
        // TODO pre-slice in background from client signal
        // TODO same applies to topo map generation
        nextOp();
        let slicer = new KIRI.slicer2(widget.getPoints(), {
            zlist: true,
            zline: true
        });
        let tslices = [];
        let tshadow = [];
        let tzindex = slicer.interval(minStepDown, { fit: true, off: 0.01, down: true, flats: true });
        let terrain = slicer.slice(tzindex, { each: (data, index, total) => {
            tshadow = POLY.union(tshadow.appendAll(data.tops), 0.01, true);
            tslices.push(data.slice);
            if (false) {
                const slice = data.slice;
                sliceAll.push(slice);
                slice.output()
                    .setLayer("debug", {line: 0x888800, thin: true })
                    .addPolys(POLY.setZ(tshadow.clone(true), data.z), { thin: true });
            }
            updateOp(index, total);
        }, genso: true });
        let shadowTop = terrain[terrain.length - 1];

        if (procDrillReg) {
            maxToolDiam = Math.max(maxToolDiam, drillToolDiam);
            sliceDrillReg(settings, sliceAll, zThru);
        }

        // identify through holes
        thruHoles = tshadow.map(p => p.inner || []).flat();

        // create facing slices
        if (procFacing || proc.camRoughTop) {
            let shadow = tshadow.clone();
            let inset = POLY.offset(shadow, (roughToolDiam / (procRoughIn ? 2 : 1)));
            let facing = POLY.offset(inset, -(roughToolDiam * proc.camRoughOver), { count: 999, flat: true });
            let zdiv = ztOff / roughDown;
            let zstep = (zdiv % 1 > 0) ? ztOff / (Math.floor(zdiv) + 1) : roughDown;
            if (proc.camRoughTop && ztOff === 0) {
                // compensate for lack of z top offset in this scenario
                ztOff = zstep;
            }
            for (let z = zMax + ztOff - zstep; z >= zMax; z -= zstep) {
                let slice = shadowTop.slice.clone(false);
                slice.z = z;
                slice.camMode = PRO.LEVEL;
                slice.camLines = POLY.setZ(facing.clone(true), slice.z);
                slice.output()
                    .setLayer("facing", {face: 0, line: 0})
                    .addPolys(slice.camLines);
                sliceAll.push(slice);
            }
        }

        // create roughing slices
        if (procRough) {
            nextOp();
            maxToolDiam = Math.max(maxToolDiam, roughToolDiam);

            let flats = [];
            let shadow = [];
            let slices = [];
            let indices = slicer.interval(roughDown, { down: true, min: zBottom, fit: true });
            if (proc.camRoughFlat) {
                let flats = Object.keys(slicer.zFlat)
                    .map(v => parseFloat(v).round(4))
                    .filter(v => v >= zBottom);
                flats.forEach(v => {
                    if (!indices.contains(v)) {
                        indices.push(v);
                    }
                });
                indices = indices.sort((a,b) => { return b - a });
                // if layer is not on a flat and next one is,
                // then move this layer up to mid-point to previous layer
                // this is not perfect. the best method is to interpolate
                // between flats so that each step is < step down. on todo list
                for (let i=1; i<indices.length-1; i++) {
                    const prev = indices[i-1];
                    const curr = indices[i];
                    const next = indices[i+1];
                    if (!flats.contains(curr) && flats.contains(next)) {
                        // console.log('move',curr,'up toward',prev,'b/c next',next,'is flat');
                        indices[i] = next + ((prev - next) / 2);
                    }
                }
            } else {
                // add flats to shadow
                flats = Object.keys(slicer.zFlat)
                    .map(v => (parseFloat(v) - 0.01).round(5))
                    .filter(v => v > 0 && indices.indexOf(v) < 0);
                indices = indices.appendAll(flats).sort((a,b) => b-a);
            }
            // console.log('indices', ...indices, {zBottom});
            slicer.slice(indices, { each: (data, index, total) => {
                shadow = POLY.union(shadow.appendAll(data.tops), 0.01, true);
                if (flats.indexOf(data.z) >= 0) {
                    // exclude flats injected to complete shadow
                    return;
                }
                data.shadow = shadow.clone(true);
                data.slice.camMode = PRO.ROUGH;
                data.slice.shadow = data.shadow;
                // data.slice.tops[0].inner = data.shadow;
                // data.slice.tops[0].inner = POLY.setZ(tshadow.clone(true), data.z);
                slices.push(data.slice);
                updateOp(index, total);
            }, genso: true });

            shadow = POLY.union(shadow.appendAll(shadowTop.tops), 0.01, true);

            // inset or eliminate thru holes from shadow
            shadow = POLY.flatten(shadow.clone(true), [], true);
            thruHoles.forEach(hole => {
                shadow = shadow.map(p => {
                    if (p.isEquivalent(hole)) {
                        // eliminate thru holes when roughing voids enabled
                        if (proc.camRoughVoid) {
                            return undefined;
                        }
                        let po = POLY.offset([p], -(roughToolDiam + camRoughStock));
                        return po ? po[0] : undefined;
                    } else {
                        return p;
                    }
                }).filter(p => p);
            });
            shadow = POLY.nest(shadow);

            // expand shadow by half tool diameter + stock to leave
            const sadd = procRoughIn ? roughToolDiam / 4 : roughToolDiam / 2;
            const shell = POLY.offset(shadow, sadd + camRoughStock);

            nextOp();
            slices.forEach((slice, index) => {
                let offset = [shell.clone(true),slice.shadow.clone(true)].flat();
                let flat = POLY.flatten(offset, [], true);
                let nest = POLY.setZ(POLY.nest(flat), slice.z);

                // inset offset array by 1/2 diameter then by tool overlap %
                offset = POLY.offset(nest, [-(roughToolDiam / 2 + camRoughStock), -roughToolDiam * proc.camRoughOver], {
                    z: slice.z,
                    count: 999,
                    flat: true,
                    call: (polys, count, depth) => {
                        // used in depth-first path creation
                        polys.forEach(p => {
                            p.depth = depth;
                            if (p.inner) {
                                p.inner.forEach(p => p.depth = depth);
                            }
                        });
                    }
                }) || [];

                // add outside pass if not inside only
                if (!procRoughIn) {
                    const outside = POLY.offset(shadow.clone(), roughToolDiam * proc.camRoughOver, {z: slice.z});
                    if (outside) {
                        offset.appendAll(outside);
                        if (addTabsOutline && slice.z <= zMin + tabHeight) {
                            offset = addCutoutTabs(offset, slice.z, roughToolDiam, tabWidth, proc.camTabsCount, proc.camTabsAngle, slice);
                        }
                    }
                }

                if (!offset) return;

                slice.camLines = offset;
                if (true) slice.output()
                    .setLayer("slice", {line: 0xaaaa00}, true)
                    .addPolys(slice.topPolys())
                    // .setLayer("top shadow", {line: 0x0000aa})
                    // .addPolys(tshadow)
                    // .setLayer("rough shadow", {line: 0x00aa00})
                    // .addPolys(shadow)
                    // .setLayer("rough shell", {line: 0xaa0000})
                    // .addPolys(shell);
                slice.output()
                    .setLayer("roughing", {face: 0, line: 0})
                    .addPolys(offset);
                updateOp(index, slices.length);
            });

            sliceAll.appendAll(slices.filter(slice => slice.camLines));
        }

        // create outline slices
        if (procOutline) {
            nextOp();
            let outlineTool = new CAM.Tool(conf, proc.camOutlineTool);
            let outlineToolDiam = outlineTool.fluteDiameter();
            maxToolDiam = Math.max(maxToolDiam, outlineToolDiam);

            let shadow = [];
            let slices = [];
            let indices = slicer.interval(outlineDown, { down: true, min: zBottom, fit: true });
            // add flats to shadow
            const flats = Object.keys(slicer.zFlat)
                .map(v => (parseFloat(v) - 0.01).round(5))
                .filter(v => v > 0 && indices.indexOf(v) < 0);
            indices = indices.appendAll(flats).sort((a,b) => b-a);
            // console.log('indices', ...indices, {zBottom, slicer});
            slicer.slice(indices, { each: (data, index, total) => {
                shadow = POLY.union(shadow.appendAll(data.tops), 0.01, true);
                if (flats.indexOf(data.z) >= 0) {
                    // exclude flats injected to complete shadow
                    return;
                }
                data.shadow = shadow.clone(true);
                data.slice.camMode = PRO.OUTLINE;
                data.slice.shadow = data.shadow;
                // data.slice.tops[0].inner = data.shadow;
                // data.slice.tops[0].inner = POLY.setZ(tshadow.clone(true), data.z);
                slices.push(data.slice);
                // data.slice.xray();
                // onupdate(0.2 + (index/total) * 0.1, "outlines");
                updateOp(index, total);
            }, genso: true });
            shadow = POLY.union(shadow.appendAll(shadowTop.tops), 0.01, true);

            // extend cut thru (only when z bottom is 0)
            if (zThru) {
                let last = slices[slices.length-1];
                let add = last.clone(true);
                add.camMode = last.camMode;
                add.tops.forEach(top => {
                    top.poly.setZ(add.z);
                });
                add.shadow = last.shadow.clone(true);
                add.z -= zThru;
                slices.push(add);
            }

            slices.forEach(slice => {
                let tops = slice.shadow;
                let offset = POLY.expand(tops, outlineToolDiam / 2, slice.z);
                if (!(offset && offset.length)) {
                    return;
                }

                // when pocket only, drop first outer poly
                // if it matches the shell and promote inner polys
                if (procOutlineIn) {
                    let shell = POLY.expand(tops.clone(), outlineToolDiam / 2);
                    offset = POLY.filter(offset, [], function(poly) {
                        if (poly.area() < 1) {
                            return null;
                        }
                        for (let sp=0; sp<shell.length; sp++) {
                            // eliminate shell only polys
                            if (poly.isEquivalent(shell[sp])) {
                                if (poly.inner) return poly.inner;
                                return null;
                            }
                        }
                        return poly;
                    });
                } else {
                    if (procOutlineWide) {
                        offset.slice().forEach(op => {
                            // clone removes inners but the real solution is
                            // to limit expanded shells to through holes
                            POLY.expand([op.clone()], outlineToolDiam * 0.5, slice.z, offset, 1);
                        });
                    }
                }

                if (addTabsOutline && slice.z <= zMin + tabHeight) {
                    offset = addCutoutTabs(offset, slice.z, outlineToolDiam, tabWidth, proc.camTabsCount, proc.camTabsAngle);
                }

                // offset.xout(`slice ${slice.z}`);
                slice.camLines = offset;
                if (true) slice.output()
                    .setLayer("slice", {line: 0xaaaa00}, true)
                    .addPolys(slice.topPolys())
                slice.output()
                    .setLayer("outline", {face: 0, line: 0})
                    .addPolys(offset);
            });

            sliceAll.appendAll(slices);
        }

        // we need topo for safe travel moves when roughing and outlining
        // not generated when drilling-only. then all z moves use bounds max.
        // also generates x and y contouring when selected
        if (procContour) {
            nextOp();
            new CAM.Topo(widget, settings, {
                // onupdate: (update, msg) => {
                onupdate: (index, total, msg) => {
                    updateOp(index, total, msg);
                    // onupdate(0.30 + update * 0.50, msg || "create topo");
                },
                ondone: (slices) => {
                    sliceAll.appendAll(slices);
                },
                shadow: tshadow
            });
        }

        // prepare for tracing paths
        let traceTool;
        let traceToolProfile;
        if (procTrace) {
            traceTool = getToolById(conf, proc.camTraceTool);
            if (traceTool.type !== 'endmill') {
                traceToolProfile = createToolProfile(conf, proc.camTraceTool, widget.topo);
            }
        }

        if (procDrill) {
            maxToolDiam = Math.max(maxToolDiam, drillToolDiam);
            sliceDrill(drillTool, tslices, sliceAll);
        }

        sliceAll.forEach((slice, index) => slice.index = index);

        // used in printSetup()
        widget.terrain = terrain;
        widget.maxToolDiam = maxToolDiam;

        ondone();
    };

    // drilling op
    function sliceDrill(tool, slices, output) {
        let drills = [],
            drillToolDiam = tool.fluteDiameter(),
            centerDiff = drillToolDiam * 0.1,
            area = (drillToolDiam/2) * (drillToolDiam/2) * Math.PI,
            areaDelta = area * 0.05;

        // for each slice, look for polygons with 98.5% circularity whose
        // area is within the tolerance of a circle matching the tool diameter
        slices.forEach(function(slice) {
            let inner = slice.topPolyInners([]);
            inner.forEach(function(poly) {
                if (poly.circularity() >= 0.985 && Math.abs(poly.area() - area) <= areaDelta) {
                    let center = poly.circleCenter(),
                        merged = false,
                        closest = Infinity,
                        dist;
                    // TODO reject if inside camShellPolys (means there is material above)
                    // if (center.isInPolygon(camShellPolys)) return;
                    drills.forEach(function(drill) {
                        if (merged) return;
                        if ((dist = drill.last().distTo2D(center)) <= centerDiff) {
                            merged = true;
                            drill.push(center);
                        }
                        closest = Math.min(closest,dist);
                    });
                    if (!merged) {
                        drills.push(newPolygon().append(center));
                    }
                }
            });
        });

        // drill points to use center (average of all points) of the polygon
        drills.forEach(function(drill) {
            let center = drill.center(true),
                slice = newSlice(0,null);
            drill.points.forEach(function(point) {
                point.x = center.x;
                point.y = center.y;
            });
            slice.camMode = PRO.DRILL;
            slice.camLines = [ drill ];
            slice.output()
                .setLayer("drill", {face: 0, line: 0})
                .addPolys(drill);
            output.append(slice);
        });
    }

    // drill registration holes
    function sliceDrillReg(settings, output, zThru) {
        let proc = settings.process,
            stock = settings.stock,
            bounds = settings.bounds,
            mx = (bounds.max.x + bounds.min.x) / 2,
            my = (bounds.max.y + bounds.min.y) / 2,
            mz = zThru || 0,
            dx = (stock.x - (bounds.max.x - bounds.min.x)) / 4,
            dy = (stock.y - (bounds.max.y - bounds.min.y)) / 4,
            dz = stock.z,
            points = [];

        switch(proc.camDrillReg) {
            case "x axis":
                points.push(newPoint(bounds.min.x - dx, my, 0));
                points.push(newPoint(bounds.max.x + dx, my, 0));
                break;
            case "y axis":
                points.push(newPoint(mx, bounds.min.y - dy, 0));
                points.push(newPoint(mx, bounds.max.y + dy, 0));
                break;
        }

        if (points.length) {
            let slice = newSlice(0,null), polys = [];
            points.forEach(point => {
                polys.push(newPolygon()
                    .append(point.clone().setZ(bounds.max.z))
                    .append(point.clone().setZ(bounds.max.z - stock.z - mz)));
            });
            slice.camMode = PRO.DRILL;
            slice.camLines = polys;
            slice.output()
                .setLayer("register", {face: 0, line: 0})
                .addPolys(polys);
            output.append(slice);
        }
    }

    // cut outside traces at the right points
    function addCutoutTabs(polys, z, toolDiam, tabWidth, tabCount, tabAngle, slice) {
        // skip if no tops | traces
        if (polys.length === 0) return polys;

        let notabs = 0;
        let nutrace = [];

        polys.forEach(function(trace, index) {
            // required to match computed order of cutouts
            trace.setClockwise();

            let ints = [];
            let center = trace.bounds.center(z);
            CAM.createTabLines(center, toolDiam, tabWidth, tabCount, tabAngle).forEach(tab => {
                const {c1, c2, o1, o2} = tab,
                    int1 = trace.intersections(c1, o1).pop(),
                    int2 = trace.intersections(c2, o2).pop();
                if (int1 && int2) {
                    ints.push(int1);
                    ints.push(int2);
                    // slice.output().setLayer('int',0xff0000).addLine(int1, int2);
                }
            });

            let segs = [];
            if (ints.length) {
                ints.push(ints.shift());
                // let cv = 0;
                for (let i=0; i<ints.length; i+=2) {
                    const seg = trace.emitSegment(ints[i], ints[i+1]);
                    // const col = [0x0000ff,0x009900,0x999900];
                    // seg.setZ(seg.getZ()+i);
                    // seg.points.forEach((p,i) => p.z += (i*0.01));
                    // slice.output().setLayer(`seg${i}`,col[cv++]).addPoly(seg);
                    // slice.output().setLayer(`seg${i}`).addPoly(newPolygon().centerCircle(seg.first(),1,5));
                    // slice.output().setLayer(`seg${i}`).addPoly(newPolygon().centerCircle(seg.last(),1,4));
                    // slice.output().setLayer(`seg${i}`).addPoly(newPolygon().centerCircle(trace.first(),2,5));
                    // slice.output().setLayer(`seg${i}`).addPoly(newPolygon().centerCircle(trace.last(),2,4));
                    segs.push(seg);
                }
                // check for and eliminate overlaps
                if (false)
                for (let i=0, il=segs.length; i < il; i++) {
                    let si = segs[i];
                    for (let j=i+1; j<il; j++) {
                        let sj = segs[j];
                        if (sj.overlaps(si)) {
                            if (sj.perimeter() > si.perimeter()) {
                                sj._overlap = true;
                            }
                        }
                    }
                }
                // replace intersected trace with non-overlapping segments
                nutrace.appendAll(segs.filter(seg => !seg._overlap));
            } else {
                nutrace.push(trace);
                notabs++;
            }
        });

        if (notabs) {
            console.log(`unable to compute tabs for ${notabs} traces @ z=${z}`);
        }

        return nutrace;
    }

    CAM.createTabLines = function(center, toolDiam, tabWidth, tabCount, tabAngle) {
        let angle_inc = 360 / tabCount,
            offset = (tabWidth + toolDiam) / 2,
            lines = [];

        while (tabCount-- > 0) {
            let slope = BASE.newSlopeFromAngle(tabAngle),
                normal = BASE.newSlopeFromAngle(tabAngle + 90),
                c1 = center.projectOnSlope(normal, offset),
                c2 = center.projectOnSlope(normal, -offset),
                o1 = c1.projectOnSlope(slope, 10000),
                o2 = c2.projectOnSlope(slope, 10000);
            tabAngle -= angle_inc;
            lines.push({c1, o1, c2, o2});
        }

        return lines;
    }

})();
