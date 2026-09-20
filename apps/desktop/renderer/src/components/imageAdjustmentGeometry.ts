import {
  canvasImageAdjustmentsSchema,
  normalizedImageAdjustments,
  type CanvasImageAdjustments,
} from "@eve/contracts";

export interface ImageDimensions {
  width: number;
  height: number;
}

export type ImageAdjustmentVariant = "original" | "adjusted";
export type ImageAdjustmentFraming = "original" | "adjusted";

export interface ImageAdjustmentGeometry {
  frameAspectRatio: number;
  cropAspectRatio: number;
  viewportWidthPercent: number;
  viewportHeightPercent: number;
  viewportLeftPercent: number;
  viewportTopPercent: number;
  sourceWidthPercent: number;
  sourceHeightPercent: number;
  sourceLeftPercent: number;
  sourceTopPercent: number;
  straighten: number;
  coverScale: number;
  filter: string;
}

/** Numeric data only: no model-authored CSS or URL enters the presentation. */
export function validatedImageAdjustments(
  value?: CanvasImageAdjustments | null,
): CanvasImageAdjustments | null {
  const parsed = canvasImageAdjustmentsSchema.safeParse(
    value ?? normalizedImageAdjustments(),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Crop first, then rotate around that crop's center and enlarge enough that every
 * inverse-transformed viewport corner remains inside the crop. The scale uses
 * both axis constraints; a rotated bounding-box fit alone would expose corners.
 * Original pixels are never rewritten.
 *
 * The original variant shows the whole original, contained in the chosen frame.
 * Shared adjusted framing therefore makes honest comparisons the same size even
 * when a crop changes the edited aspect ratio.
 */
export function imageAdjustmentGeometry(
  dimensions: ImageDimensions,
  value?: CanvasImageAdjustments | null,
  variant: ImageAdjustmentVariant = "adjusted",
  framing: ImageAdjustmentFraming = "adjusted",
): ImageAdjustmentGeometry | null {
  if (
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  )
    return null;
  const settings = validatedImageAdjustments(value);
  if (!settings) return null;
  const effective =
    variant === "original" ? normalizedImageAdjustments() : settings;
  const nativeAspectRatio = dimensions.width / dimensions.height;
  const cropWidth = effective.crop.right - effective.crop.left;
  const cropHeight = effective.crop.bottom - effective.crop.top;
  const cropAspectRatio = (nativeAspectRatio * cropWidth) / cropHeight;
  const frameAspectRatio =
    framing === "original"
      ? nativeAspectRatio
      : (nativeAspectRatio * (settings.crop.right - settings.crop.left)) /
        (settings.crop.bottom - settings.crop.top);
  const viewportWidthPercent =
    100 * Math.min(1, cropAspectRatio / frameAspectRatio);
  const viewportHeightPercent =
    100 * Math.min(1, frameAspectRatio / cropAspectRatio);
  const angle = (effective.straighten * Math.PI) / 180;
  const sine = Math.abs(Math.sin(angle));
  const cosine = Math.abs(Math.cos(angle));
  const coverScale = Math.max(
    cosine + sine / cropAspectRatio,
    cosine + sine * cropAspectRatio,
  );
  const geometry: ImageAdjustmentGeometry = {
    frameAspectRatio,
    cropAspectRatio,
    viewportWidthPercent,
    viewportHeightPercent,
    viewportLeftPercent: (100 - viewportWidthPercent) / 2,
    viewportTopPercent: (100 - viewportHeightPercent) / 2,
    sourceWidthPercent: 100 / cropWidth,
    sourceHeightPercent: 100 / cropHeight,
    sourceLeftPercent: (-100 * effective.crop.left) / cropWidth,
    sourceTopPercent: (-100 * effective.crop.top) / cropHeight,
    straighten: effective.straighten,
    coverScale,
    filter: `brightness(${effective.brightness}) contrast(${effective.contrast}) saturate(${effective.saturation})`,
  };
  return Object.values(geometry).every(
    (number) => typeof number !== "number" || Number.isFinite(number),
  )
    ? geometry
    : null;
}
