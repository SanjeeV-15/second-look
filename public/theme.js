// Runs before the page paints so a saved dark theme doesn't flash light first.
// Light is the default for everyone: the OS setting is deliberately ignored.
try {
  if (localStorage.getItem('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch {
  /* storage blocked: stay light */
}
