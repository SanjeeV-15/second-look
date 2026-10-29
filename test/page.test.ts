import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const pub = (file: string) => path.join(process.cwd(), 'public', file);
const html = readFileSync(pub('index.html'), 'utf8');
const script = (file: string) => readFileSync(pub(file), 'utf8');

const htmlIds = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));

describe('page wiring', () => {
  // The scripts find elements by id. A typo or a removed element would not fail a build; it would throw
  // in the browser the first time that code runs, so check every lookup against the HTML.
  it.each(['app.js', 'camera.js'])('every element %s looks up exists in index.html', (file) => {
    const src = script(file);
    const wanted = new Set([
      ...[...src.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]),
      ...[...src.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]),
    ]);
    const missing = [...wanted].filter((id) => !htmlIds.has(id));
    expect(missing).toEqual([]);
  });

  it('has no duplicate ids', () => {
    const all = [...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
    expect(all.length).toBe(new Set(all).size);
  });

  it('every module the page loads exists', () => {
    for (const src of [...html.matchAll(/<script[^>]*src="\/([^"]+)"/g)].map((m) => m[1]!)) {
      expect(existsSync(pub(src)), src).toBe(true);
    }
    for (const href of [...html.matchAll(/<link[^>]*href="\/([^"]+)"/g)].map((m) => m[1]!)) {
      expect(existsSync(pub(href)), href).toBe(true);
    }
  });

  it('has a descriptive title, a favicon and a theme colour', () => {
    expect(html).toMatch(/<title>[^<]{12,}<\/title>/);
    expect(html).toContain('rel="icon"');
    expect(html).toContain('name="theme-color"');
    expect(readFileSync(pub('favicon.svg'), 'utf8')).toContain('<svg');
  });

  it('has a skip link that points at the main content', () => {
    expect(html).toMatch(/<a class="skip" href="#main">/);
    expect(html).toMatch(/<main[^>]*id="main"/);
  });

  it('is called Second Look everywhere the name shows', () => {
    expect(html).toMatch(/<title>Second Look/);
    expect(html).toContain('<h1>Second Look</h1>');
    expect(html).not.toContain('Closet Try-On');
    expect(readFileSync(path.join(process.cwd(), 'README.md'), 'utf8')).toMatch(/^# Second Look/);
  });

  it('shows the YouCam API activity behind each result, and says the try-on is powered by it', () => {
    expect(html).toContain('Try-on powered by the YouCam API');
    expect(html).toContain('YouCam API activity');
    expect(html).toMatch(/id="activity"/);
    expect(html).toMatch(/id="activity-list"/);
  });

  it('names YouCam in the app, not only in the video', () => {
    expect(html).toContain('Try-on generated with the YouCam API');
    expect(html).toContain('YouCam puts it on you');
  });

  it('announces try-on progress and errors to screen readers', () => {
    expect(html).toMatch(/id="progress"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="error-box"[^>]*role="alert"/);
  });

  it('keeps every image labelled', () => {
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of imgs) expect(tag, tag).toContain('alt=');
  });
});
