// Runs before the page paints so the chosen theme doesn't flash. Light is the default;
// dark is used only when the visitor switched to it. The OS setting is deliberately ignored.
let dark = false;
try {
  dark = localStorage.getItem('theme') === 'dark';
} catch {
  /* storage blocked: default light */
}
if (dark) document.documentElement.dataset.theme = 'dark';
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#080b16' : '#eef2fa');
