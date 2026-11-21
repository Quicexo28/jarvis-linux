// Node ≥ 25 define un `localStorage` global que vale `undefined` si no se pasa
// `--localstorage-file`, y tapa el de jsdom. Se restituye el de jsdom.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom
if (dom && !globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => dom.window.localStorage })
}
