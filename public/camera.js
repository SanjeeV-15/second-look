// Take a photo with the device camera. Phones hand off to the native camera app through a file input;
// desktops get a small preview dialog using getUserMedia. Resolves to a JPEG File, or null if cancelled.

function nativeCapture(facing) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', facing);
    input.addEventListener('change', () => resolve(input.files[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

function cameraError(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return new Error('Camera access was blocked. Allow it in your browser, or choose a photo instead.');
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
    return new Error('No camera was found. Choose a photo instead.');
  }
  return new Error("The camera couldn't start. Choose a photo instead.");
}

export async function takePhoto({ facing = 'user', hint = '' } = {}) {
  if (matchMedia('(pointer: coarse)').matches) return nativeCapture(facing);
  if (!navigator.mediaDevices?.getUserMedia) throw cameraError();

  const dialog = document.getElementById('camera-dialog');
  const video = dialog.querySelector('video');
  const status = dialog.querySelector('.camera-hint');
  const shoot = dialog.querySelector('[data-action="shoot"]');
  const cancel = dialog.querySelector('[data-action="cancel"]');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
  } catch (err) {
    throw cameraError(err);
  }

  video.srcObject = stream;
  video.classList.toggle('mirrored', facing === 'user'); // preview only: the saved photo is not flipped
  status.textContent = hint;
  await video.play().catch(() => {});

  return new Promise((resolve) => {
    let result = null;
    const finish = () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      shoot.removeEventListener('click', onShoot);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', finish);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onCancel = () => dialog.close();
    const onShoot = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (blob) result = new File([blob], 'camera.jpg', { type: 'image/jpeg' });
          dialog.close();
        },
        'image/jpeg',
        0.92,
      );
    };
    shoot.addEventListener('click', onShoot);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', finish);
    dialog.showModal();
  });
}
