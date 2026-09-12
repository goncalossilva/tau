# Authoring models

Put customizable parameters at the top and keep model code below. See [parameter syntax](parameters.md) when exposing controls or documenting ranges.

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

This is an authoring example, not proof of printable geometry across every parameter combination. Validate the requested model and parameter values with syntax checks and [multi-angle visual inspection](../SKILL.md#visual-validation), then iterate as needed.

Sample models:

- [Parametric box with lid](../examples/parametric_box.scad)
- [Phone/tablet stand](../examples/phone_stand.scad)

Use [rendering and export](rendering.md) for previews or STL output when those are part of the task.
