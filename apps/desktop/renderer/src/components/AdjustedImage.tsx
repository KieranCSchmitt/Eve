import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { CanvasImageAdjustments } from "@eve/contracts";
import type { TaskAsset } from "../../../shared/bridge";
import {
  imageAdjustmentGeometry,
  validatedImageAdjustments,
  type ImageAdjustmentFraming,
  type ImageAdjustmentVariant,
  type ImageDimensions,
} from "./imageAdjustmentGeometry";
import "./AdjustedImage.css";

export type AdjustedImageStatus = "loading" | "ready" | "unavailable";
export interface AdjustedImageProps {
  /** Resolved from the host-admitted task asset list, never from model data. */
  asset?: TaskAsset;
  adjustments?: CanvasImageAdjustments | null;
  variant?: ImageAdjustmentVariant;
  framing?: ImageAdjustmentFraming;
  alt: string;
  className?: string;
  style?: CSSProperties;
  /** Constrains the whole frame while preserving its aspect ratio. */
  maxHeight?: number;
  onLoad?(dimensions: ImageDimensions): void;
  onStatusChange?(status: AdjustedImageStatus): void;
}

type DecodedImage =
  | { url: string; status: "ready"; dimensions: ImageDimensions }
  | { url: string; status: "unavailable" };

/** Read-only projection of managed original bytes and registered adjustments. */
export function AdjustedImage({
  asset,
  adjustments,
  variant = "adjusted",
  framing = "adjusted",
  alt,
  className,
  style,
  maxHeight,
  onLoad,
  onStatusChange,
}: AdjustedImageProps) {
  const sourceUrl = asset?.mediaType.startsWith("image/")
    ? asset.url
    : undefined;
  const currentUrl = useRef(sourceUrl);
  currentUrl.current = sourceUrl;
  const callbacks = useRef({ onLoad, onStatusChange });
  callbacks.current = { onLoad, onStatusChange };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);
  const current = decoded?.url === sourceUrl ? decoded : null;
  const dimensions = current?.status === "ready" ? current.dimensions : null;
  const validSettings = validatedImageAdjustments(adjustments);
  const geometry = dimensions
    ? imageAdjustmentGeometry(dimensions, adjustments, variant, framing)
    : null;
  const status: AdjustedImageStatus =
    !sourceUrl || !validSettings || current?.status === "unavailable"
      ? "unavailable"
      : current?.status === "ready"
        ? geometry
          ? "ready"
          : "unavailable"
        : "loading";
  useEffect(() => {
    callbacks.current.onStatusChange?.(status);
  }, [status, sourceUrl]);

  const percent = (number: number | undefined, fallback: number) =>
    `${number ?? fallback}%`;
  const frameAspectRatio = geometry?.frameAspectRatio ?? 4 / 3;
  const maximumWidth =
    maxHeight !== undefined && Number.isFinite(maxHeight) && maxHeight > 0
      ? maxHeight * frameAspectRatio
      : undefined;
  return (
    <div
      className={["adjusted-image", className].filter(Boolean).join(" ")}
      data-adjusted-image=""
      data-status={status}
      data-variant={variant}
      data-framing={framing}
      style={{
        aspectRatio: frameAspectRatio,
        maxWidth: maximumWidth,
        marginInline: maximumWidth === undefined ? undefined : "auto",
        ...style,
      }}
    >
      {status !== "unavailable" && sourceUrl && (
        <div
          className="adjusted-image-viewport"
          style={{
            width: percent(geometry?.viewportWidthPercent, 100),
            height: percent(geometry?.viewportHeightPercent, 100),
            left: percent(geometry?.viewportLeftPercent, 0),
            top: percent(geometry?.viewportTopPercent, 0),
            visibility: status === "ready" ? "visible" : "hidden",
          }}
        >
          <div
            className="adjusted-image-transform"
            style={{
              transform: `rotate(${geometry?.straighten ?? 0}deg) scale(${geometry?.coverScale ?? 1})`,
            }}
          >
            <img
              className="adjusted-image-source"
              src={sourceUrl}
              alt={alt}
              draggable={false}
              style={{
                width: percent(geometry?.sourceWidthPercent, 100),
                height: percent(geometry?.sourceHeightPercent, 100),
                left: percent(geometry?.sourceLeftPercent, 0),
                top: percent(geometry?.sourceTopPercent, 0),
                maxWidth: "none",
                maxHeight: "none",
                borderRadius: 0,
                objectFit: "fill",
                filter: geometry?.filter ?? "none",
              }}
              onLoad={(event) => {
                const element = event.currentTarget;
                const url = sourceUrl;
                void element.decode().then(
                  () => {
                    if (!mounted.current || currentUrl.current !== url) return;
                    const loaded = {
                      width: element.naturalWidth,
                      height: element.naturalHeight,
                    };
                    if (loaded.width <= 0 || loaded.height <= 0) {
                      setDecoded({ url, status: "unavailable" });
                      return;
                    }
                    setDecoded({ url, status: "ready", dimensions: loaded });
                    callbacks.current.onLoad?.(loaded);
                  },
                  () => {
                    if (mounted.current && currentUrl.current === url)
                      setDecoded({ url, status: "unavailable" });
                  },
                );
              }}
              onError={() => {
                if (currentUrl.current === sourceUrl)
                  setDecoded({ url: sourceUrl, status: "unavailable" });
              }}
            />
          </div>
        </div>
      )}
      {status !== "ready" && (
        <div className="adjusted-image-placeholder" role="status">
          <ImageIcon size={24} aria-hidden="true" />
          <span>
            {status === "loading" ? "Loading image…" : "Image unavailable"}
          </span>
        </div>
      )}
    </div>
  );
}
