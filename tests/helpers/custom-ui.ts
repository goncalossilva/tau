import assert from "node:assert/strict";
import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  TuiMainScreen,
  KeybindingsManager as TuiKeys,
  TUI_KEYBINDINGS,
  type Terminal,
} from "@earendil-works/pi-tui";

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomOptions = NonNullable<Parameters<ExtensionUIContext["custom"]>[1]>;
type Factory<T> = (
  tui: Parameters<CustomFactory>[0],
  theme: Parameters<CustomFactory>[1],
  keybindings: Parameters<CustomFactory>[2],
  done: (result: T) => void,
) => ReturnType<CustomFactory>;

/** Mount a real public custom-UI factory without starting a physical terminal.
 * Callers render, send keys, await the result, and dispose. Unexpected terminal I/O fails. */
export async function mountCustomUI<T>(
  factory: Factory<T>,
  theme: ExtensionUIContext["theme"],
  dimensions: { columns?: number; rows?: number } = {},
  options?: CustomOptions,
) {
  assert.ok(!options?.overlay, "approval belongs in the editor area, not an overlay");
  const terminal = new Proxy(
    {
      columns: 160,
      rows: 40,
      ...dimensions,
      showCursor() {},
      hideCursor() {},
      stop() {},
    } as Terminal,
    {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        throw new Error(`Unexpected terminal operation: ${String(key)}`);
      },
    },
  );
  const screen = new TuiMainScreen(terminal);
  screen.stop({ preserveScreen: true });
  let done!: (result: T) => void;
  const result = new Promise<T>((resolve) => {
    done = resolve;
  });
  try {
    const component = await factory(
      screen,
      theme,
      new TuiKeys(TUI_KEYBINDINGS) as KeybindingsManager,
      done,
    );
    screen.addChild(component);
    screen.setFocus(component);
    let disposed = false;
    return {
      component,
      result,
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          component.dispose?.();
        } finally {
          screen.removeChild(component);
          screen.stop({ preserveScreen: true });
        }
      },
    };
  } catch (error) {
    screen.stop({ preserveScreen: true });
    throw error;
  }
}
