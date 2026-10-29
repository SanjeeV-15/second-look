// Runs before the page paints so the chosen theme doesn't flash. Dark is the default;
// light is used only when the visitor switched to it. The OS setting is deliberately ignored.
try {
  if (localStorage.getItem('theme') !== 'light') document.documentElement.dataset.theme = 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark'; // storage blocked: default dark
}
