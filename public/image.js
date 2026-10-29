const ACCEPTED = /^image\/(jpeg|png)$/;

// Shrink a photo in the browser before it goes anywhere: smaller uploads, faster try-ons,
// and phone photos (often 4000+ px) stay under YouCam's size limits.
export async function fileToDataUrl(file, maxSide = 1536, quality = 0.9) {
  if (!ACCEPTED.test(file.type)) throw new Error('Use a JPG or PNG photo.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be opened.");
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // PNGs with transparency would otherwise turn black as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

export async function postJson(url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Can't reach the server.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

// POST /api/render streams server-sent events. fetch (not EventSource) because it is a POST.
export async function streamRender(payload, onEvent, signal) {
  let res;
  try {
    res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw new Error("Can't reach the server.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Something went wrong.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (raw.startsWith('data: ')) onEvent(JSON.parse(raw.slice(6)));
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw new Error('The connection dropped before the try-on finished.');
  }
}

export async function tagImage(dataUrl) {
  return (await postJson('/api/tag', { image: dataUrl })).tags;
}
