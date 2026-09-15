import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// jsdom has no top layer. Interaction tests exercise controlled dialog state;
// real focus trapping and responsive layout still require browser validation.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/#/trade');
});
afterEach(() => {
  cleanup();
  delete window.ethereum;
  delete window.bloch;
  document.body.style.overflow = '';
});
