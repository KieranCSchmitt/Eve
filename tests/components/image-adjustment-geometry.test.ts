import { describe, expect, it } from "vitest";
import {
  normalizedImageAdjustments,
  type CanvasImageAdjustments,
} from "../../packages/contracts/src/index";
import {
  imageAdjustmentGeometry,
  validatedImageAdjustments,
} from "../../apps/desktop/renderer/src/components/imageAdjustmentGeometry";

const settings = (
  edits: Partial<CanvasImageAdjustments> = {},
): CanvasImageAdjustments => ({ ...normalizedImageAdjustments(), ...edits });

describe("read-only image adjustment geometry", () => {
  it("projects the neutral original at native aspect without offsets or enlargement", () => {
    expect(imageAdjustmentGeometry({ width: 1600, height: 900 })).toEqual({
      frameAspectRatio: 16 / 9,
      cropAspectRatio: 16 / 9,
      viewportWidthPercent: 100,
      viewportHeightPercent: 100,
      viewportLeftPercent: 0,
      viewportTopPercent: 0,
      sourceWidthPercent: 100,
      sourceHeightPercent: 100,
      sourceLeftPercent: -0,
      sourceTopPercent: -0,
      straighten: 0,
      coverScale: 1,
      filter: "brightness(1) contrast(1) saturate(1)",
    });
    expect(imageAdjustmentGeometry({ width: 1600, height: 900 }, null)).toEqual(
      imageAdjustmentGeometry({ width: 1600, height: 900 }),
    );
  });

  it("maps crop edges to source pixels without mutating registered settings", () => {
    const value = settings({
      brightness: 1.25,
      contrast: 0.75,
      saturation: 0,
      crop: { left: 0.25, top: 0.1, right: 0.75, bottom: 0.9 },
    });
    const original = structuredClone(value);
    const geometry = imageAdjustmentGeometry(
      { width: 1200, height: 800 },
      value,
    )!;
    expect(geometry.frameAspectRatio).toBeCloseTo(600 / 640);
    expect(geometry.sourceWidthPercent).toBe(200);
    expect(geometry.sourceHeightPercent).toBe(125);
    expect(geometry.sourceLeftPercent).toBe(-50);
    expect(geometry.sourceTopPercent).toBe(-12.5);
    expect(geometry.filter).toBe("brightness(1.25) contrast(0.75) saturate(0)");
    expect(value).toEqual(original);
  });

  it("shares an edited frame while containing the whole unfiltered original", () => {
    const value = settings({
      brightness: 2,
      straighten: 15,
      crop: { left: 0.25, top: 0, right: 0.75, bottom: 1 },
    });
    const adjusted = imageAdjustmentGeometry(
      { width: 1600, height: 800 },
      value,
    )!;
    const original = imageAdjustmentGeometry(
      { width: 1600, height: 800 },
      value,
      "original",
      "adjusted",
    )!;
    expect(original.frameAspectRatio).toBe(adjusted.frameAspectRatio);
    expect(original.frameAspectRatio).toBe(1);
    expect(original.viewportWidthPercent).toBe(100);
    expect(original.viewportHeightPercent).toBe(50);
    expect(original.viewportTopPercent).toBe(25);
    expect(original.sourceWidthPercent).toBe(100);
    expect(original.sourceLeftPercent).toBe(-0);
    expect(original.straighten).toBe(0);
    expect(original.coverScale).toBe(1);
    expect(original.filter).toBe("brightness(1) contrast(1) saturate(1)");
    const sourceFrame = imageAdjustmentGeometry(
      { width: 1600, height: 800 },
      value,
      "original",
      "original",
    )!;
    expect(sourceFrame.frameAspectRatio).toBe(2);
    expect(sourceFrame.viewportHeightPercent).toBe(100);
  });

  it("can contain a portrait crop inside an original landscape frame", () => {
    const geometry = imageAdjustmentGeometry(
      { width: 1600, height: 800 },
      settings({ crop: { left: 0.4, top: 0, right: 0.6, bottom: 1 } }),
      "adjusted",
      "original",
    )!;
    expect(geometry.frameAspectRatio).toBe(2);
    expect(geometry.viewportWidthPercent).toBeCloseTo(20);
    expect(geometry.viewportLeftPercent).toBeCloseTo(40);
    expect(geometry.viewportHeightPercent).toBe(100);
  });

  it("keeps every inverse-rotated visible corner inside the selected crop across portrait, landscape and small edge crops", () => {
    for (const width of [1, 390, 1280, 12000]) {
      for (const height of [1, 240, 844, 9000]) {
        for (const crop of [
          { left: 0, top: 0, right: 1, bottom: 1 },
          { left: 0.95, top: 0, right: 1, bottom: 0.25 },
          { left: 0.2, top: 0.8, right: 0.6, bottom: 0.85 },
        ]) {
          for (const angle of [-15, -7.5, -0.1, 0, 0.1, 7.5, 15]) {
            const geometry = imageAdjustmentGeometry(
              { width, height },
              settings({ crop, straighten: angle }),
            )!;
            expect(geometry).not.toBeNull();
            const cropWidth = width * (crop.right - crop.left);
            const cropHeight = height * (crop.bottom - crop.top);
            const radians = (-angle * Math.PI) / 180;
            for (const x of [-cropWidth / 2, cropWidth / 2]) {
              for (const y of [-cropHeight / 2, cropHeight / 2]) {
                const originalX =
                  (x * Math.cos(radians) - y * Math.sin(radians)) /
                  geometry.coverScale;
                const originalY =
                  (x * Math.sin(radians) + y * Math.cos(radians)) /
                  geometry.coverScale;
                expect(Math.abs(originalX)).toBeLessThanOrEqual(
                  cropWidth / 2 + 1e-8,
                );
                expect(Math.abs(originalY)).toBeLessThanOrEqual(
                  cropHeight / 2 + 1e-8,
                );
              }
            }
          }
        }
      }
    }
  });

  it("uses the same cover scale for either rotation direction", () => {
    const dimensions = { width: 1900, height: 800 };
    const positive = imageAdjustmentGeometry(
      dimensions,
      settings({ straighten: 12 }),
    )!;
    const negative = imageAdjustmentGeometry(
      dimensions,
      settings({ straighten: -12 }),
    )!;
    expect(positive.coverScale).toBe(negative.coverScale);
    expect(positive.straighten).toBe(-negative.straighten);
  });

  it.each([
    { brightness: 0 },
    { brightness: Infinity },
    { contrast: 3 },
    { saturation: -1 },
    { straighten: NaN },
    { straighten: 16 },
    { crop: { left: 0, top: 0, right: 0.01, bottom: 1 } },
    { crop: { left: 0, top: 0, right: 2, bottom: 1 } },
    { brightness: "1) url(https://example.invalid)" },
  ])(
    "refuses invalid settings instead of creating a CSS projection: %j",
    (invalid) => {
      const value = { ...settings(), ...invalid } as CanvasImageAdjustments;
      expect(validatedImageAdjustments(value)).toBeNull();
      expect(
        imageAdjustmentGeometry({ width: 100, height: 100 }, value),
      ).toBeNull();
    },
  );

  it.each([
    { width: 0, height: 100 },
    { width: -1, height: 100 },
    { width: 100, height: NaN },
    { width: Infinity, height: 100 },
    { width: Number.MAX_VALUE, height: Number.MIN_VALUE },
  ])(
    "refuses invalid or unrepresentable decoded dimensions: %j",
    (dimensions) => {
      expect(imageAdjustmentGeometry(dimensions)).toBeNull();
    },
  );
});
