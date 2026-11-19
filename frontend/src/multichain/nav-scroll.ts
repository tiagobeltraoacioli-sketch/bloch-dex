// The header's network list scrolls sideways on a narrow window (styles/gate.css). With seven networks the last
// names start outside it, so the selected network's link is brought into the list's own view: only the list is
// scrolled, never the page. Presentation only.
export function showCurrentNetwork(root: ParentNode = document): void {
  const nav = root.querySelector<HTMLElement>('.main-nav');
  const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!nav || !link || nav.scrollWidth <= nav.clientWidth) return;
  const [box, own] = [nav.getBoundingClientRect(), link.getBoundingClientRect()];
  if (own.left >= box.left && own.right <= box.right) return;
  nav.scrollLeft += own.left - box.left - (box.width - own.width) / 2;
}

/** Now, and once more when the page's fonts are in: the names change width then, and with them the list. */
export function keepCurrentNetworkInView(): void {
  showCurrentNetwork();
  try {
    void document.fonts?.ready.then(() => showCurrentNetwork());
  } catch {
    /* No font loading interface: the first placement stands. */
  }
}
