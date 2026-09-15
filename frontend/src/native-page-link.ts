// Enabled only by the edge adapter on its pinned, reviewed Pages shell.
export function installNativePageLink(): () => void {
  if (
    document.querySelector('meta[name="postern-native-page"]')?.getAttribute('content') !== '/l1/'
  ) {
    return () => {};
  }
  const update = () => {
    const link = document.querySelector<HTMLAnchorElement>(
      'nav[aria-label="Main navigation"] a[href="#/native"]',
    );
    if (link) {
      link.href = '/l1/';
      link.setAttribute('data-postern-native-link', '1');
    }
  };
  update();
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
