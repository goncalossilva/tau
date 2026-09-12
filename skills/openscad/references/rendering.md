# Rendering and export

Run commands from the skill directory, or use absolute script paths resolved there. Previews and exports support repeated `-D 'name=value'` overrides. Use the same values when inspecting and exporting a parameter variant.

## Previews

```bash
# Single image with optional camera, size, and parameter overrides
./scripts/preview.sh model.scad output.png --size=800x600
./scripts/preview.sh model.scad output.png \
  --camera=0,0,0,45,0,45,200 -D 'width=60'

# Front, back, left, right, top, and isometric views
./scripts/multi-preview.sh model.scad previews/
./scripts/multi-preview.sh model.scad previews/ -D 'width=60' -D 'height=40'
```

Multi-preview writes `<model>_<angle>.png` files. Open each generated PNG with `read` (or the available image viewer) and follow the [visual validation requirements](../SKILL.md#visual-validation). A successful render command alone does not establish that the model matches the request.

## Cameras

Camera format: `x,y,z,rotx,roty,rotz,distance`.

| View                        | Example camera                |
| --------------------------- | ----------------------------- |
| Isometric                   | `--camera=0,0,0,45,0,45,200`  |
| Front                       | `--camera=0,0,0,90,0,0,200`   |
| Top                         | `--camera=0,0,0,0,0,0,200`    |
| Right (as in multi-preview) | `--camera=0,0,0,90,0,-90,200` |

The scripts use `--autocenter` and `--viewall` to frame the model. Their default isometric rotation is `55,0,25`; the table offers an alternative. Single previews accept `--size=WxH` (default `800x600`). Multi-preview uses fixed `800x600` views.

## STL export

```bash
./scripts/export-stl.sh model.scad output.stl
./scripts/export-stl.sh model.scad output.stl -D 'width=60' -D 'height=40'
```

For JSON-supplied overrides, use [render-with-params](parameters.md#render-with-json-parameters). Export only the requested models/variants. Newly created or changed geometry still requires multi-angle visual inspection; exporting successfully is not a substitute.
