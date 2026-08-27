# ADR-0016 — Give the IFC model real geometry, and verify it against IfcOpenShell

- **Status:** Accepted
- **Date:** 2026-08-26

## Context

`aec.generate_bim_model` has always written a genuine IFC4 SPF file: a correct `IFCPROJECT → IFCSITE → IFCBUILDING → IFCBUILDINGSTOREY` hierarchy, 636 walls, 159 spaces and 153 doors, deterministic GUIDs. Open it in a viewer and you get a complete structure tree over an empty 3D view, because every product had a null `ObjectPlacement` and a null `Representation`. `docs/STATUS.md` and the node's own manifest said so.

ADR-0015 named closing this gap as the obvious next piece of work, and made the case for doing it: the floor plan already carries every number the geometry needs — room polygons in millimetres, wall centrelines with thicknesses, door positions with widths — and the DXF export had just demonstrated that turning those into real geometry is a hundred lines of arithmetic, not a project.

ADR-0015 also produced the more important precondition. Its verification pass caught a bug the unit tests could not, because the tests decoded the DXF as UTF-8 — the writer's own assumption — and so validated the writer against itself. The generalisation was written into that ADR: *a test that round-trips through the same assumption as the writer proves nothing about the consumer*. IFC has an independent consumer available — IfcOpenShell, which ships a schema validator, an EXPRESS rule engine and a geometry kernel — and it had never been pointed at this output.

## Decision

1. **Author real geometry**: a placement chain (`IfcLocalPlacement`) from site through building and storey to each element, and one `IfcExtrudedAreaSolid` per space, wall and door, under a `Body` `IfcGeometricRepresentationSubContext`. Spaces extrude their own room polygon via `IfcArbitraryClosedProfileDef`; walls and doors extrude an `IfcRectangleProfileDef`.

2. **Declare units and a representation context.** `IfcProject` now carries `RepresentationContexts` and `UnitsInContext`, with `IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)`. Without them a viewer has no frame in which to interpret coordinates, so geometry that is present still does not draw — the same failure as having no geometry, arrived at differently.

3. **A wall's own frame runs along its centreline.** Its `IfcAxis2Placement3D` sits at the wall start with `RefDirection` pointing down the wall, so the profile is a plain `length × thickness` rectangle. An axis-aligned profile per wall cannot describe a wall that runs diagonally at all.

4. **Room polygons are wound counter-clockwise before extrusion.** `IfcArbitraryClosedProfileDef` takes its outer curve counter-clockwise; a clockwise ring sweeps with inverted normals and renders as a room that is invisible from outside while every number about it stays correct. Nothing upstream guarantees a winding, so it is established rather than assumed.

5. **Extract the arithmetic into `ifc.ts`**, pure and separately tested, exactly as `dxf.ts` sits under `export-dxf.ts`. STEP number formatting, polygon winding and wall framing are where the mistakes live, and every mistake in them produces a file that parses, opens, and is wrong.

6. **`stepReal` replaces the ad-hoc formatter.** STEP requires a decimal point on every real — `1` is an integer literal and a schema violation wherever a real is expected — and `String(n)` drops it on whole numbers and produces `1e-7`, which has no point at all. This did not bite before because every number written was a whole millimetre; unit direction vectors are fractional, and a wall running due north has an x-component of about 6e-17 rather than a clean zero. Values below 1e-9 are flushed to zero as the round-off they are.

7. **Fix the GUID encoding.** An `IfcGloballyUniqueId` packs a 128-bit UUID into 22 base64 characters, and 22 × 6 = 132 — so the leading character carries only the top 2 bits and can only ever be `0`, `1`, `2` or `3`. `ifcGuid` drew it from all 64 symbols, making roughly 94% of the GUIDs in every model this project has ever written non-conformant.

8. **Aggregate spaces into their storey rather than containing them.** `IfcSpace` is an `IfcSpatialStructureElement`, so it belongs in the decomposition tree via `IfcRelAggregates`. Listing it among an `IfcRelContainedInSpatialStructure`'s related elements — which is for physical products — breaks that relationship's `WR31` and leaves every space failing `IfcSpatialStructureElement.WR41`.

9. **Still no openings, slabs, roofs, materials or property sets.** `PlanDoor` names the room it serves and never the wall it sits in, so `IfcRelVoidsElement` would need a guess about which wall to perforate; there is no floor-plate outline in the plan, only room polygons, so a slab would mean unioning them and inventing an edge. Same rule as ADR-0015 decision 8, and the node's description says so.

10. **IfcOpenShell is the acceptance criterion**, not the test suite. The suite asserts structure; conformance and renderability are claims about a consumer and are checked against one.

## Consequences

- **Decisions 7 and 8 were not on the plan.** They are pre-existing bugs that the schema validator found the moment it was run — 885 GUID violations and 165 spatial-relationship violations in a file the entire test suite passed on. Adding geometry was the occasion for running the validator; the defects it surfaced are the larger result.
- Verification now stands on an independent implementation, and the numbers are worth stating: full IFC4 validation **including EXPRESS rules reports 0 issues**, down from 1050. The geometry engine produces **948 shapes from 948 representations with 0 failures**. Element volumes computed from the triangulated mesh match the source plan to 3e-12 relative for walls and 5e-12 for doors; spaces agree to 4e-4, which is `PlanRoom.areaM2` being a rounded number rather than a geometry error. Every storey's geometry sits at that storey's declared elevation, and the model bounds are 48.1 × 32.1 × 20.5 m for a six-storey building on a 48 × 32 m site.
- The test suite gained assertions that would have caught all of it: it now parses the STEP back into records and checks the attribute *slots*, because counting `IFCWALL` occurrences is exactly what let a file with 956 null placements pass for months. Each new assertion was confirmed to fail when the defect it guards is reintroduced.
- **The file is 7× larger** — 74 KB to 516 KB for six storeys. That is the cost of geometry and it is not worth optimising: it is still a fifth of a second to write and the node was never on a latency budget.
- `aec.generate_bim_model` remains a **mock** of a generative backend. Nothing here changes that; what changed is that its output is now a plausible artefact of one rather than an index with the geometry left out. The mock label in its manifest stays.
- The remaining honest caveats are narrower and more specific than "no geometry": no openings, no slabs, no materials. Those are recorded in the node's own header comment, where someone changing it will read them.

## Alternatives considered

- **Leave it as spatial structure and point users at the DXF.** Defensible while the DXF was new — but the two files answer different questions (the DXF has geometry and no semantics; the IFC had semantics and no geometry) and neither substitutes for the other. The gap was also the single largest caveat in `docs/STATUS.md`.
- **`IfcFacetedBrep` instead of swept solids.** More general, and wrong here: a wall genuinely is a profile swept upward, and a Brep would state the same shape with more entities, more ways to be wrong, and less information about intent. Swept solids also survive an import into a BIM authoring tool as editable extrusions.
- **Model openings by inferring each door's host wall** — nearest wall within a tolerance, say. Would produce a much better-looking model, and would be a guess presented as authored data. See decision 9.
- **Use IfcOpenShell as a build-time verification step in CI.** The right end state, and genuinely tempting now that the checks exist as a script. Not done here because it puts a Python toolchain and a ~100 MB wheel in the CI path for a project whose test story is deliberately `pnpm test` and nothing else. Recorded as the obvious follow-up, together with the same treatment for the DXF (`ezdxf`).
