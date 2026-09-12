# Parameters

Commands here run from the skill directory. Extracting existing parameters is independent of authoring, previews, export, or publishing.

## Inspect parameters

```bash
./scripts/extract-params.sh model.scad
./scripts/extract-params.sh model.scad --json
```

The extractor uses Python to inspect top-level declarations without evaluating OpenSCAD geometry. It reports names, values, inferred types, ranges/options, and descriptions. It is a text parser, not a full OpenSCAD interpreter; inspect the source when expressions or unusual formatting need interpretation.

Comment formats recognized by the extractor:

- `// [min:max]` numeric range
- `// [min:step:max]` numeric range with step
- `// [opt1, opt2, opt3]` dropdown options
- `// Description` free-form description

For example, `wall_thickness = 2; // [1:0.5:5] Wall thickness in mm` exposes a value, range, and description. For an authoring example, see [authoring](authoring.md).

## Render with JSON parameters

The rendering script takes a name-to-value object, **not** the metadata array emitted by `extract-params.sh --json`:

```json
{ "width": 60, "height": 40, "include_lid": true }
```

```bash
./scripts/render-with-params.sh model.scad params.json output.stl
./scripts/render-with-params.sh model.scad params.json output.png
```

Use parameter names supported by the model, and ensure the output directory exists. The script requires OpenSCAD plus `python3` or `jq`. PNG output uses a single isometric view. For changed geometry, also generate and inspect [multi-angle previews](rendering.md#previews) with matching parameter overrides; one JSON-driven PNG does not replace visual validation.
