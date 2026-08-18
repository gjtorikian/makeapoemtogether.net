// Tiny DOM helpers — just enough to build screens without a framework runtime.
// We never set innerHTML, so user-supplied strings (revealed words, error text)
// are always inserted as text nodes and cannot inject markup.

type Child = Node | string | number | null | undefined | false;

type Handlers = {
  [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void;
};

export interface ElProps {
  class?: string;
  text?: string;
  href?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  inputmode?: string;
  autocapitalize?: string;
  autocomplete?: string;
  spellcheck?: string;
  maxlength?: number;
  disabled?: boolean;
  role?: string;
  ariaLabel?: string;
  dataset?: Record<string, string>;
  on?: Handlers;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, text, ariaLabel, dataset, on, disabled, value, ...attrs } =
    props;

  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  if (ariaLabel != null) node.setAttribute("aria-label", ariaLabel);
  if (disabled) (node as HTMLButtonElement | HTMLInputElement).disabled = true;
  if (value != null) (node as HTMLInputElement).value = value;

  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  }
  if (on) {
    for (const [type, handler] of Object.entries(on)) {
      node.addEventListener(type, handler as EventListener);
    }
  }
  append(node, children);
  return node;
}

export function append(node: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false || c === "") continue;
    node.append(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
