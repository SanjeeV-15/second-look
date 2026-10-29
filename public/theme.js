// Runs before the page paints so the chosen theme doesn't flash. Dark is the default;
// light is used only when the visitor switched to it. The OS setting is deliberately ignored.
let dark = true;
try {
  dark = localStorage.getItem('theme') !== 'light';
} catch {
  /* storage blocked: default dark */
}
if (dark) document.documentElement.dataset.theme = 'dark';
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#080b16' : '#eef2fa');
