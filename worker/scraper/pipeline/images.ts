import sharp from "sharp";

export const PAGE_WIDTH = 800;
export const SAVER_WIDTH = 480;
export const MAX_SLICE_HEIGHT = 2000;

export interface ProcessedSlice {
  standard: Buffer; // WebP q80, lebar 800
  saver: Buffer;    // WebP q50, lebar 480 (mode hemat data)
  width: number;
  height: number;
}

/**
 * Normalisasi satu gambar sumber: auto-rotate, buang metadata, resize ke lebar 800,
 * lalu potong vertikal per ≤2000px agar browser tidak memuat satu file raksasa.
 */
export async function processPageImage(input: Buffer): Promise<ProcessedSlice[]> {
  const resized = await sharp(input, { limitInputPixels: 200_000_000 })
    .rotate()
    .resize({ width: PAGE_WIDTH, withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = resized.info;

  const slices: ProcessedSlice[] = [];
  for (let top = 0; top < height; top += MAX_SLICE_HEIGHT) {
    const h = Math.min(MAX_SLICE_HEIGHT, height - top);
    const region = sharp(resized.data).extract({ left: 0, top, width, height: h });
    const [standard, saver] = await Promise.all([
      region.clone().webp({ quality: 80 }).toBuffer(),
      region.clone().resize({ width: SAVER_WIDTH }).webp({ quality: 50 }).toBuffer(),
    ]);
    slices.push({ standard, saver, width, height: h });
  }
  return slices;
}

export async function processCover(input: Buffer) {
  return sharp(input).rotate().resize({ width: 480, height: 640, fit: "cover" }).webp({ quality: 82 }).toBuffer();
}
