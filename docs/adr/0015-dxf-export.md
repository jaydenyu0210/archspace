# ADR-0015 — Export floor plans as DXF R12, written by hand

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

Until now nothing in Archspace produced drawable geometry. `aec.generate_bim_model` writes a genuine IFC4 SPF file with a correct `IFCPROJECT → IFCSITE → IFCBUILDING → IFCBUILDINGSTOREY` hierarchy and real GUIDs, but every element has null placement and null representation — open it in a viewer and you get a structure tree over an empty 3D view. `aec.export_table_csv` writes numbers. So the honest answer to "does this generate CAD or BIM files" was: a BIM *index*, and no CAD at all.

That is a strange gap, because the data for a drawing was already there and unused. `FloorPlanResult` (packages/nodes-core/src/shapes.ts) carries room polygons as real millimetre coordinates, wall centrelines with thicknesses and an exterior/interior kind, door positions with widths, and exit positions. It is a floor plan in every sense except that nothing rendered it.

The port type system needed no work at all: `asset<dxf>` already parsed, already widened to `asset`, already refused to connect to `asset<ifc>`, and already validated an `AssetRef` carrying `format: 'dxf'`. The seam was cut; nothing had been put through it.

## Decision

1. **Write DXF, not DWG.** DWG is Autodesk's proprietary format with no published specification; producing it means either a licensed SDK or a reverse-engineered library. The obvious candidate, LibreDWG, is GPL — and ADR-0001's consequences already rule that GPL libraries — naming LibreDWG specifically — can never be linked in-process and remain reachable only out-of-process via MCP. So DWG is not merely harder, it is on the far side of a licence boundary this project has already drawn. DXF is documented, is what every CAD tool imports, and is what interchange actually runs on.

2. **DXF R12 (`AC1009`), not R2000 or later.** R2000 would let a room be one compact `LWPOLYLINE` instead of a `POLYLINE` / `VERTEX`… / `SEQEND` group — roughly four times fewer lines. R12 is chosen anyway because it is the version every reader written in the last thirty years accepts. **We cannot test in AutoCAD from this machine**, so the tie-break goes to whatever is most likely to open correctly on the first try in a tool we never see. Verbosity is free; a file that a user's reader rejects is not.

3. **Hand-roll the writer; take no dependency.** Same reasoning as `bim-model.ts` writing IFC STEP by hand and `build/make-icon.py` writing PNG bytes: the format is documented and line-oriented, the subset a floor plan needs is small, and a DXF library would put a parser in the dependency path of an app that otherwise needs none. The cost is that every group code has to be right — paid for by keeping `dxf.ts` pure and having the test suite parse its output back into group-code pairs rather than matching substrings.

4. **Millimetres, passed through unscaled, with `$INSUNITS` = 4.** The floor plan declares `units: 'mm'` and DXF is unitless — a number in the file means whatever the reader is set to. Rescaling to metres would be a silent reinterpretation of the source data. R12 predates `$INSUNITS`, so a strict R12 reader ignores it; it is emitted anyway because every modern reader honours it, and without it a plan drawn in millimetres opens as though it were inches.

5. **Text is escaped to pure ASCII.** R12 predates Unicode: a reader decodes the file in its own single-byte codepage, so UTF-8 output arrives as mojibake — `m²` reads as `mÂ²`. Every character above 0x7e is escaped as `\U+XXXX`, which is the mechanism AutoCAD itself uses when saving a Unicode drawing back to R12. Because the file is then pure ASCII, `$DWGCODEPAGE` need not be guessed at: every codepage agrees below 0x7f. Newlines and other control characters are stripped from values — a newline in a room name would shift every following line onto the wrong side of the code/value pairing and corrupt the file from that byte onward.

6. **AIA-convention layer names with a storey suffix**: `A-WALL-EXTR-L0`, `A-WALL-INTR-L0`, `A-AREA-BDRY-L0`, `A-AREA-IDEN-L0`, `A-DOOR-L0`, `A-FLOR-EXIT-L0`. An architect opening the file already knows what those mean, and the suffix is what makes a multi-storey export switchable storey by storey. The suffix is present even in a single-storey export, so a layer name means the same thing in both modes. Only layers something was drawn on are declared.

7. **Walls are drawn as the rectangle they occupy**, the centreline offset by half the thickness in both perpendicular directions — not as hairline centrelines. A plan whose walls are lines throws away the one attribute that distinguishes a wall from a line.

8. **No door swing arcs.** `PlanDoor` carries a position and a width and no orientation. A swing would require guessing which wall the door belongs to and which way it opens. A circle of the door's width says exactly what is known — there is an opening this wide, here — and nothing that isn't. This is the project's standing rule about unimplemented capabilities (stated at the head of `packages/autodesk/src/capabilities.ts`: never present a mock as a working integration where a user can see it) applied one level down, to a detail inside an artefact rather than to a whole integration. A plausible-looking drafted swing reads as authoritative *because* it looks drafted, which makes inventing one worse than omitting it.

9. **`caching: 'pure'`, and byte-determinism is a tested property.** Reals are formatted to a fixed six decimals (`String(1e-7)` is `"1e-7"`, and exponent notation is not universally accepted; a fixed width also makes output identical across platforms), and negative zero is normalised. Same plan and params therefore produce the same bytes, the content-addressed store deduplicates a repeated export, and the engine can memoize the node.

## Consequences

- The honest answer to "does this generate CAD files" changes from "no" to "yes, DXF". README and `docs/STATUS.md` are updated; the "No CAD" line is gone and the remaining caveat is narrowed to DWG.
- **The IFC/DXF asymmetry is now sharper and should be said out loud**: the DXF has geometry and no semantics, the IFC has semantics and no geometry. Neither is a substitute for the other, and adding placement and `IFCEXTRUDEDAREASOLID` representations to the IFC writer is the obvious next piece of work.
- Verification is stronger than for any other artefact this project emits, because a real reader was available: the output loads in `ezdxf` in strict R12 mode with **0 audit errors and 0 fixes**, the declared `$EXTMIN`/`$EXTMAX` match the geometry bounding box exactly, all polylines report closed with the expected vertex counts, and each room label lands at a distinct position. It was rendered to a raster and looks like a floor plan.
- That verification caught a bug the unit tests could not: the tests decoded the asset as UTF-8 and so validated their own assumption, while a real reader showed `Corridor â€” 86.4 mÂ²`. Decision 5 exists because of it. **A test that round-trips through the same assumption as the writer proves nothing about the consumer**, which is a lesson worth generalising to the IFC writer.
- We still have not opened the file in AutoCAD. `ezdxf` is an independent implementation and its strict mode is genuinely strict, but it is not the same as the tool the user will use. R12 is chosen precisely to make that gap as small as possible; it is not closed.
- The bundled `concept-compliance` example now exports a DXF, so the first thing a new user runs produces a file they can open.

## Alternatives considered

- **A DXF library (`dxf-writer`, `@tarikjabiri/dxf`).** Fewer group codes to get right, but a runtime dependency in the engine child for a format we need a hundred lines of, and it moves the correctness question from "is this group code right" to "does this library's R12 output open everywhere" — which is the same question with less visibility.
- **SVG or PDF instead.** Both are easier and both are the wrong deliverable: an architect wants something to draw *over*, in layers, at true scale. A PDF is a picture of a plan.
- **Geometry in the IFC instead of a separate DXF.** Strictly more valuable, and it is where this should eventually go — `IFCEXTRUDEDAREASOLID` walls with proper `IFCLOCALPLACEMENT` would make the existing IFC file genuinely useful. It is also several times the work, and it would not have given anyone a drawing to open today. Recorded here as the next step rather than folded in.
- **`LWPOLYLINE` and R2000 for a smaller file.** ~4× fewer lines. A 6-storey export is 310 KB as R12; that is not a size worth trading reader compatibility for.
- **Inventing door swings from the adjacent wall.** Would look better in a screenshot. See decision 8.
