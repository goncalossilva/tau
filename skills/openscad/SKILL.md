---
name: openscad
description: "Create, modify, render, validate, or export OpenSCAD models, and inspect their customizable parameters."
---

# OpenSCAD

Choose the requested operation rather than running a full create-to-publish workflow. Commands below run from this skill directory; resolve script paths there when working elsewhere.

## Task router

| Task                                 | Script / reference                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create or change geometry            | [Authoring](references/authoring.md) and [sample models](examples/). Validate and visually inspect changes as described below.                                                                       |
| Inspect customizable parameters only | `scripts/extract-params.sh model.scad [--json]`. See [parameter syntax and output](references/parameters.md). No creation, rendering, or export is required.                                         |
| Validate syntax                      | `scripts/validate.sh model.scad`. This parses/evaluates; it does not establish geometric correctness.                                                                                                |
| Preview a model                      | `scripts/preview.sh model.scad output.png` or `scripts/multi-preview.sh model.scad previews/`. See [rendering and cameras](references/rendering.md).                                                 |
| Render a parameter variant           | `scripts/render-with-params.sh model.scad params.json output.stl` (or `.png`). See [JSON parameter input](references/parameters.md#render-with-json-parameters). Visually validate geometry changes. |
| Export STL                           | `scripts/export-stl.sh model.scad output.stl [-D 'param=value']`. See [export details](references/rendering.md#stl-export).                                                                          |
| Prepare publishing assets            | [Publishing checklist](references/publishing.md). Asset preparation does not imply uploading or publishing.                                                                                          |

## Requirements

- Scripts use Bash.
- Rendering, validation, and export require `openscad` on `PATH` or in a location found by [scripts/common.sh](scripts/common.sh), such as `/Applications/OpenSCAD.app` on macOS.
- Parameter extraction requires `python3`, not OpenSCAD.
- JSON-driven rendering requires `python3` or `jq` as well as OpenSCAD.
- Visual inspection requires an image viewer. In this environment, use the `read` tool.

## Visual validation

After creating or modifying geometry, including parameter variants:

1. Run syntax validation and generate multi-angle previews of the changed model.
2. Open **each** generated image with `read` (or the available image viewer).
3. Inspect front, back, left, right, top, and isometric views. Check for misaligned booleans, missing/floating geometry, inverted geometry, z-fighting, and incorrect proportions.
4. Iterate until the renders match the intended geometry. Use the same parameter values for validation previews and final exports.

Syntax success or merely generating PNGs is not visual validation. Report any inability to render or inspect the images rather than claiming the model is verified. Extraction-only and syntax-only requests stop at their requested result; they do not imply geometry edits or an export.

Deliver the requested source, parameter report, or generated files and state what was actually validated. Load publishing guidance only when publishing preparation is part of the task.
