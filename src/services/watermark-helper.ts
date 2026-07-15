/**
 * Watermark Helper for Evolution API Catalog Images
 * ---------------------------------------------------------------------
 * Applies watermark text "warunglakku.com" to downloaded catalog images.
 *
 * Specs (v5):
 *   Text: warunglakku.com
 *   Position: Bottom-Right (↘) — text offset 10% from right edge
 *   Font Size: 14pt (scaled relative to image size)
 *   Opacity: 40% (0.4)
 *   Font: Poppins Bold (installed via Dockerfile RUN apk add + fc-cache)
 *   Background: NONE (text only, no pill/rounded rectangle)
 *   EXIF Metadata: Copyright, Artist, ImageDescription = "warunglakku.com"
 *
 * Strategy:
 *   1. Use sharp to load image buffer + read dimensions
 *   2. Generate SVG overlay with watermark text at bottom-right, 40% opacity
 *      - Poppins resolved by fontconfig since it's installed in system fonts
 *   3. Composite SVG over image
 *   4. Add EXIF metadata via sharp's withMetadata()
 *   5. Output as JPEG
 */

import sharp from 'sharp';

const WATERMARK_TEXT = 'warunglakku.com';
const FONT_SIZE = 14; // 14pt
const OPACITY = 0.4; // 40%
const FONT_FAMILY = 'Poppins';
const FONT_WEIGHT = 'bold';

/**
 * Apply watermark to image buffer.
 * Text only (no background pill), positioned at bottom-right with 10% offset.
 * Also injects EXIF metadata: Copyright, Artist, ImageDescription.
 *
 * @param imageBuffer - Original JPEG/PNG image buffer
 * @returns Watermarked JPEG buffer with EXIF metadata
 */
export async function applyWatermark(imageBuffer: Buffer): Promise<Buffer> {
  try {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    if (!width || !height) {
      console.warn('[watermark] Cannot get image dimensions, returning original');
      return imageBuffer;
    }

    // Calculate font size relative to image size
    // Spec: 14pt at standard 96 DPI = ~18.67px
    // Scale up for larger images (cap at 3x base size)
    const baseFontSize = FONT_SIZE * (96 / 72); // 14pt → ~18.67px at 96 DPI
    const scaledFontSize = Math.max(
      baseFontSize,
      Math.min(baseFontSize * 3, width / 22),
    );

    // Estimate text width for Poppins Bold (~0.55em per char average)
    const textWidth = WATERMARK_TEXT.length * scaledFontSize * 0.55;

    // Position: Bottom-Right (↘), with 10% width offset from right edge
    // Reason: text-width estimate (0.55em/char) is approximate; actual Poppins Bold
    // is wider. Shifting text 10% of width to the left ensures the right edge
    // of the text is fully visible (not clipped by image edge).
    const rightOffset = width * 0.10; // 10% of image width
    const bottomMargin = Math.max(15, height * 0.03);
    // x: left edge of text (so right edge of text = width - rightOffset)
    const x = width - textWidth - rightOffset;
    // y: baseline of text (text drawn from y-fontSize to y)
    // Place baseline 'bottomMargin' pixels above the bottom edge
    const y = height - bottomMargin;

    // Build SVG with ONLY text (no background pill)
    // Poppins is resolved via fontconfig since it's installed in system fonts
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="${x}" y="${y}"
        font-family="${FONT_FAMILY}"
        font-weight="${FONT_WEIGHT}"
        font-size="${scaledFontSize}"
        fill="#ffffff"
        fill-opacity="${OPACITY}"
        letter-spacing="1">${WATERMARK_TEXT}</text>
</svg>`;

    // Composite SVG over image + add EXIF metadata
    // EXIF tags:
    //   IFD0.Copyright         — copyright info
    //   IFD0.Artist            — author/creator
    //   IFD0.ImageDescription  — description
    //   IFD0.Software          — software that created this image
    const watermarked = await sharp(imageBuffer)
      .composite([
        {
          input: Buffer.from(svg),
          top: 0,
          left: 0,
          blend: 'over',
        },
      ])
      .withMetadata({
        exif: {
          IFD0: {
            Copyright: 'warunglakku.com',
            Artist: 'warunglakku.com',
            ImageDescription: 'warunglakku.com - Product catalog image',
            Software: 'Warung Lakku Watermark System v5',
          },
        },
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    return watermarked;
  } catch (e) {
    console.error(`[watermark] FAILED: ${(e as Error).message}`);
    return imageBuffer; // Return original on failure
  }
}
