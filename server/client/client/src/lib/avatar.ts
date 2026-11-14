import { api, KeyedError } from './api';

/** Crops the middle square of a photo and returns a 256px JPEG, which is what the server accepts. */
export async function squareJpeg(file: File, size = 256): Promise<Blob> {
  if (!file || !/^image\//.test(file.type || '')) throw new KeyedError('err.imageType');
  if (file.size > 15 * 1024 * 1024) throw new KeyedError('err.imageBig');

  let bmp: ImageBitmap | HTMLImageElement;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const href = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(href); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(href); reject(new KeyedError('err.imageRead')); };
      img.src = href;
    });
  }
  const w = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
  const h = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
  const s = Math.min(w, h);
  if (!s) throw new KeyedError('err.imageRead');

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#23262d';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bmp, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
  if ('close' in bmp) bmp.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new KeyedError('err.imageProcess');
  return blob;
}

export async function uploadAvatarWith(blob: Blob, token: string): Promise<Record<string, unknown>> {
  const data = await api<{ user: Record<string, unknown> }>('/api/avatar', { method: 'PUT', token, rawBody: blob, contentType: 'image/jpeg' });
  return data.user;
}
