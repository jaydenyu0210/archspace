# DXF R12 — what a hand-written file has to get right

Research commissioned while building `aec.export_dxf` (see
[ADR-0015](../adr/0015-dxf-export.md)), covering three angles: the file
skeleton, entity encoding, and what real readers actually do. It exists because
this project writes DXF by hand and cannot test in AutoCAD, so the question
"will this open?" has to be answered from the specification and from other
people's reproduced failures rather than from trying it.

Findings marked *reproduced* were verified by the researcher against a real
reader (ezdxf 1.4.4, and libdxfrw source for LibreCAD/QCAD behaviour). The
implementation in `packages/nodes-core/src/dxf.ts` follows this document; where
it deliberately does not, the reason is in ADR-0015.

Sources are listed per section at the end.

---

## Summary recommendation

Emit DXF R12 with `$ACADVER = AC1009`, because R12 is the only version whose complete file is hand-writable with no handles (group 5), no subclass markers (group 100), no owner pointers (330), no BLOCK_RECORD table and no OBJECTS/CLASSES sections — it deletes every class of structural failure we cannot test for without AutoCAD, and all five target readers read it. Write exactly four sections in the order HEADER, TABLES (LTYPE → LAYER → STYLE), BLOCKS (deliberately empty), ENTITIES, terminated by `0/EOF`; write no group 5 anywhere and no `$HANDSEED`. Geometry vocabulary is LINE, POLYLINE/VERTEX/SEQEND, TEXT and ARC only — never LWPOLYLINE (verified: it hard-rejects the whole file in an AC1009 header), never MTEXT, HATCH, DIMENSION, SOLID or MLINE, and never groups 39 or 210/220/230. Coordinates are written in millimetres 1:1 with no scaling, `$INSUNITS = 4` and `$MEASUREMENT = 1` appended as the last two header variables behind a single flag (they post-date R12; unknown header names are skipped, and ezdxf reads them back as "mm" from an AC1009 file). Bytes are cp1252 with CRLF line endings, group codes right-justified in a 3-character field, value lines never padded; reals are always `toFixed(4)` with no trimming and no exponents, integers are always `String(Math.round(v))`, and any non-finite or out-of-range number throws instead of being clamped. Text labels use TEXT with `72/1` + `73/2` and `11/21/31` set equal to `10/20/30` — the missing alignment point is the single most common hand-written-DXF bug and it is invisible in an ezdxf test. Walls are four plain LINEs (two faces offset ±t/2 plus two end caps), rooms are a closed POLYLINE with `66/1` and `70/1` on a separate layer, doors are jamb LINEs on the wall layer plus a leaf LINE and swing ARC on the door layer, and levels are separated by an `L##-` layer-name prefix rather than blocks. Every layer, linetype and style referenced is defined in the TABLES section — an undefined linetype is documented in ezdxf's own audit source as a file AutoCAD refuses to load while ezdxf merely strips it, so a passing local test proves nothing there. The whole file must pass the §7 checklist mechanically plus `ezdxf.readfile` + `audit()` with **0 errors and 0 fixes** (treat any fix as a failure), and byte-diff against the golden file in `minimalExample`.

---

## File skeleton: DXF version, sections, section order, and low-level text format

Target R12, `$ACADVER` = `AC1009`, and write exactly three sections: HEADER, TABLES, ENTITIES, terminated by `0/EOF`. The usual argument for R2000 — "LWPOLYLINE is far more compact" — is false at the whole-file level for a floor plan, and I measured it: R2000 makes a handle (`5`), an owner handle (`330`) and two subclass markers (`100/AcDbEntity`, `100/AcDbLine`) mandatory on *every* entity, which costs more on wall LINEs than LWPOLYLINE saves on room polygons. A synthetic plan (200 walls, 40 doors, 20 six-vertex rooms, 20 labels) came out at 39 KB as R12 versus 52 KB as R2000, so R12 is both more compatible *and* smaller here. R12 also removes the entire class of silent failures you cannot test for: no CLASSES section, no OBJECTS section, no root DICTIONARY, no BLOCK_RECORD table, no LAYOUT objects, no handle graph to get wrong — a hand-written R2000 file needs ~4.8 KB of cross-referenced handle boilerplate (`330`/`340`/`350` pointers) before a single wall is drawn, and every one of those pointers is an untestable chance to produce a file that opens in ezdxf but not AutoCAD. What R12 costs you: no LWPOLYLINE (rooms become POLYLINE + VERTEX + SEQEND, ~1.8× the bytes for the polygon part alone), no MTEXT (single-line TEXT only, so room name and area are two TEXT entities or one line), no true colour / lineweight / transparency (ACI colour index 1–255 only), no *official* `$INSUNITS`, and symbol-name limits of 31 characters with no spaces. Do not try to smuggle LWPOLYLINE into an `AC1009` file: I tested it and ezdxf hard-fails the whole file with `DXFStructureError: missing 'AcDbPolyline' subclass in LWPOLYLINE`. Write no handles at all and no `$HANDSEED` (handles are optional in R12 and ezdxf's own battle-tested `r12writer` omits them entirely); use CRLF, group codes right-justified in a 3-character field, and fixed-point decimals with no exponents.

### Group codes

- `SECTION START: 0/SECTION, 2/<HEADER|TABLES|BLOCKS|ENTITIES>  — the 2 group naming the section is mandatory and must immediately follow`
- `SECTION END: 0/ENDSEC   —   FILE END: 0/EOF (mandatory; LibreCAD/libdxfrw returns BAD_UNKNOWN and rejects the whole file without it)`
- `HEADER VARIABLE: 9/$VARNAME followed by the value tag(s) for that variable`
- `$ACADVER: 9/$ACADVER, 1/AC1009   (AC1006=R10, AC1009=R11+R12, AC1015=R2000, AC1021=R2007, AC1032=R2018)`
- `$INSBASE: 9/$INSBASE, 10/x, 20/y, 30/z   (three codes — 30 is required)`
- `$EXTMIN: 9/$EXTMIN, 10/x, 20/y, 30/z`
- `$EXTMAX: 9/$EXTMAX, 10/x, 20/y, 30/z`
- `$LIMMIN: 9/$LIMMIN, 10/x, 20/y   (TWO codes only — no 30; writing a 30 here is wrong)`
- `$LIMMAX: 9/$LIMMAX, 10/x, 20/y   (TWO codes only — no 30)`
- `$LUNITS: 9/$LUNITS, 70/2   (2 = decimal; display format only, does NOT declare millimetres)`
- `$INSUNITS: 9/$INSUNITS, 70/4   (4 = millimetres; R2000-era variable, not in the R12 spec — harmless in an AC1009 file, ignored by strict R12 readers, round-tripped correctly by ezdxf in my test)`
- `$MEASUREMENT: 9/$MEASUREMENT, 70/1   (1 = metric; same caveat as $INSUNITS)`
- `$DWGCODEPAGE: 9/$DWGCODEPAGE, 3/ANSI_1252`
- `$HANDLING: 9/$HANDLING, 70/<0|1>   (handles enabled if nonzero — omit entirely)`
- `$HANDSEED: 9/$HANDSEED, 5/<hex string>   (note group code 5, a STRING, not 70 — omit entirely for R12)`
- `TABLE START: 0/TABLE, 2/<LTYPE|LAYER|STYLE|VIEW|UCS|VPORT|DIMSTYLE|APPID>, 70/<max entry count>   (70 is a capacity hint, not an index — readers must not trust it)`
- `TABLE END: 0/ENDTAB`
- `LTYPE entry: 0/LTYPE, 2/CONTINUOUS, 70/0, 3/Solid line, 72/65, 73/0, 40/0.0   (72 is ALWAYS 65, the ASCII code for 'A'; 73 = dash count; 40 = total pattern length; one 49/<dash length> per dash follows if 73>0)`
- `LAYER entry: 0/LAYER, 2/<name>, 70/<flags>, 62/<ACI colour 1-255, negative = layer off>, 6/CONTINUOUS   (all five groups are present for every entry; 70 bits: 1=frozen, 2=frozen in new viewports, 4=locked)`
- `STYLE entry: 0/STYLE, 2/STANDARD, 70/0, 40/0.0, 41/1.0, 50/0.0, 71/0, 42/2.5, 3/txt, 4/<empty line>   (40=fixed height, 0 means not fixed; 41=width factor; 50=oblique; 42=last height used; 3=font file; 4=bigfont, written as the code followed by an EMPTY line)`
- `APPID entry (only if you write XDATA): 0/APPID, 2/ACAD, 70/0`
- `R2000 delta, for reference only — every entity gains: 5/<unique hex handle>, 330/<owner handle>, 100/AcDbEntity before the 8/<layer>, and 100/<AcDbLine|AcDbPolyline|AcDbText|...> before the geometry; every table entry gains 5/, 330/, 100/AcDbSymbolTableRecord, 100/AcDb<Type>TableRecord; DIMSTYLE uniquely uses 105/ instead of 5/ for its handle`

### Pitfalls

- MISSING 0/EOF. libdxfrw (LibreCAD, and QCAD's dxflib lineage) only returns success from processDxf() when it reads 0/EOF at top level; otherwise it returns DRW::BAD_UNKNOWN and the entire file fails to open. Always terminate with `  0` / `EOF`. A missing final newline after EOF is explicitly tolerated (handled in dxfreader.cpp), but emit one anyway.
- AN INTEGER GROUP CODE GIVEN A DECIMAL VALUE KILLS THE WHOLE FILE IN LIBRECAD. dxfReaderAscii::readInt16() calls strtol() and rejects the record if any non-whitespace remains; libdxfrw::processHeader() turns a failed record into BAD_CODE_PARSED and aborts the read. So `70`/`4.0`, `62`/`7.0`, `90`/`4.0` or `66`/`1.0` produce a file that ezdxf opens happily (I confirmed ezdxf silently coerces `62`/`7.0` to 7) and LibreCAD refuses entirely. In TypeScript never let a float reach codes 60-79, 90-99, 170-175, 280-289: use String(Math.round(n)), never n.toString() on a float.
- NaN / Infinity LEAK THROUGH SILENTLY. String(NaN) is 'NaN' and String(Infinity) is 'Infinity', and strtod() parses both. I wrote a LINE with 10/NaN and 11/Infinity: ezdxf read it back as (nan,0,0)->(inf,1,0) with ZERO audit errors. Every such coordinate then poisons drawing extents and the file opens looking empty. Guard every number with Number.isFinite() and throw — a NaN wall coordinate is an upstream bug, not something to clamp.
- EXPONENT NOTATION FROM JAVASCRIPT'S DEFAULT NUMBER FORMATTING. String(1e21) is '1e+21', String(0.0000001) is '1e-7'. strtod() and Python float() accept these (I verified 1e3 / 1.5E+04 / 2e-2 all parse correctly through ezdxf), but older fixed-point parsers do not. Always emit fixed-point — v.toFixed(4) on millimetres is 0.1-micron resolution, far beyond any architectural need — and reject magnitudes >= 1e21 where toFixed() itself falls back to exponent form.
- LEADING SPACES ON A *VALUE* LINE BECOME PART OF THE STRING. Group codes may be right-justified and blank-filled in a 3-character field (FORTRAN I3) and that is what AutoCAD's DXFOUT emits, but the R12 spec warns explicitly that 'string items should not have leading spaces unless these are intended to be part of the string'. libdxfrw's readString() strips only a trailing \r, never leading whitespace — so `  8` / `  A-WALL` creates a layer literally named '  A-WALL'. Pad the code line, never the value line. Padding the code line is optional (the spec says 'Although DXFOUT output has a fixed format, the DXFIN format is free', and ezdxf's r12writer emits unpadded codes) — pad anyway, it costs nothing and matches every reference file.
- LINE ENDINGS: use CRLF. libdxfrw strips exactly one trailing '\r' from every line so both work there, and ezdxf reads both (I verified an LF-only, unpadded file audits clean). But a naive reader doing line[:-1] handles LF and leaves a stray '\r' on CRLF, and the reverse is true for DOS-assuming readers. CRLF is what AutoCAD emits and is the safer default. In Node, join with explicit '\r\n' and write as a Buffer so no newline transform touches it twice.
- UTF-8 TEXT IN AN AC1009 FILE IS MOJIBAKE. R12 files are code-page encoded (cp1252, declared by $DWGCODEPAGE/3/ANSI_1252); UTF-8 only arrives with R2007/AC1021. I wrote 'Küche 12 m²' as UTF-8 bytes into an AC1009 file and ezdxf read back 'KÃ¼che 12 mÂ²'. Two correct options: encode the file as cp1252, or — better for a TypeScript writer — keep the byte stream pure 7-bit ASCII and escape every non-ASCII character as \U+XXXX with 4 uppercase hex digits. I verified 'K\\U+00FCche 12 m\\U+00B2' decodes back to 'Küche 12 m²', libdxfrw's DRW_TextCodec decodes \U+ natively, and AutoCAD has always understood it.
- LAYER NAMES THAT R12 REJECTS. R12 symbol names are limited to 31 characters and must not contain spaces; Autodesk has a KB article for exactly this failure ('Press ENTER to continue' plus 'Improper table entry name' when opening a DXF whose layer names are too long or contain spaces). Also avoid < > / \\ " : ; ? * | , = ` and a leading '$'. Use AIA-style names (A-WALL, A-DOOR, A-AREA, A-ANNO-TEXT) and sanitise at the boundary — uppercase, spaces to '-', strip illegal characters, truncate to 31, de-duplicate collisions. Never pass a room name straight through.
- STRINGS LONGER THAN 256 CHARACTERS FAIL DXFIN. The R12 spec is blunt: 'The maximum DXF file string length is 256 characters... If your DXF file contains strings that exceed this number, DXFIN will fail.' A long room name concatenated with an area string can cross it. Truncate every group-1 TEXT value and every 2/3/6/7 name to 255 characters.
- WRONG $EXTMIN/$EXTMAX MAKES THE FILE 'OPEN BLANK'. AutoCAD zooms to the stored extents on load, so stale or placeholder extents are worse than none: the 'unset' sentinel is $EXTMIN=(1e20,1e20,1e20) and $EXTMAX=(-1e20,-1e20,-1e20), which is exactly what ezdxf reported for my header-less file. Either compute both from the real geometry bounding box (and set $LIMMIN/$LIMMAX to match) or omit both — never hard-code them.
- THE TABLES ORDER RULE. The R12 spec states 'The order of the tables may change, but the LTYPE table will always precede the LAYER table', because LAYER entries carry a 6/<linetype name> reference. ezdxf tolerated a reversed file in my test, but AutoCAD is the reader you cannot test. Emit LTYPE, then LAYER, then STYLE.
- DECLARING AC1009 THEN USING A NEWER ENTITY. I wrote a well-formed LWPOLYLINE into an $ACADVER=AC1009 file and ezdxf refused the whole file: DXFStructureError: missing 'AcDbPolyline' subclass in LWPOLYLINE. Version and entity vocabulary must agree. In R12 a closed room polygon is 0/POLYLINE with 66/1 (vertices follow) and 70/1 (closed) plus a dummy 10/20/30 point, then one 0/VERTEX per corner, then 0/SEQEND — SEQEND is mandatory, not decorative, and you must not repeat the first vertex.
- HANDLES ARE ALL-OR-NOTHING. If you write $HANDLING/70/1 or $HANDSEED then EVERY entity and table entry needs a unique group-5 hex handle and $HANDSEED must exceed all of them; a partial job is a corrupt file. For R12 write neither — ezdxf's r12writer omits handles entirely and its output audits clean (verified: 0 errors, 0 fixes). Note $HANDSEED's value is a group-5 hex STRING, not a group-70 integer; transcribing it as 70 is a classic error.
- EMPTY-VALUE TAGS ARE REAL LINES, NOT OMITTED LINES. The STYLE entry's 4/ (bigfont name) is a code line followed by an EMPTY line. Emitting the code with no following line desynchronises the entire code/value stream from that point onward and produces a cascade of nonsense errors reported far from the actual fault.

---

## Entity encoding: exact group-code sequences for LINE, closed polygons (R12 POLYLINE/VERTEX/SEQEND vs R2000+ LWPOLYLINE), TEXT with justification, CIRCLE/ARC, and the LAYER/LTYPE/STYLE table entries

Emit **DXF R12 (AC1009)**, ASCII, and nothing newer. R12 is the only version where a hand-written file has no handles (group 5), no subclass markers (group 100), no CLASSES section, no OBJECTS section, no root DICTIONARY, no BLOCK_RECORD table and no mandatory VPORT/APPID/DIMSTYLE tables — which removes essentially every class of structural error you cannot test for without AutoCAD, and every reader in your list (AutoCAD, LibreCAD/libdxfrw, QCAD/dxflib, Autodesk viewers, ezdxf) reads R12. Write the four sections in order HEADER → TABLES → ENTITIES → EOF, with the LTYPE table before the LAYER table (the R12 spec mandates that ordering), and define every layer you use plus a CONTINUOUS linetype and a STANDARD text style, even though R12 would auto-create undefined layers as colour 7/CONTINUOUS — defining them is ten lines and eliminates reader-dependent behaviour. Draw rooms as closed 2D POLYLINE + VERTEX… + SEQEND with 66/1 and 70/1, walls as plain LINE pairs (draw both faces; do not rely on polyline width 40/41, whose fill depends on FILLMODE and is rendered inconsistently by viewers), door swings as ARC plus a LINE for the leaf, and one TEXT per room with 72/1 + 73/2 and an explicit 11/21/31. The one real cost of R12 is that `$INSUNITS` does not exist (it arrived in R2000), so millimetres are a convention, not a declaration: write the numbers in mm, set `$EXTMIN`/`$EXTMAX` so the drawing frames itself, and state the unit in your export UI. The other cost is text encoding: R12 is `$DWGCODEPAGE`-based (ANSI_1252), so any non-ASCII room name must be escaped as `\U+XXXX` — AutoCAD and ezdxf's recover module decode that, but older readers may show it literally, so transliterate to ASCII where you can. Keep the writer table-driven and never rely on group order except in the two places where readers do (LWPOLYLINE's 90 tag, and VERTEX entities following their POLYLINE), and every reader will accept the file on the first attempt.

### Group codes

- `FILE SKELETON (R12, exact order): 0/SECTION, 2/HEADER, ... 0/ENDSEC | 0/SECTION, 2/TABLES, ... 0/ENDSEC | [0/SECTION, 2/BLOCKS, ... 0/ENDSEC] | 0/SECTION, 2/ENTITIES, ... 0/ENDSEC | 0/EOF. Inside TABLES the LTYPE table MUST precede the LAYER table (R12 ref: 'the LTYPE table always precedes the LAYER table'). BLOCKS, if present, MUST precede ENTITIES. 0/EOF is mandatory — omitting it is a hard structure error, not a warning.`
- `MINIMAL HEADER (R12): 9/$ACADVER, 1/AC1009; 9/$DWGCODEPAGE, 3/ANSI_1252; 9/$INSBASE, 10/0.0, 20/0.0, 30/0.0; 9/$EXTMIN, 10/xmin, 20/ymin, 30/0.0; 9/$EXTMAX, 10/xmax, 20/ymax, 30/0.0; 9/$LUNITS, 70/2; 9/$LUPREC, 70/4; 9/$LTSCALE, 40/1.0; 9/$TEXTSTYLE, 7/STANDARD; 9/$CLAYER, 8/0. NOTE: $INSUNITS and $MEASUREMENT DO NOT EXIST in R12 (verified absent from the R12 reference; $INSUNITS was introduced in R2000) — do not emit them.`
- `COMMON PROLOGUE, EVERY ENTITY (R12): 0/<TYPE> then 8/<layer name>. The 8 group is MANDATORY on every entity — R12 ref: 'Every entity contains an 8 group that gives the name of the layer on which the entity resides.' Optional, omit when default: 6/<linetype name> (default BYLAYER), 62/<colour> (default BYLAYER; 0=BYBLOCK, 256=BYLAYER), 39/<thickness> (default 0), 67/1 (paper space — omit for model space), 210/220/230 extrusion (default 0,0,1 — NEVER emit for a 2D plan). 5/<handle> only if handles are enabled; omit it entirely in R12.`
- `LINE: 0/LINE, 8/<layer>, [6/<linetype>], [62/<colour>], 10/x1, 20/y1, 30/z1, 11/x2, 21/y2, 31/z2. MANDATORY: 0, 8, 10, 20, 11, 21. R12 ref lists LINE as '10, 20, 30 (start point), 11, 21, 31 (endpoint)' with no optional marker — write 30 and 31 explicitly as 0.0. Use one LINE per wall face (two per wall of thickness t, offset ±t/2 from the centreline) rather than a single centreline with width.`
- `POLYLINE header (R12 closed room outline): 0/POLYLINE, 8/<layer>, [6/<linetype>], [62/<colour>], 66/1, 10/0.0, 20/0.0, 30/<elevation>, 70/1, [40/<default start width>, 41/<default end width>]. MANDATORY: 0, 8, 66, 10, 20, 30, 70. R12 ref: '66 (vertices-follow flag, always 1 for a Polyline)' and '10, 20, 30 (polyline elevation: 30 supplies elevation, 10 and 20 are always set to zero)'. 70 bit codes: 1=closed polyline, 2=curve-fit vertices added, 4=spline-fit vertices added, 8=3D polyline, 16=3D polygon mesh, 32=mesh closed in N, 64=polyface mesh, 128=continuous linetype pattern. For a room use 70/1 ONLY — do not set bit 8 (3D polyline), which makes the polygon non-hatchable and non-editable as a 2D pline.`
- `VERTEX (one per corner, must immediately follow the POLYLINE, in order): 0/VERTEX, 8/<same layer as the POLYLINE>, 10/x, 20/y, 30/z, [40/<start width>], [41/<end width>], [42/<bulge>], 70/0, [50/<curve-fit tangent>]. MANDATORY: 0, 8, 10, 20, 30. 70 is optional (default 0) — write 0 for a plain 2D vertex; 70 bit codes: 1=extra vertex from curve fit, 2=curve-fit tangent defined, 8=spline-fit vertex, 16=spline frame control point, 32=3D polyline vertex, 64=3D mesh vertex, 128=polyface mesh vertex. 42 bulge = tan(includedAngle/4), negative for clockwise, 0 = straight segment (rooms: always 0 or omitted). Set 30 equal to the POLYLINE's elevation. Do NOT repeat the first point as a final vertex — 70/1 on the header does the closing.`
- `SEQEND (mandatory terminator for POLYLINE): 0/SEQEND, 8/<same layer as the POLYLINE>. No other groups. R12 ref: vertices are 'terminated by a sequence end (SEQEND) entity'. Omitting SEQEND desynchronises the parser and can swallow every entity after it.`
- `LWPOLYLINE (R2000+ / AC1015 ONLY — NOT valid in an AC1009 file; shown for contrast): 0/LWPOLYLINE, 5/<hex handle>, 100/AcDbEntity, 8/<layer>, [6/<linetype>], [62/<colour>], 100/AcDbPolyline, 90/<vertex count>, 70/1, [43/<constant width>], [38/<elevation>], [39/<thickness>], then per vertex: 10/x, 20/y, [91/<vertex id>], [40/<start width>], [41/<end width>], [42/<bulge>], [210/220/230 extrusion]. MANDATORY: 0, 8, 100 markers, 90, and one 10/20 pair per vertex; 70 defaults to 0 (open). ORDER MATTERS HERE: ezdxf documents that 'if the count tag [90] is not the first tag in the AcDbPolyline subclass, AutoCAD will not close the polyline when the close flag is set' — so 90 first, then 70, then the vertices. BricsCAD ignores the ordering; AutoCAD does not.`
- `TEXT (room label): 0/TEXT, 8/<layer>, 10/x, 20/y, 30/z, 40/<height>, 1/<string>, [50/<rotation deg>], [41/<relative X scale, default 1>], [51/<oblique angle, default 0>], 7/<text style name, default STANDARD>, [71/<generation flags, default 0>], 72/<horizontal justification, default 0>, 73/<vertical justification, default 0>, 11/x, 21/y, 31/z. MANDATORY: 0, 8, 10, 20, 30, 40, 1. 71 bit codes: 2=backward (mirrored in X), 4=upside down (mirrored in Y).`
- `TEXT justification values (R12 Table 17, NOT bit-coded). 72 horizontal: 0=Left, 1=Center, 2=Right, 3=Aligned (only if 73=0), 4=Middle (only if 73=0), 5=Fit (only if 73=0). 73 vertical: 0=Baseline, 1=Bottom, 2=Middle, 3=Top. Valid combinations form the grid TLeft/TCenter/TRight (73=3), MLeft/MCenter/MRight (73=2), BLeft/BCenter/BRight (73=1), Left/Center/Right/Aligned/Middle/Fit (73=0). For a centred room label use 72/1 + 73/2 (MCenter).`
- `TEXT 11/21/31 — WHEN REQUIRED (the classic mistake). R12 ref, verbatim: '11, 21, 31 (alignment point — optional, appears only if 72 or 73 group is present and nonzero)' and 'If the justification is anything other than baseline/left (groups 72 and 73 both 0), group codes 11, 21, and 31 specify the alignment point (or the second alignment point for Align or Fit).' Practical rule: (a) 72=0 AND 73=0 → omit 11/21/31 entirely; 10/20/30 is the baseline-left position. (b) ANY nonzero 72 or 73 → 11/21/31 are REQUIRED and are the position the text actually uses; still write 10/20/30 (set it equal to 11/21/31). (c) 72=3 (Aligned) or 72=5 (Fit) → 10/20/30 and 11/21/31 are two DIFFERENT points, the two ends of the baseline, and 40 (height) is derived/ignored — avoid both modes for room labels.`
- `CIRCLE: 0/CIRCLE, 8/<layer>, [6/<linetype>], [62/<colour>], 10/cx, 20/cy, 30/cz, 40/<radius>. MANDATORY: 0, 8, 10, 20, 40 (write 30 as 0.0). R12 ref: 'CIRCLE 10, 20, 30 (center), 40 (radius)'. Radius must be strictly > 0.`
- `ARC (door swing): 0/ARC, 8/<layer>, [6/<linetype>], [62/<colour>], 10/cx, 20/cy, 30/cz, 40/<radius>, 50/<start angle>, 51/<end angle>. ALL MANDATORY (write 30 as 0.0). R12 ref: 'ARC 10, 20, 30 (center), 40 (radius), 50 (start angle), 51 (end angle)'. Angles are in DEGREES (not radians), measured counter-clockwise from the +X axis of the entity's OCS. The arc is always swept CCW from 50 to 51; if 51 < 50 it wraps through 0/360. For a door hinged at the jamb: 10/20 = hinge point, 40 = leaf width, 50 = angle of the closed leaf, 51 = 50 + swing (typically 90).`
- `LTYPE TABLE: 0/TABLE, 2/LTYPE, 70/<max item count>, then per entry: 0/LTYPE, 2/<name>, 70/<standard flags>, 3/<descriptive text>, 72/65, 73/<number of dash items>, 40/<total pattern length>, then one 49/<dash length> per element (positive=dash, negative=gap, 0=dot), then 0/ENDTAB. R12 ref: '72 (alignment code; value is always 65, the ASCII code for A)'. CONTINUOUS entry exactly: 0/LTYPE, 2/CONTINUOUS, 70/0, 3/Solid line, 72/65, 73/0, 40/0.0 (no 49 groups). Note: the R12 reference's prose list omits 73, but AutoCAD and ezdxf both write it — include it; it is harmless and expected by R13+ readers.`
- `LAYER TABLE (R12): 0/TABLE, 2/LAYER, 70/<max item count>, then per entry: 0/LAYER, 2/<layer name>, 70/<flags>, 62/<AutoCAD Colour Index>, 6/<linetype name>, then 0/ENDTAB. ALL FOUR of 2, 70, 62, 6 are MANDATORY — R12 ref: 'The following are the groups used for each type of table item. All groups are present for each table item', and 'LAYER 2 (layer name), 70 (standard flag values), 62 (color number, negative if layer is off), 6 (linetype name).' 70 bit codes for LAYER: 1=frozen, 2=frozen by default in new viewports, 4=locked, 16=externally dependent on an xref, 32=xref resolved (with 16), 64=referenced by at least one entity; bits 8 and 128 are unused; 70/0 means on and thawed. 62 must be 1..255 (a NEGATIVE value means the layer is OFF); never write 62/0 (BYBLOCK) or 62/256 (BYLAYER) on a LAYER entry — those are entity-level values only. Always define layer '0'.`
- `LAYER TABLE (R2000+, for contrast — more required groups, more ways to fail): 0/LAYER, 5/<hex handle>, 100/AcDbSymbolTableRecord, 100/AcDbLayerTableRecord, 2/<name>, 70/<flags>, 62/<colour>, 6/<linetype>, [290/<plot flag, 1>], [370/<lineweight; -3=default, -2=byblock, -1=bylayer>], 390/<handle of a PlotStyleName object>. 390 is expected by AutoCAD in R2000+ and must reference a real object in the OBJECTS section — a frequent hand-writer failure and a strong reason to stay on R12.`
- `STYLE TABLE (needed so TEXT has a resolvable 7 group): 0/TABLE, 2/STYLE, 70/1, 0/STYLE, 2/STANDARD, 70/0, 40/0.0, 41/1.0, 50/0.0, 71/0, 42/2.5, 3/txt, 4/<empty line>, 0/ENDTAB. R12 ref: 'STYLE 2 (style name), 70 (standard flag values), 40 (fixed text height; 0 if not fixed), 41 (width factor), 50 (oblique angle), 71 (text generation flags), 42 (last height used), 3 (primary font filename), 4 (big-font file name; blank if none)' — all present for each item. 40 MUST be 0.0, otherwise the style's fixed height overrides your TEXT 40 and every label renders at the wrong size. The 4 group must still be emitted with an empty value line.`
- `LINETYPE NAMES: only CONTINUOUS is needed for a floor plan, and AutoCAD treats it as built-in — R12 ref says entities may reference layers that are not defined and 'AutoCAD ... creates [them with] color 7 and the CONTINUOUS linetype', so CONTINUOUS resolves without an LTYPE record in AutoCAD. It is nevertheless SAFER to define it, because third-party readers resolve layer linetypes by name lookup. The conditional rule that IS mandatory: R12 ref, 'If you define any linetypes in the LTYPE table, this table must appear before the LAYER table.' Other conventional names (CENTER, DASHED, HIDDEN, PHANTOM, DOT, DASHDOT, DIVIDE) are NOT built in and MUST be defined in LTYPE with their 49 dash patterns before any LAYER or entity references them.`

### Pitfalls

- Missing 0/EOF. Not a warning — a hard structure error. Verified: ezdxf 1.4.4 raises DXFStructureError: 'missing EOF tag.' and loads nothing. Always terminate with the two lines 0 then EOF.
- POLYLINE without a closing 0/SEQEND. The reader stays in vertex-collection mode and either swallows every subsequent entity or aborts the section. Emit exactly one SEQEND (with the same 8/<layer>) after the last VERTEX, always.
- POLYLINE without 66/1. R12 defines 66 as 'vertices-follow flag (always 1 for a Polyline)'. Some readers use it to decide whether to look for VERTEX entities and will render an empty/zero-length polyline without it. Always write 66/1 before the 10/20/30 and 70 groups.
- Omitting 10/20/30 on the POLYLINE header itself. It is easy to miss because the values are meaningless-looking (10 and 20 are always 0.0, 30 carries the elevation), and lenient readers tolerate the omission (verified: ezdxf loads it fine). AutoCAD's own DXFOUT always writes them, so write 10/0.0, 20/0.0, 30/<elevation> — it costs six lines and removes the question.
- TEXT with a nonzero 72 or 73 but no 11/21/31. The single most common hand-written-DXF bug: the alignment point defaults to (0,0,0), so every room label stacks up at the drawing origin while the geometry sits where it should. Readers DIVERGE here — ezdxf silently falls back to the insert point (verified: it still reports MIDDLE_CENTER at the correct location), so this bug is invisible in a Python test and only appears in AutoCAD. Rule: nonzero 72 or 73 ⇒ always emit 11/21/31, set equal to 10/20/30 for every mode except Aligned (72=3) and Fit (72=5).
- Using 72=3 (Aligned) or 72=5 (Fit) for a centred label. In those modes 10/20/30 and 11/21/31 are the two ENDS of the baseline, not a position plus a copy, and the 40 height is stretched or ignored. Use 72/1 + 73/2 (MCenter) for room labels; it is the only combination that behaves as 'centre the text on this point' everywhere.
- Emitting LWPOLYLINE in an AC1009 file. LWPOLYLINE requires DXF R2000 (AC1015) minimum. In an R12 file strict readers reject the entity or the whole file; lenient ones drop the room outline silently, so the plan opens looking like it has walls but no rooms. If you ever move to R2000, put 90 (vertex count) as the FIRST tag after 100/AcDbPolyline and 70 before the vertices, or AutoCAD ignores the closed flag while BricsCAD honours it.
- Layer names AutoCAD refuses. Pre-2000 symbol table names are limited to 31 characters, cannot contain spaces, and cannot contain / \ " : ; ? * | , = '. Autodesk's own KB documents 'Press ENTER to continue' and 'Improper table entry name' when opening a DXF whose layer names are too long. Room names go in the TEXT string, never in a layer name. Sanitise to uppercase A-Z 0-9 $ - _ and truncate to 31; use AIA-style fixed names (A-WALL, A-DOOR, A-AREA, A-AREA-IDEN) so the set is closed and known-safe.
- LAYER table entries missing 62 or 6. The R12 reference states all groups are present for each table item, so a LAYER entry with only 2 and 70 is malformed. Strict readers reject the table; lenient ones invent defaults, giving a plan whose colours differ per application. Always write 2, 70, 62, 6 in that order.
- Putting the LAYER table before the LTYPE table. Explicitly forbidden by the R12 reference when any linetype is defined ('this table must appear before the LAYER table'), because layer entries resolve their 6 group by lookup. Order the TABLES section LTYPE, LAYER, STYLE.
- Locale-formatted or exponent-formatted numbers. A German/French locale turns 4500.5 into '4500,5' and the comma is read as end-of-value, corrupting every coordinate after it. In TypeScript use Number.prototype.toFixed(n) (locale-independent) and never toLocaleString / Intl.NumberFormat. Guard the edges too: values ≥ 1e21 make Number.toString emit '1e+21', and NaN/Infinity produce literal 'NaN'/'Infinity' text no reader can parse — validate coordinates are finite before writing, and normalise -0 to 0.
- Non-ASCII characters in a room name. DXF R2004 and prior are byte-encoded per $DWGCODEPAGE (default ANSI_1252); characters outside that encoding must be written as \U+nnnn escapes (UTF-8 only became the file encoding at R2007/AC1021). Sources diverge on reader support: AutoCAD and ezdxf's recover module decode \U+nnnn, but a plain ezdxf.readfile does not decode it automatically and older third-party readers show it literally. Safest: restrict labels to ASCII (transliterate accents) and escape as \U+nnnn only what you cannot transliterate.
- A newline inside a group-1 TEXT string. TEXT is single-line by definition; a raw \n splits the tag pair and desynchronises the whole file from that point on. Split 'Living Room' / '20.00 m2' into two TEXT entities stacked by height, and strip control characters (R12 expands them to ^X, and a literal caret becomes '^ ').
- Unescaped %% sequences in a room name. %%d, %%c, %%p, %%u and %%%% are AutoCAD text control codes (degree, diameter, plus/minus, underline, literal percent) and are interpreted, not shown. A room called 'Store %%d' renders as 'Store °'. Escape a literal percent as %%%% or strip %% from user-supplied names.
- Emitting 210/220/230 extrusion groups. For a flat plan you want pure WCS. A 210 of (0,0,-1) — easy to produce from a normal-vector calculation on a clockwise polygon — flips the entity into a mirrored OCS, so the room appears mirrored about the Y axis in AutoCAD while some viewers ignore the OCS and show it correctly. Never write 210/220/230 at all.
- Degenerate geometry that readers handle differently: zero-length LINE, CIRCLE or ARC with radius 0, ARC with 50 == 51, duplicate consecutive VERTEX points, and a closed POLYLINE whose last vertex repeats the first (70/1 already closes it, so you get a zero-length final segment that breaks hatching and area calculation). Filter these in the writer with an epsilon appropriate to millimetres (e.g. 0.01 mm).
- STYLE STANDARD written with a nonzero 40. Group 40 is the style's FIXED text height; if it is anything but 0.0 it overrides the TEXT entity's own 40 and every room label comes out at the same wrong size. Write 40/0.0 in the STYLE record and control size purely from the TEXT 40.
- Setting colour and linetype per entity instead of per layer. Writing 62 on entities is legal (0=BYBLOCK, 256=BYLAYER, 1..255 = ACI) but it defeats the layer-based workflow every CAD user expects and inflates the file. Omit 6 and 62 on entities entirely — the default is BYLAYER — and put colour on the LAYER record.
- Forgetting $EXTMIN/$EXTMAX. Not fatal, but with millimetre coordinates a plan can land far from the stored view and the drawing opens apparently blank until the user runs ZOOM EXTENTS — which reads as 'the export is broken'. Compute the real bounding box (including text) and write both variables.
- Reaching for entity types with uneven reader support. AVOID: LWPOLYLINE, MTEXT, ELLIPSE, SPLINE, LEADER/MLEADER, XLINE/RAY, REGION and 3DSOLID (all R13+/ACIS, invalid in R12); HATCH (does not exist in R12 — R12 hatch is an anonymous block of LINEs — and even in R2000+ its boundary-path encoding is the most error-prone entity in DXF); MLINE (needs an MLINESTYLE object in OBJECTS; support is poor even in AutoCAD-adjacent tools); DIMENSION (needs a DIMSTYLE record plus a generated anonymous block for the graphics, and readers that ignore the block show nothing); and TRACE/SOLID for wall fill (fill depends on FILLMODE and is dropped by many viewers). BLOCK/INSERT for repeated door symbols is legal in R12 but requires a correct BLOCKS section before ENTITIES plus SEQEND handling for attributes — for a first release, inline the door as ARC + LINE. Everything a floor plan needs is expressible with LINE, POLYLINE/VERTEX/SEQEND, TEXT, CIRCLE and ARC.
- Line endings and group-code padding. AutoCAD's DXFOUT writes CRLF with group codes right-justified in a 3-character field ('  0', ' 10'); ezdxf writes LF with unpadded codes. Verified both parse: ezdxf accepts LF-only, CRLF, padded and unpadded codes identically. Use CRLF, and be strict about one tag per two lines — a group code line, then a value line, with the value never on the code's line and never absent.

---

## Reader-side reality: what AutoCAD, LibreCAD, QCAD and ezdxf actually do when handed a hand-written DXF

Emit **DXF R12 (AC1009), ASCII, CRLF, cp1252** — it is the only version whose entire file is hand-writable without handles, `100` subclass markers, owner pointers (`330`), a `BLOCK_RECORD` table, or an `OBJECTS` section with a root DICTIONARY, every one of which is a fresh rejection risk you cannot test for. Write **millimetres directly at 1:1** with `$INSUNITS = 4` and `$MEASUREMENT = 1`; do not convert to metres, because architectural CAD users expect a metric plan in model space at full size in mm, and rescaling on export is exactly how a plan later gets dimensioned wrong. `$INSUNITS` post-dates R12 (it arrived with AutoCAD 2000), so sources disagree on whether it belongs in an AC1009 file — emit it anyway: unknown header variables are skipped harmlessly, and I verified ezdxf 1.4.4 reads `$INSUNITS = 4` back out of an AC1009 file as `Millimeters`. **Define every layer, linetype and text style you reference**: an undefined *linetype* is the single worst offender because ezdxf's own audit source states "AutoCAD does not load DXF files with undefined line types" — a hard reject, even though ezdxf itself merely strips it, so your local test passing proves nothing. Give every entity `8/<layer>` and **omit `62` entirely** so colour is BYLAYER; put colour on the LAYER table entry, and never use ACI 7 alone as a visibility guarantee since it renders white-on-white or black-on-black depending on the viewer's background. Use **POLYLINE/VERTEX/SEQEND** for room outlines (LWPOLYLINE in an AC1009 file is rejected outright — I reproduced `missing 'AcDbPolyline' subclass`), LINE for walls and door swings, and TEXT with `72`/`73` **plus both `10` and `11` set to the same point**, because the R12 spec makes `11` the governing position whenever `72` or `73` is nonzero. Finally, compute `$EXTMIN`/`$EXTMAX` — they are cheap, some importers insist on them, and getting them wrong is worse than omitting them, since a stale extent box makes "zoom extents" frame empty space while the drawing sits off-screen.

### Group codes

- `FILE SKELETON (order is mandatory; LTYPE table must precede LAYER table): 0/SECTION, 2/HEADER … 0/ENDSEC, 0/SECTION, 2/TABLES … 0/ENDSEC, 0/SECTION, 2/BLOCKS … 0/ENDSEC, 0/SECTION, 2/ENTITIES … 0/ENDSEC, 0/EOF`
- `HEADER VARIABLE: 9/$VARNAME then the value tag(s) whose code is fixed per variable — 9/$ACADVER + 1/AC1009; 9/$DWGCODEPAGE + 3/ANSI_1252; 9/$INSUNITS + 70/4 (4 = millimetres); 9/$MEASUREMENT + 70/1 (metric); 9/$LUNITS + 70/2 (decimal); 9/$LTSCALE + 40/1.0; 9/$CLAYER + 8/0`
- `HEADER EXTENTS (3D points, all three codes): 9/$EXTMIN, 10/xmin, 20/ymin, 30/0.0; 9/$EXTMAX, 10/xmax, 20/ymax, 30/0.0. LIMITS are 2D only: 9/$LIMMIN, 10/x, 20/y; 9/$LIMMAX, 10/x, 20/y`
- `TABLE WRAPPER: 0/TABLE, 2/<LTYPE|LAYER|STYLE>, 70/<max item count> … 0/ENDTAB`
- `LTYPE entry (CONTINUOUS is the one you must define): 0/LTYPE, 2/CONTINUOUS, 70/0, 3/Solid line, 72/65, 73/0, 40/0.0  — 72 is always 65 ('A'), 73 is the dash count, 40 is total pattern length`
- `LAYER entry: 0/LAYER, 2/<name>, 70/0, 62/<positive ACI>, 6/CONTINUOUS  — 70 bit 1 = frozen, bit 2 = frozen in new viewports, bit 4 = locked; 70/0 means on and thawed. A NEGATIVE 62 means the layer is OFF`
- `STYLE entry: 0/STYLE, 2/STANDARD, 70/0, 40/0.0, 41/1.0, 50/0.0, 71/0, 42/2.5, 3/txt, 4/<empty line>  — 40/0.0 means variable height (a nonzero 40 makes the STYLE override every TEXT's own 40); 3 is the primary font file, 4 is the bigfont file and is left empty`
- `LINE (walls, door leaves): 0/LINE, 8/<layer>, 10/x1, 20/y1, 30/0.0, 11/x2, 21/y2, 31/0.0`
- `POLYLINE header (room outline, closed): 0/POLYLINE, 8/<layer>, 66/1, 70/1, 10/0.0, 20/0.0, 30/0.0  — 66/1 is the mandatory 'vertices follow' flag; 70 bit 1 = closed (use 70/1 for a room, 70/0 for an open run); the 10/20 on the POLYLINE itself are always 0.0 and 30 carries the elevation`
- `VERTEX (one per room corner, repeated): 0/VERTEX, 8/<layer>, 10/x, 20/y, 30/0.0, 70/0  — do NOT repeat the first vertex at the end; the 70/1 closed flag on the POLYLINE draws the closing segment`
- `SEQEND (mandatory terminator after the last VERTEX): 0/SEQEND, 8/<layer>`
- `TEXT, centred room label: 0/TEXT, 8/<layer>, 10/cx, 20/cy, 30/0.0, 40/<height>, 1/<string>, 72/1, 73/2, 11/cx, 21/cy, 31/0.0  — 72: 0=Left 1=Center 2=Right 3=Aligned 4=Middle 5=Fit; 73: 0=Baseline 1=Bottom 2=Middle 3=Top; 11 is 'present only if 72 or 73 is present and nonzero' and then GOVERNS the position, so write 10 and 11 identically`
- `TEXT, left/baseline (simplest, no alignment point needed): 0/TEXT, 8/<layer>, 10/x, 20/y, 30/0.0, 40/<height>, 1/<string>  — with 72 and 73 omitted (both default 0), only code 10 is used`
- `OPTIONAL TEXT modifiers: 50/<rotation degrees CCW>, 41/<width factor>, 51/<oblique>, 7/<style name>. Omit 7 entirely to get STANDARD — never write 7 with an empty value`
- `COMMON ENTITY CODES: 8/<layer> is REQUIRED on every entity. 6/<linetype> omitted = BYLAYER. 62/<colour> omitted = BYLAYER (256); 62/0 = BYBLOCK, 62/256 = BYLAYER, 1-255 = explicit ACI. 67 omitted or 0 = model space, 1 = paper space. 210/220/230 = extrusion vector — OMIT for plan geometry, never write 0/0/0`
- `POINT CODE CONTIGUITY RULE: a point's 10, 20 and (if used) 30 must be consecutive tags. Interleaving anything (e.g. 10, 8, 20) is a hard parse error — reproduced as DXFStructureError 'Missing required y coordinate'`

### Pitfalls

- HARD REJECT — a newline inside user-supplied text. A room name typed as "Living\nRoom" written straight into 1/<name> emits an extra line that the parser reads as a group code. Reproduced: DXFStructureError: Invalid group code "Room 12.00 m2". This is the most likely real-world rejection for an app exporting user-typed room names. FIX: strip/replace \r and \n in every string value (codes 1, 2, 3, 7, 8) before writing; also cap length and strip control chars.
- HARD REJECT — locale decimal separator. A number formatted as "2,5" instead of "2.5" kills the file. Reproduced: DXFStructureError: Invalid tag (code=42, value="2,5"). In TypeScript this happens via toLocaleString() or an Intl formatter. FIX: format every float with a fixed-point routine that always emits '.', e.g. value.toFixed(6) then trim trailing zeros; never use locale-aware formatting.
- HARD REJECT — missing 0/EOF. Reproduced: DXFStructureError: missing EOF tag. The R12 spec says 'The EOF item must be present at the end-of-file.' FIX: always terminate with 0\nEOF\n, and make it the last thing the writer emits even on an early return or an empty plan.
- HARD REJECT — POLYLINE without a SEQEND. Reproduced: DXFStructureError: Expected DXF entity TEXT or SEQEND. FIX: emit POLYLINE/VERTEX*/SEQEND as one atomic unit in a single function so a vertex loop can never end without its terminator.
- HARD REJECT — LWPOLYLINE inside an AC1009 file. Reproduced: DXFStructureError: missing 'AcDbPolyline' subclass in LWPOLYLINE. LWPOLYLINE is R13/R14+ and needs a 100/AcDbPolyline subclass marker R12 has no concept of. FIX: for R12 use POLYLINE/VERTEX/SEQEND only; do not mix entity vintages.
- HARD REJECT — split coordinate tags. Writing 10, then 8, then 20 breaks the point. Reproduced: DXFStructureError: Missing required y coordinate. FIX: emit 10/20/30 back-to-back from one helper; never let an attribute-writing branch slip between them.
- HARD REJECT IN AUTOCAD, SILENT IN EZDXF — referencing an undefined linetype. ezdxf's audit source says verbatim: 'Check for usage of undefined line types. AutoCAD does not load DXF files with undefined line types.' In my test ezdxf merely logged 'Removed undefined linetype dashed' and loaded fine, so a passing local ezdxf test does NOT clear you. FIX: define CONTINUOUS in the LTYPE table and reference nothing else (omit code 6 on entities entirely).
- SILENT WRONG — text lands at the wrong place. The R12 spec says code 11 is 'present only if 72 or 73 group is present and nonzero' — and when present it governs the position. Set 72/1 73/2 to centre a room label but forget 11 and spec-strict readers place the label at the default alignment point, typically piling every label at the origin. ezdxf is forgiving here (it fell back to code 10), which hides the bug locally. FIX: whenever 72 or 73 is nonzero, always write 11/21/31 with the same value as 10/20/30.
- SILENT WRONG — nothing visible because the layer is OFF. A NEGATIVE 62 in a LAYER table entry means 'layer is off' per the R12 spec. Verified: 62/-7 loads with zero audit errors and reads back is_on=False. Easy to hit if you derive the ACI from a signed integer or a palette index that can go negative. FIX: clamp layer colour to 1..255 and assert it is positive before writing.
- SILENT WRONG — nothing visible because the layer is FROZEN. LAYER group 70 is bit-coded: 1 = frozen, 2 = frozen in new viewports, 4 = locked; 'If no value (0) is set, the layer is on and thawed.' Verified: 70/1 loads clean and reads back is_frozen=True. FIX: write 70/0 for every layer you want visible; 70/4 (locked) is still visible if you want plan geometry protected.
- SILENT WRONG — text invisible at height 0. TEXT code 40 = 0 renders nothing; I rendered it and the labels disappeared entirely while the file audited clean. Also a STYLE entry with a NONZERO code 40 forces a fixed height and overrides every TEXT's own 40. FIX: write STYLE STANDARD with 40/0.0, and guard against a computed text height of 0 (e.g. from an unset config) with a sane floor.
- SILENT WRONG — text microscopic or gigantic because height was not scaled to millimetres. At 1:100 a label that should read 2.5 mm on paper must be 250 mm in model space; a height of 2.5 in a mm drawing is 100x too small and looks like a dot. FIX: derive height as paper_mm * scale_denominator; for a 1:100 plan use ~200-250 mm for room names.
- SILENT WRONG — geometry looks solid when it should be dashed, or vice versa. $LTSCALE is in drawing units, so a dash pattern authored for metres is invisible at mm scale and vice versa. FIX: sidestep it — use CONTINUOUS everywhere and express door/threshold distinctions with layers and colour, not dash patterns.
- SILENT WRONG — mojibake in room names. Writing UTF-8 bytes while the header declares 3/ANSI_1252 produced 'KÃ¼che' from 'Küche'. R12 has no UTF-8 mode (UTF-8 begins at $ACADVER AC1021/R2007). FIX: encode the byte stream as cp1252 to match the declared $DWGCODEPAGE and pre-substitute any character cp1252 cannot represent — do not rely on the \U+XXXX escape, which ezdxf returned as a literal string in my R12 test.
- SILENT WRONG — everything invisible because of ACI colour 7. Colour 7 is 'white/black' and follows the viewer's background; in my render it resolved to #ffffff and the ACI-7 walls vanished against white paper. FIX: give plan layers explicit mid-range ACI colours and check the render on both a light and a dark background.
- SILENT WRONG — 62/0 (BYBLOCK) on a model-space entity. BYBLOCK is only meaningful inside a block definition where it inherits from the INSERT. Verified: an entity with 62/0 in model space resolved to #ffffff regardless of its layer colour, i.e. it ignores the layer and can disappear. FIX: never write 62/0 outside a BLOCK; omit 62 entirely so entities are BYLAYER (256).
- SILENT WRONG — 'zoom extents' frames empty space. If $EXTMIN/$EXTMAX are present but stale or wrong, the reader trusts them and zooms to the wrong box; the drawing appears blank until you zoom manually. Absent is safer than wrong — the R12 manual notes that after loading an entities-only file 'limits, extents, and current view will be invalid' and you simply 'do a ZOOM E' — but Paul Bourke's long-standing minimal-DXF note warns some packages 'insist on' them. FIX: compute them from the actual entity bounding box (including text insertion points) in the same pass that writes the entities; never hard-code them.
- SILENT WRONG — geometry mirrored or missing from an extrusion vector. Writing 210/220/230 as 0,0,0 gives a degenerate normal, and a negative Z normal silently mirrors everything about the X axis (OCS). FIX: omit 210/220/230 entirely for flat plan geometry so the WCS default (0,0,1) applies.
- REJECTED OR MANGLED — illegal characters in a layer name. The invalid set is < > / \ " : ; ? * = ` (backtick and equals included; '|' is allowed in layer names but not linetype names). Verified against ezdxf's validator: 'Level 1/2', 'WALL*', 'WALL=1', 'WALLS;DOORS' are all invalid, while 'Ground Floor' (spaces) is fine. Level names like 'Level 1/2' or 'Ground/First' are a realistic source. FIX: sanitise level/room-derived layer names to [A-Za-z0-9_$-] plus spaces, and prefer fixed AIA-style names (A-WALL, A-DOOR, A-AREA, A-AREA-IDEN) with the level as a suffix.
- SILENT WRONG — duplicate or badly-formed handles. Handles are optional in R12 ($HANDLING), so the safest move is to omit code 5 everywhere. If you do write them they must be unique and valid hexadecimal (ezdxf skips any handle where int(value, 16) fails), and $HANDSEED must exceed the largest one used or the reader assigns a duplicate on load and reports a bad-handle error. FIX: for R12 write no 5 tags and no $HANDSEED at all.
- LOW RISK, WORTH KNOWING — cosmetic whitespace is tolerated but not worth relying on. Group codes padded to '  10 ' parsed fine, and the R12 files Autodesk ships use right-aligned 3-column codes. A bare \r inside a text value also survived and silently embedded a control character. FIX: write plain unpadded integers, terminate every line with CRLF, and strip \r from data values.
- VERIFICATION CHECKLIST (by eye or by script): (1) file starts 0/SECTION 2/HEADER and ends 0/EOF; (2) section order HEADER, TABLES, BLOCKS, ENTITIES with balanced SECTION/ENDSEC and TABLE/ENDTAB; (3) LTYPE table appears before LAYER table; (4) grep every 8/<layer> value and confirm each has a LAYER table entry; same for every 6/<linetype> and 7/<style>; (5) every LAYER has 70/0 and a POSITIVE 62; (6) no 62/0 outside BLOCKS; (7) count 0/POLYLINE == count 0/SEQEND; (8) every 0/POLYLINE is followed by 66/1; (9) every TEXT with nonzero 72 or 73 also has an 11; (10) every TEXT 40 is > 0; (11) grep the whole file for ',' in a value line and for 'e'/'E' in numeric values — both should be zero; (12) all lines are either an integer group code or a value, i.e. the total line count is even; (13) $EXTMIN/$EXTMAX equal the true min/max of all coordinates; (14) the file decodes cleanly as cp1252 and no value line contains \r; (15) finally, run `python -c "import ezdxf; d=ezdxf.readfile('plan.dxf'); a=d.audit(); print(len(a.errors), len(a.fixes))"` and require 0 and 0 — but remember the undefined-linetype case audits as a benign 'fix' while AutoCAD rejects the file outright, so treat any fix as a failure too.

---

## A minimal valid R12 file

```dxf
  0
SECTION
  2
HEADER
  9
$ACADVER
  1
AC1009
  9
$DWGCODEPAGE
  3
ANSI_1252
  9
$INSBASE
 10
0.0000
 20
0.0000
 30
0.0000
  9
$EXTMIN
 10
0.0000
 20
-200.0000
 30
0.0000
  9
$EXTMAX
 10
4000.0000
 20
3000.0000
 30
0.0000
  9
$LIMMIN
 10
0.0000
 20
-200.0000
  9
$LIMMAX
 10
4000.0000
 20
3000.0000
  9
$LUNITS
 70
2
  9
$LUPREC
 70
4
  9
$LTSCALE
 40
1.0000
  9
$TEXTSTYLE
  7
STANDARD
  9
$CLAYER
  8
0
  9
$INSUNITS
 70
4
  9
$MEASUREMENT
 70
1
  0
ENDSEC
  0
SECTION
  2
TABLES
  0
TABLE
  2
LTYPE
 70
1
  0
LTYPE
  2
CONTINUOUS
 70
0
  3
Solid line
 72
65
 73
0
 40
0.0000
  0
ENDTAB
  0
TABLE
  2
LAYER
 70
5
  0
LAYER
  2
0
 70
0
 62
7
  6
CONTINUOUS
  0
LAYER
  2
L01-A-WALL
 70
0
 62
7
  6
CONTINUOUS
  0
LAYER
  2
L01-A-DOOR
 70
0
 62
1
  6
CONTINUOUS
  0
LAYER
  2
L01-A-AREA
 70
0
 62
3
  6
CONTINUOUS
  0
LAYER
  2
L01-A-ANNO-TEXT
 70
0
 62
7
  6
CONTINUOUS
  0
ENDTAB
  0
TABLE
  2
STYLE
 70
1
  0
STYLE
  2
STANDARD
 70
0
 40
0.0000
 41
1.0000
 50
0.0000
 71
0
 42
2.5000
  3
txt
  4

  0
ENDTAB
  0
ENDSEC
  0
SECTION
  2
BLOCKS
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
L01-A-WALL
 10
0.0000
 20
0.0000
 30
0.0000
 11
4000.0000
 21
0.0000
 31
0.0000
  0
LINE
  8
L01-A-WALL
 10
0.0000
 20
-200.0000
 30
0.0000
 11
4000.0000
 21
-200.0000
 31
0.0000
  0
LINE
  8
L01-A-WALL
 10
0.0000
 20
0.0000
 30
0.0000
 11
0.0000
 21
-200.0000
 31
0.0000
  0
LINE
  8
L01-A-WALL
 10
4000.0000
 20
-200.0000
 30
0.0000
 11
4000.0000
 21
0.0000
 31
0.0000
  0
POLYLINE
  8
L01-A-AREA
 66
1
 10
0.0000
 20
0.0000
 30
0.0000
 70
1
  0
VERTEX
  8
L01-A-AREA
 10
0.0000
 20
0.0000
 30
0.0000
 70
0
  0
VERTEX
  8
L01-A-AREA
 10
4000.0000
 20
0.0000
 30
0.0000
 70
0
  0
VERTEX
  8
L01-A-AREA
 10
4000.0000
 20
3000.0000
 30
0.0000
 70
0
  0
VERTEX
  8
L01-A-AREA
 10
0.0000
 20
3000.0000
 30
0.0000
 70
0
  0
SEQEND
  8
L01-A-AREA
  0
TEXT
  8
L01-A-ANNO-TEXT
 10
2000.0000
 20
1640.0000
 30
0.0000
 40
200.0000
  1
LIVING
 50
0.0000
  7
STANDARD
 72
1
 11
2000.0000
 21
1640.0000
 31
0.0000
 73
2
  0
TEXT
  8
L01-A-ANNO-TEXT
 10
2000.0000
 20
1360.0000
 30
0.0000
 40
150.0000
  1
12.00 m2
 50
0.0000
  7
STANDARD
 72
1
 11
2000.0000
 21
1360.0000
 31
0.0000
 73
2
  0
ENDSEC
  0
EOF

```

## Sources

- GOLDEN FILE + GENERATOR (this session, ezdxf 1.4.4): /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/spec/gen.py writes plan.dxf (2584 bytes, cp1252, CRLF, 392 lines) — the exact bytes of `minimalExample`. NOTE ON THE FIXTURE: it is shown above with LF for transport; on disk every line ends CRLF, the line after `  4` in the STYLE entry is an intentional EMPTY line, and there is a final CRLF after EOF. Contents: one 4000×3000 mm room (POLYLINE, closed, 4 corners), one 4000 mm wall of thickness 200 (4 LINEs: 2 faces + 2 end caps, centreline y = −100 so its inner face is the room boundary), and one room label (2 TEXT entities — R12 has no MTEXT).
- VERIFICATION OF THE GOLDEN FILE: /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/spec/check.py — ezdxf.readfile → dxfversion AC1009, encoding cp1252, audit 0 errors / 0 fixes; ezdxf.recover.readfile → 0/0; POLYLINE reads back as AcDb2dPolyline is_closed=True with all four corners; both TEXTs read back MIDDLE_CENTER at their insertion points with heights 200/150 and style STANDARD; all four LINEs colour 256 (BYLAYER) linetype BYLAYER; header $EXTMIN (0,−200,0), $EXTMAX (4000,3000,0), $LIMMIN (0,−200), $INSUNITS 4 → 'mm', $MEASUREMENT 1; five layers with the specified ACI colours, all on and thawed.
- MECHANICAL CHECKLIST IMPLEMENTATION: /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/spec/checklist.py — C1–C19 of §7 as executable assertions; all PASS on the golden file.
- MUTATION MATRIX (17 mutations of the golden file): /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/spec/mut.py — HARD REJECTS: no 0/EOF, no SEQEND, newline in a TEXT string, comma decimal, split 10/20 point, LWPOLYLINE in AC1009, missing empty line after STYLE `  4`. LOADS-BUT-WRONG (0 errors, 0 fixes): missing 66/1, missing TEXT 11/21/31, float in group 70, negative LAYER 62, nonzero STYLE 40, NaN coordinate, undefined layer on an entity, omitted BLOCKS section, omitted HEADER section. LOADS WITH FIXES: undefined linetype (2 fixes — the case AutoCAD rejects outright).
- ENCODING TEST: /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/spec/enc.py — cp1252 'Küche' → reads back 'Küche'; 'K\U+00FCche' → reads back literally as 'K\U+00FCche' (decode_dxf_unicode resolves it to 'Küche'); UTF-8 bytes → 'KÃ¼che'; '\U+5BA2\U+5385' → decodes to '客厅'. This is the evidence for the §8 D2 ruling.
- ARC TEST: /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/spec/door.py — a door leaf LINE plus swing ARC (10/1500, 20/0, 40/900, 50/0, 51/90) audits 0/0 and reads back sweeping CCW from (2400,0) to (1500,900).
- AutoCAD Release 12 DXF Reference (Autodesk archive) — https://damassets.autodesk.net/content/dam/autodesk/www/developer-network/platform-technologies/autocad-dxf-archive/acad_r12_dxf.pdf and the verbatim mirror https://github.com/mozman/dxfwrite/blob/master/doc/DXF12.txt — section order and the 'void DXF file' skeleton containing all four sections; 'Every entity contains an 8 group'; 'All groups are present for each table item'; 'the LTYPE table will always precede the LAYER table'; LINE/POLYLINE/VERTEX/SEQEND/TEXT/CIRCLE/ARC/LTYPE/LAYER/STYLE group lists; the 72/73 justification grid and the '11, 21, 31 ... appears only if 72 or 73 group is present and nonzero' rule; LTYPE 72 'always 65, the ASCII code for A'; LAYER negative-62 = off and 70 bit codes; 'group code ... output in FORTRAN I3 — right-justified and blank filled in a three-character field' with 'the DXFIN format is free'; 'string items should not have leading spaces'; the 256-character string limit; 'The EOF item must be present at the end-of-file'; $HANDLING/$HANDSEED semantics.
- ezdxf — DXF File Structure — https://ezdxf.readthedocs.io/en/stable/dxfinternals/filestructure.html (R12 requires only the ENTITIES section; R13+ mandatory set); Tables Section — https://ezdxf.readthedocs.io/en/stable/dxfinternals/sections/tables_section.html (no BLOCK_RECORD table in R12); Data Model — https://ezdxf.readthedocs.io/en/stable/dxfinternals/datamodel.html (R12 uses names, not handles); Handles — https://ezdxf.readthedocs.io/en/stable/dxfinternals/handles.html (handles optional R10–R12).
- ezdxf — File Encoding — https://ezdxf.readthedocs.io/en/stable/dxfinternals/fileencoding.html (cp1252 via $DWGCODEPAGE for pre-R2007; \U+nnnn for out-of-encoding characters; UTF-8 only from AC1021) and the Unicode decoder — https://ezdxf.readthedocs.io/en/stable/low_level_tools/dxf_unicode_decoder.html.
- ezdxf — Units — https://ezdxf.readthedocs.io/en/stable/concepts/units.html ($INSUNITS 4 = Millimeters, R2000+; DXF values are unitless) and Extents/Limits — https://ezdxf.readthedocs.io/en/stable/concepts/extents_limits.html.
- ezdxf — LWPolyline — https://ezdxf.readthedocs.io/en/stable/dxfentities/lwpolyline.html ('Required DXF version: DXF R2000') and TEXT — https://ezdxf.readthedocs.io/en/stable/dxfentities/text.html (halign/valign; ALIGNED and FIT need a second point).
- ezdxf r12writer add-on — https://ezdxf.readthedocs.io/en/stable/addons/r12writer.html and its source https://github.com/mozman/ezdxf/blob/master/src/ezdxf/addons/r12writer.py — a production R12 writer with no handles and no BLOCKS, whose PREFACE is the reference for the LTYPE CONTINUOUS and STYLE STANDARD records.
- ezdxf audit source — https://github.com/mozman/ezdxf/blob/stable/src/ezdxf/audit.py — verbatim: 'AutoCAD does not load DXF files with undefined line types' (the reason §7 C24 fails on any audit FIX); and lldxf/const.py INVALID_NAME_CHARACTERS = '<>/\":;?*=`'.
- LibreCAD / libdxfrw reader-side reality — https://github.com/LibreCAD/LibreCAD/blob/master/libraries/libdxfrw/src/intern/dxfreader.cpp (readCode strips one trailing \r then strtol; readString strips only a trailing \r, never leading whitespace; readInt16 rejects any non-integer text; readDouble uses strtod and accepts nan/inf), libdxfrw.cpp (processDxf returns BAD_UNKNOWN unless it reaches 0/EOF; processHeader aborts the whole read on one unparseable value), drw_textcodec.cpp (decodes \U+ and \M+ escapes; ANSI_1252 default).
- Autodesk support — 'Press ENTER to continue' and 'Improper table entry name' with long layer names when opening a DXF — https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Press-ENTER-to-continue-and-Improper-table-entry-name-with-long-layer-names-when-trying-to-open-a-DXF-file-in-AutoCAD.html.
- Paul Bourke, minimal DXF — https://paulbourke.net/dataformats/dxf/min3d.html — 'The model extents ($EXTMIN and $EXTMAX) are included here because some packages insist on it' (the reason §6 always computes them).
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/filestructure.html — 'For DXF R12 and prior only the ENTITIES section is required'; required-section list and mandatory TABLES/BLOCKS/OBJECTS entries for R13+
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/sections/header_section.html — 'In DXF R12 and prior the HEADER section was optional, but since DXF R13 the HEADER section is mandatory'; the 9/<name> variable form
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/sections/tables_section.html — table list; 'The TABLES section of DXF R12 and prior... does not contain the BLOCK_RECORD table'
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/datamodel.html — R12 uses names not handles; 'handles are mandatory' since R13; root DICTIONARY must be first in OBJECTS
- https://ezdxf.readthedocs.io/en/stable/addons/r12writer.html — a production R12 writer that emits only an ENTITIES section, no handles, no BLOCKS
- https://github.com/mozman/ezdxf/blob/master/src/ezdxf/addons/r12writer.py — the literal PREFACE constant (HEADER with only $ACADVER/$DWGCODEPAGE, then LTYPE/STYLE/VIEW tables), 3-char right-justified group codes, floats rounded to 6 decimals
- https://ezdxf.readthedocs.io/en/stable/concepts/layers.html — 'you can reference layer names even though you haven't defined them in the LAYER table. Such layers are automatically created with color 7 and the CONTINUOUS linetype'
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/fileencoding.html — cp1252 default for pre-R2007; non-encodable characters written as \U+nnnn; UTF-8 only from R2007/AC1021
- https://ezdxf.readthedocs.io/en/stable/low_level_tools/dxf_unicode_decoder.html — has_dxf_unicode()/decode_dxf_unicode() for \U+xxxx
- https://github.com/mozman/dxfwrite/blob/master/doc/DXF12.txt — verbatim mirror of the AutoCAD R12 DXF Reference: section order and the 'void DXF file' skeleton; group-code ranges table; 'group code... output in FORTRAN I3 - that is, right-justified and blank filled in a three-character field'; 'Although DXFOUT output has a fixed format, the DXFIN format is free'; 'string items should not have leading spaces'; 256-character string limit; $ACADVER/$INSBASE/$EXTMIN/$EXTMAX/$LIMMIN/$LIMMAX/$HANDLING/$HANDSEED group codes; 'the LTYPE table will always precede the LAYER table'; LAYER/LTYPE/STYLE/APPID entry group lists; 'If handles are enabled, every entity has a 5 group'
- https://damassets.autodesk.net/content/dam/autodesk/www/developer-network/platform-technologies/autocad-dxf-archive/acad_r12_dxf.pdf — Autodesk's archived R12 DXF Reference (the PDF is a scan; the DXF12.txt mirror above is the readable form of the same document)
- https://github.com/LibreCAD/LibreCAD/blob/master/libraries/libdxfrw/src/intern/dxfreader.cpp — reader-side reality: readCode() strips one trailing \r then strtol(); readString() strips only a trailing \r; readInt16() rejects any non-integer text; readDouble() uses strtod() (accepts exponents, and accepts nan/inf)
- https://github.com/LibreCAD/LibreCAD/blob/master/libraries/libdxfrw/src/libdxfrw.cpp — processDxf() skips unknown sections but returns BAD_UNKNOWN unless it reaches 0/EOF; processHeader() aborts the whole read on one unparseable value
- https://github.com/LibreCAD/LibreCAD/blob/master/libraries/libdxfrw/src/intern/drw_textcodec.cpp — libdxfrw decodes \U+ and \M+ escapes; ANSI_1252 default
- https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Press-ENTER-to-continue-and-Improper-table-entry-name-with-long-layer-names-when-trying-to-open-a-DXF-file-in-AutoCAD.html — Autodesk KB: layer names containing spaces or longer than 31 characters must be renamed
- https://documentation.help/AutoCAD-DXF/WS1a9193826455f5ff18cb41610ec0a2e719-79fc.htm — LWPOLYLINE group codes (R2000+ only), for the version comparison
- Local verification, ezdxf 1.4.4 in /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/t/ — final.dxf (recommended skeleton: 0 audit errors/fixes via both readfile and recover.readfile), lwpoly_in_r12.dxf (LWPOLYLINE in AC1009 -> DXFStructureError), nan.dxf (NaN/Infinity accepted silently), bad_int.dxf (62/'7.0' coerced by ezdxf), expo.dxf, uni_utf8.dxf / uni_esc.dxf / uni_cp1252.dxf (encoding), only_entities.dxf and no_final_nl.dxf and lf_nopad.dxf (all audit clean), r2000_full.dxf (hand-written minimal AC1015, 4791 bytes of which ~4.8KB is boilerplate), plus the size comparison: 200 walls + 40 doors + 20 six-vertex rooms + 20 labels = 38180 bytes of R12 ENTITIES vs 47440 bytes of R2000 ENTITIES
- AutoCAD Release 12 DXF Reference (official Autodesk archive PDF, u12.1.02) — https://damassets.autodesk.net/content/dam/autodesk/www/developer-network/platform-technologies/autocad-dxf-archive/acad_r12_dxf.pdf — source of the verbatim LINE / POLYLINE / VERTEX / SEQEND / TEXT / CIRCLE / ARC / LTYPE / LAYER / STYLE group-code definitions, the 66 and 70 flag semantics, the 72/73 justification grid, the 11/21/31 rule, 'Every entity contains an 8 group', 'All groups are present for each table item', and 'the LTYPE table always precedes the LAYER table'
- ezdxf — DXF File Structure — https://ezdxf.readthedocs.io/en/stable/dxfinternals/filestructure.html — 'the DXF R12 format (AC1009) and prior requires just the ENTITIES section'; contrast with the much larger R13+ mandatory set
- ezdxf — DXF Tags — https://ezdxf.readthedocs.io/en/stable/dxfinternals/dxftags.html — 'In LWPOLYLINE the order of tags is important, if the count tag is not the first tag in the AcDbPolyline subclass, AutoCAD will not close the polyline when the close flag is set'; 2n/3n coordinate tags must immediately follow 1n
- ezdxf — TEXT — https://ezdxf.readthedocs.io/en/stable/dxfentities/text.html — halign/valign values, and that ALIGNED and FIT require a second alignment point
- ezdxf — LWPolyline — https://ezdxf.readthedocs.io/en/stable/dxfentities/lwpolyline.html — 'Required DXF version: DXF R2000 (AC1015)'
- ezdxf — r12writer add-on — https://ezdxf.readthedocs.io/en/stable/addons/r12writer.html — 'Only LINE, CIRCLE, ARC, TEXT, POINT, SOLID, 3DFACE and POLYLINE entities are supported'; layers default to colour 7 / Continuous
- ezdxf r12writer source (known-good minimal R12 PREFACE with $ACADVER/$DWGCODEPAGE, LTYPE CONTINUOUS and STYLE STANDARD records) — https://raw.githubusercontent.com/mozman/ezdxf/master/src/ezdxf/addons/r12writer.py
- ezdxf — DXF File Encoding — https://ezdxf.readthedocs.io/en/stable/dxfinternals/fileencoding.html — R2004 and prior use $DWGCODEPAGE (ANSI_1252 default) with \U+nnnn escapes for out-of-encoding characters; UTF-8 only from R2007
- ezdxf — DXF Units — https://ezdxf.readthedocs.io/en/stable/concepts/units.html — DXF values are unitless; $INSUNITS = 4 means millimetres (R2000+ only; verified absent from the R12 reference)
- AutoCAD DXF Reference, LWPOLYLINE — https://help.autodesk.com/cloudhelp/2016/ENU/AutoCAD-DXF/files/GUID-748FC305-F3F2-4F74-825A-61F04D757A50.htm — full 100/90/70/43/38/39/10/20/91/40/41/42/210 table
- Autodesk support: 'Press ENTER to continue' and 'Improper table entry name' with long layer names when opening a DXF in AutoCAD — https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Press-ENTER-to-continue-and-Improper-table-entry-name-with-long-layer-names-when-trying-to-open-a-DXF-file-in-AutoCAD.html
- Empirical validation performed in this session: the minimalExample was written by hand and loaded with ezdxf 1.4.4 — readfile reports AC1009, the POLYLINE reads back as AcDb2dPolyline with is_closed=True and all four corners, the TEXT reads back as MIDDLE_CENTER at (2500, 2000), and doc.audit() reports 0 errors and 0 fixes. Variants (no 0/EOF, no 11/21/31, no 10/20/30 on POLYLINE, no 66, padded vs unpadded group codes, LF vs CRLF, no TABLES, no HEADER) were tested to establish which failures are hard errors and which are silently tolerated. Files: /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/plan.dxf
- https://damassets.autodesk.net/content/dam/autodesk/www/developer-network/platform-technologies/autocad-dxf-archive/acad_r12_dxf.pdf — official Autodesk AutoCAD R12 DXF reference (source for TEXT 72/73/11 semantics, POLYLINE 66/70/10-20-30, LAYER negative-62 = off and 70 bit codes, LTYPE-before-LAYER ordering, and the 'AutoCAD lets you omit many items' / 'EOF item must be present' guidance)
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/filestructure.html — required vs optional sections per DXF version; R12 requires only the ENTITIES section
- https://ezdxf.readthedocs.io/en/stable/concepts/units.html — full $INSUNITS table (4 = Millimeters), $MEASUREMENT independence, and 'any length or coordinate value in DXF is unitless in the first place'
- https://ezdxf.readthedocs.io/en/stable/concepts/extents_limits.html — $EXTMIN/$EXTMAX defaults (+/-1e20), ZOOM extents behaviour, and that extents are not maintained automatically
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/handles.html — handles optional for R10-R12 via $HANDLING, mandatory R13+, uniqueness and $HANDSEED
- https://github.com/mozman/ezdxf/blob/stable/src/ezdxf/audit.py — AuditError code list and the verbatim comment 'AutoCAD does not load DXF files with undefined line types'; also the undefined-text-style and invalid-colour-index handling
- https://github.com/mozman/ezdxf/blob/stable/src/ezdxf/addons/r12writer.py — the canonical hand-written R12 output, including the PREFACE header/tables constant and 'without a layer definition the assigned color = 7 and line type is Continuous'
- https://github.com/mozman/ezdxf/blob/stable/src/ezdxf/lldxf/repair.py — repair filters documenting real-world malformations: 'removes x-axis without following y-axis', 'removes y- and z-axis without leading x-axis', invalid hex handles
- https://github.com/mozman/ezdxf/blob/stable/src/ezdxf/lldxf/const.py — INVALID_NAME_CHARACTERS = '<>/\":;?*=`' (the illegal layer/table name set)
- https://paulbourke.net/dataformats/dxf/min3d.html — long-standing minimal-DXF reference: 'The model extents ($EXTMIN and $EXTMAX) are included here because some packages insist on it' and 'Most DXF importers will insist on predefining the layers in the tables' (disagrees with Autodesk's undefined-layer tolerance; defining layers is the safer path)
- https://ezdxf.readthedocs.io/en/stable/howto/document.html — setting $INSUNITS, and the ezdxf.recover module for loading flawed files
- https://ezdxf.readthedocs.io/en/stable/dxfinternals/tables/style_table.html — STYLE table / STANDARD entry semantics
- Empirical verification performed in this session with ezdxf 1.4.4 + matplotlib 3.10.9 in a venv: hand-wrote an R12 floor plan, confirmed 0 audit errors/fixes, confirmed $INSUNITS=4 round-trips out of an AC1009 file as 'Millimeters', then ran 20 mutation tests distinguishing hard rejects from silent-wrong. Artifacts: /private/tmp/claude-501/-Users-jaydenyu-Projects-archspace/0a65b056-c89f-4f32-9b88-ed9af04fb924/scratchpad/minimal.dxf (the minimalExample above, verified clean), cand_r12_a.dxf (two-room plan), break.py, break2.py, break3.py (mutation harnesses), render.png (visual proof that height-0 text and off/frozen layers vanish). NOTE: that scratchpad is shared with another session which overwrote a file mid-test, so the verified artifacts are the ones named here.
