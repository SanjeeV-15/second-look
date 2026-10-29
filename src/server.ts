import { createApp } from './app.js';

const port = Number(process.env.PORT) || 4320;

createApp().listen(port, () => {
  console.log(`youcam-closet listening on http://localhost:${port}`);
});
