import { ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMainScreen, TuiAltScreen } from "@earendil-works/pi-tui";

/** Adapt the host's dialog mounting only; Pi's real selector owns selection and key handling. */
export function openSelector(
  tui: TuiMainScreen | TuiAltScreen,
  editor: Component,
  title: string,
  choices: string[],
  signal?: AbortSignal,
  toggleExpanded?: () => void,
) {
  let resolve!: (value: string | undefined) => void;
  const result = new Promise<string | undefined>((done) => {
    resolve = done;
  });
  let closed = false;
  const answer = (value: string | undefined) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", cancel);
    component.dispose();
    tui.setFocus(editor);
    resolve(value);
  };
  const cancel = () => answer(undefined);
  const component = new ExtensionSelectorComponent(title, choices, answer, cancel, {
    tui,
    onToggleToolsExpanded: toggleExpanded,
  });
  tui.setFocus(component);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return { result, answer };
}
