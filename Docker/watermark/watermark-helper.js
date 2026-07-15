// === Watermark Helper for Evolution API Catalog Images ===
// Applies watermark text "warunglakku.com" to downloaded catalog images.
//
// Specs (v5):
//   Text: warunglakku.com
//   Position: Bottom-Right (↘) — text offset 10% from right edge
//   Font Size: 14pt (scaled relative to image size)
//   Opacity: 40% (0.4)
//   Font: Poppins Bold (installed via Dockerfile RUN apk add)
//   Background: NONE (text only)
//   EXIF Metadata: Copyright, Artist, ImageDescription = "warunglakku.com"
//
// Strategy:
//   1. Use sharp to load image buffer
//   2. Generate SVG overlay with watermark text at bottom-right, 40% opacity
//      - Poppins resolved by fontconfig since it's installed in system fonts
//   3. Composite SVG over image
//   4. Add EXIF metadata via sharp's withMetadata()
//   5. Output as JPEG

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const WATERMARK_TEXT = 'warunglakku.com';
const FONT_SIZE = 14; // 14pt (changed from 18pt)
const OPACITY = 0.4; // 40%
const FONT_FAMILY = 'Poppins';
const FONT_WEIGHT = 'bold';

/**
 * Apply watermark to image buffer.
 * Text only (no background pill), positioned at bottom-right.
 * Also injects EXIF metadata: Copyright, Artist, ImageDescription.
 *
 * @param {Buffer} imageBuffer - Original JPEG/PNG image
 * @returns {Promise<Buffer>} - Watermarked JPEG buffer with EXIF metadata
 */
async function applyWatermark(imageBuffer) {
  try {
    // Load image metadata to get dimensions
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
      Math.min(baseFontSize * 3, width / 22)
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
      .composite([{
        input: Buffer.from(svg),
        top: 0,
        left: 0,
        blend: 'over',
      }])
      .withMetadata({
        exif: {
          IFD0: {
            Copyright: `warunglakku.com`,
            Artist: `warunglakku.com`,
            ImageDescription: `warunglakku.com - Product catalog image`,
            Software: `Warung Lakku Watermark System v3`,
          },
        },
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    return watermarked;
  } catch (e) {
    console.error(`[watermark] FAILED: ${e.message}`);
    return imageBuffer; // Return original on failure
  }
}

// Test function (callable from CLI)
async function testWatermark(inputPath, outputPath) {
  const buf = fs.readFileSync(inputPath);
  console.log(`Original size: ${buf.length} bytes`);
  const out = await applyWatermark(buf);
  console.log(`Watermarked size: ${out.length} bytes`);
  fs.writeFileSync(outputPath, out);
  console.log(`Saved to ${outputPath}`);

  // Verify EXIF was written
  try {
    const meta = await sharp(out).metadata();
    console.log('\n=== EXIF metadata verification ===');
    if (meta.exif) {
      // exif is a Buffer containing raw EXIF data
      const exifStr = meta.exif.toString('utf-8');
      const found = [];
      for (const tag of ['warunglakku.com', 'Copyright', 'Artist', 'ImageDescription', 'Software']) {
        if (exifStr.includes(tag)) found.push(tag);
      }
      console.log(`EXIF buffer size: ${meta.exif.length} bytes`);
      console.log(`Found tags/strings: ${found.join(', ') || 'NONE'}`);
    } else {
      console.log('⚠ No EXIF data in output image');
    }
  } catch (e) {
    console.log('Could not read EXIF:', e.message);
  }
}

module.exports = { applyWatermark, testWatermark };

// CLI entry: node watermark_helper.js <input> <output>
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node watermark_helper.js <input.jpg> <output.jpg>');
    process.exit(1);
  }
  testWatermark(args[0], args[1]).catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
