---
name: openscad
description: "Create and render OpenSCAD 3D models. Generate preview images from multiple angles, extract customizable parameters, validate syntax, and export STL files for 3D printing platforms like Printables."
---

# OpenSCAD

Create, validate, visually verify, and export OpenSCAD 3D models.

## Requirements

The `openscad` executable is available on `PATH` (or discoverable in common locations like `/Applications/OpenSCAD.app` on macOS).

## Scripts

This skill ships helper scripts under `scripts/`. Run the commands below from this skill directory.

### Preview generation

```bash
# Generate a single preview image
"./scripts/preview.sh" model.scad output.png \
  [--camera=x,y,z,rotx,roty,rotz,distance] [--size=800x600]

# Generate multi-angle previews (front, back, left, right, top, iso)
"./scripts/multi-preview.sh" model.scad output_dir/
```

### STL export

```bash
"./scripts/export-stl.sh" model.scad output.stl [-D 'param=value']
```

### Parameter extraction

```bash
"./scripts/extract-params.sh" model.scad
```

### Validation

```bash
"./scripts/validate.sh" model.scad
```

### Render with params from JSON

```bash
"./scripts/render-with-params.sh" model.scad params.json output.stl
"./scripts/render-with-params.sh" model.scad params.json output.png
```

## Visual validation

Always validate models visually after creating or modifying them:

1. Generate multi-angle previews.
2. View _each_ generated image with the agent's image viewer (in this environment: the `read` tool).
3. Check geometry from multiple perspectives (front/back/left/right/top/iso).
4. Iterate until the renders match the intent.

Syntax validation alone will not catch common geometry problems (misaligned booleans, missing/floating geometry, inverted geometry, z-fighting, wrong proportions).

## Workflow

### 1) Create a parametric model

Put customizable parameters at the top and keep the model code below.

```openscad
// Customizable parameters
wall_thickness = 2;        // [1:0.5:5] Wall thickness in mm
width = 50;                // [20:100] Width in mm
height = 30;               // [10:80] Height in mm
rounded = true;            // Add rounded corners

module main_shape() {
    if (rounded) {
        minkowski() {
            cube([width - 4, width - 4, height - 2]);
            sphere(r = 2);
        }
    } else {
        cube([width, width, height]);
    }
}

difference() {
    main_shape();
    translate([wall_thickness, wall_thickness, wall_thickness])
        scale([1 - 2*wall_thickness/width, 1 - 2*wall_thickness/width, 1])
        main_shape();
}
```

Parameter comment formats:

- `// [min:max]` numeric range
- `// [min:step:max]` numeric range with step
- `// [opt1, opt2, opt3]` dropdown options
- `// Description` free-form description

### 2) Validate

```bash
"./scripts/validate.sh" model.scad
```

### 3) Render previews (then inspect them)

```bash
"./scripts/multi-preview.sh" model.scad ./previews/
```

Use `read` to open each PNG in `./previews/` and confirm the model is correct.

### 4) Export STL

```bash
"./scripts/export-stl.sh" model.scad output.stl

# With parameter overrides:
"./scripts/export-stl.sh" model.scad output.stl -D 'width=60' -D 'height=40'
```

## Camera positions

Common camera angles:

- Isometric: `--camera=0,0,0,45,0,45,200`
- Front: `--camera=0,0,0,90,0,0,200`
- Top: `--camera=0,0,0,0,0,0,200`
- Right: `--camera=0,0,0,90,0,90,200`

Format: `x,y,z,rotx,roty,rotz,distance`

## Printables publishing checklist

Typically you need:

1. STL file(s) exported via `export-stl.sh`
2. Preview images (at least one strong hero/isometric view plus extra angles)
3. A model description covering customizable parameters, print settings, and assembly/use notes
4. License/category/tags filled in for discoverability

## Examples

Sample models live under `examples/`.
