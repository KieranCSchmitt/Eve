import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Crop,
  Image as ImageIcon,
  Maximize2,
  Move,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import {
  imageAdjustmentsEqual,
  normalizedImageAdjustments,
  type CanvasBlock,
  type CanvasImageAdjustments,
} from "@eve/contracts";
import type { TaskAsset } from "../../../shared/bridge";
import { AdjustedImage } from "./AdjustedImage";
import "./CanvasImage.css";

type ImageBlock = Extract<CanvasBlock, { kind: "image" }>;
type CropBounds = CanvasImageAdjustments["crop"];
type Draft = {
  base: string;
  assetUrl: string;
  adjustments: CanvasImageAdjustments;
};
type CropGesture = {
  pointerId: number;
  target: HTMLElement;
  mode: "move" | "resize";
  x: number;
  y: number;
  width: number;
  height: number;
  initial: CropBounds;
};
export interface CanvasImageProps {
  block: ImageBlock;
  assets: TaskAsset[];
  disabled: boolean;
  onChange(block: CanvasBlock): void;
  onAddMaterial?(): void;
  onAttachImage?(blockId: string, assetId?: string): void;
  attachment?: { pending: boolean; message?: string; needsCheck?: boolean };
  onCancelImageAttachment?(blockId: string): void;
  onCheckImageAttachment?(blockId: string): void;
}
const bound = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const rounded = (value: number) => Math.round(value * 10000) / 10000;
const fullCrop: CropBounds = { left: 0, top: 0, right: 1, bottom: 1 };

/** A deliberately empty image area, distinct from a failed attached image. */
export function EmptyCanvasImage({
  children,
  compact = false,
}: {
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="canvas-image-empty" data-empty-image data-compact={compact}>
      <span className="canvas-image-empty-symbol">
        <ImageIcon
          size={compact ? 22 : 30}
          strokeWidth={1.25}
          aria-hidden="true"
        />
      </span>
      {!compact && <strong>A place for your image</strong>}
      <p>No image attached</p>
      {children}
    </div>
  );
}

/** Saved pixels remain in the managed asset; every adjustment is reversible data. */
export function CanvasImage({
  block,
  assets,
  disabled,
  onChange,
  onAddMaterial,
  onAttachImage,
  attachment,
  onCancelImageAttachment,
  onCheckImageAttachment,
}: CanvasImageProps) {
  const empty = block.assetId === null;
  const [choosingImage, setChoosingImage] = useState(false);
  const launchingAttachment = useRef(false);
  const cancelledControl = useRef<HTMLButtonElement | null>(null);
  const importControl = useRef<HTMLButtonElement>(null);
  const checkControl = useRef<HTMLButtonElement>(null);
  const captionControl = useRef<HTMLTextAreaElement>(null);
  const cancelAttachment = (control: HTMLButtonElement) => {
    if (window.document.activeElement === control)
      cancelledControl.current = control;
    onCancelImageAttachment?.(block.id);
  };
  const forgetCancelledControl = (control: HTMLButtonElement) => {
    if (control.isConnected && cancelledControl.current === control)
      cancelledControl.current = null;
  };
  useLayoutEffect(() => {
    const control = cancelledControl.current;
    if (!control || control.isConnected) return;
    cancelledControl.current = null;
    if (!disabled && window.document.activeElement === window.document.body)
      (
        checkControl.current ??
        importControl.current ??
        captionControl.current
      )?.focus({ preventScroll: true });
  });
  const attachmentBlocked =
    disabled || !!attachment?.pending || !!attachment?.needsCheck;
  const imageAssets = assets.filter((candidate) =>
    candidate.mediaType.startsWith("image/"),
  );
  const attach = (assetId?: string) => {
    if (
      !empty ||
      attachmentBlocked ||
      launchingAttachment.current ||
      !onAttachImage
    )
      return;
    if (assetId && !imageAssets.some((asset) => asset.id === assetId)) return;
    launchingAttachment.current = true;
    try {
      onAttachImage(block.id, assetId);
    } finally {
      queueMicrotask(() => {
        launchingAttachment.current = false;
      });
    }
  };
  useLayoutEffect(() => {
    if (!empty) setChoosingImage(false);
  }, [empty]);
  const asset = assets.find(
    (candidate) =>
      candidate.id === block.assetId &&
      candidate.mediaType.startsWith("image/"),
  );
  const awaitingAsset = !empty && !!attachment?.pending && !asset;
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const [dimensions, setDimensions] = useState({ width: 3, height: 2 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState(50);
  const [cropMode, setCropMode] = useState(false);
  const [notice, setNotice] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const adjustButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const gesture = useRef<CropGesture | null>(null);
  const base = JSON.stringify(block);
  const current = useRef({ block, base, asset, disabled, status });
  current.current = { block, base, asset, disabled, status };
  const saved = normalizedImageAdjustments(block.adjustments);
  const preview = draft?.adjustments ?? saved;
  const edited = !imageAdjustmentsEqual(saved, null);
  const changed = !!draft && !imageAdjustmentsEqual(draft.adjustments, saved);
  const originalRatio = dimensions.width / dimensions.height;
  const projectedRatio = cropMode
    ? originalRatio
    : (originalRatio * (preview.crop.right - preview.crop.left)) /
      (preview.crop.bottom - preview.crop.top);
  const ratio =
    Number.isFinite(projectedRatio) && projectedRatio > 0
      ? projectedRatio
      : originalRatio;
  const releaseGesture = () => {
    const active = gesture.current;
    gesture.current = null;
    if (active?.target.hasPointerCapture(active.pointerId))
      active.target.releasePointerCapture(active.pointerId);
  };
  const closeDraft = () => {
    releaseGesture();
    draftRef.current = null;
    setDraft(null);
    setCropMode(false);
  };
  useLayoutEffect(() => {
    const active = draftRef.current;
    if (
      active &&
      (active.base !== base ||
        active.assetUrl !== asset?.url ||
        disabled ||
        status === "unavailable")
    ) {
      closeDraft();
      setComparing(false);
      setNotice(
        disabled
          ? "Editing is unavailable. Your unsaved preview was dismissed."
          : "The photo changed. Your unsaved preview was dismissed.",
      );
    }
  }, [base, asset?.url, disabled, status]);
  useLayoutEffect(() => () => releaseGesture(), []);
  useLayoutEffect(() => {
    if (!draft && returnFocus.current) {
      returnFocus.current = false;
      if (!disabled) adjustButton.current?.focus({ preventScroll: true });
    }
  }, [draft, disabled]);

  const update = (adjustments: CanvasImageAdjustments) => {
    const active = draftRef.current;
    if (
      !active ||
      current.current.disabled ||
      active.base !== current.current.base ||
      active.assetUrl !== current.current.asset?.url
    )
      return;
    const next = { ...active, adjustments };
    draftRef.current = next;
    setDraft(next);
  };
  const updateCrop = (crop: CropBounds) => {
    if (draftRef.current) update({ ...draftRef.current.adjustments, crop });
  };
  const startDraft = () => {
    if (disabled || !asset || status !== "ready") return;
    const next = {
      base,
      assetUrl: asset.url,
      adjustments: normalizedImageAdjustments(block.adjustments),
    };
    draftRef.current = next;
    setDraft(next);
    setComparing(true);
    setComparison(50);
    setNotice("");
  };
  const dismiss = () => {
    returnFocus.current = true;
    closeDraft();
    setComparing(false);
    setNotice("");
  };
  const keep = () => {
    const active = draftRef.current,
      latest = current.current;
    if (
      !active ||
      latest.disabled ||
      latest.status !== "ready" ||
      active.base !== latest.base ||
      active.assetUrl !== latest.asset?.url ||
      imageAdjustmentsEqual(active.adjustments, latest.block.adjustments)
    )
      return;
    const adjustments = imageAdjustmentsEqual(active.adjustments, null)
      ? null
      : active.adjustments;
    returnFocus.current = true;
    closeDraft();
    setComparing(false);
    setNotice("");
    onChange({ ...latest.block, adjustments });
  };
  const comparisonAt = (clientX: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (rect?.width)
      setComparison(
        Math.round(bound(((clientX - rect.left) / rect.width) * 100, 0, 100)),
      );
  };
  const comparisonKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 100
          : event.key === "ArrowLeft" || event.key === "ArrowDown"
            ? comparison - step
            : event.key === "ArrowRight" || event.key === "ArrowUp"
              ? comparison + step
              : null;
    if (next !== null) {
      event.preventDefault();
      setComparison(bound(next, 0, 100));
    }
  };
  const moveCrop = (
    initial: CropBounds,
    mode: "move" | "resize",
    dx: number,
    dy: number,
  ): CropBounds => {
    if (mode === "resize")
      return {
        ...initial,
        right: bound(initial.right + rounded(dx), initial.left + 0.05, 1),
        bottom: bound(initial.bottom + rounded(dy), initial.top + 0.05, 1),
      };
    const x = bound(rounded(dx), -initial.left, 1 - initial.right),
      y = bound(rounded(dy), -initial.top, 1 - initial.bottom);
    return {
      left: bound(initial.left + x, 0, 1),
      top: bound(initial.top + y, 0, 1),
      right: bound(initial.right + x, 0, 1),
      bottom: bound(initial.bottom + y, 0, 1),
    };
  };
  const beginCrop = (
    event: PointerEvent<HTMLButtonElement>,
    mode: "move" | "resize",
  ) => {
    if (event.button !== 0 || gesture.current || !draftRef.current || disabled)
      return;
    const rect = stage.current!.getBoundingClientRect();
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      mode,
      x: event.clientX,
      y: event.clientY,
      width: rect.width,
      height: rect.height,
      initial: draftRef.current.adjustments.crop,
    };
  };
  const dragCrop = (event: PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) {
      cancelCrop();
      return;
    }
    updateCrop(
      moveCrop(
        active.initial,
        active.mode,
        (event.clientX - active.x) / active.width,
        (event.clientY - active.y) / active.height,
      ),
    );
  };
  const cancelCrop = () => {
    const initial = gesture.current?.initial;
    releaseGesture();
    if (initial) updateCrop(initial);
  };
  const cropKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    mode: "move" | "resize",
  ) => {
    if (event.key === "Escape" && gesture.current) {
      event.preventDefault();
      event.stopPropagation();
      cancelCrop();
      return;
    }
    if (!draftRef.current || disabled) return;
    const amount = event.shiftKey ? 0.1 : 0.01;
    const dx =
      event.key === "ArrowLeft"
        ? -amount
        : event.key === "ArrowRight"
          ? amount
          : 0;
    const dy =
      event.key === "ArrowUp"
        ? -amount
        : event.key === "ArrowDown"
          ? amount
          : 0;
    if (dx || dy) {
      event.preventDefault();
      updateCrop(moveCrop(draftRef.current.adjustments.crop, mode, dx, dy));
    }
  };
  const preset = (desiredRatio: number | null) => {
    if (desiredRatio === null) {
      updateCrop(fullCrop);
      return;
    }
    const width = Math.max(0.05, Math.min(1, desiredRatio / originalRatio));
    const height = Math.max(0.05, Math.min(1, originalRatio / desiredRatio));
    updateCrop({
      left: rounded((1 - width) / 2),
      top: rounded((1 - height) / 2),
      right: rounded((1 + width) / 2),
      bottom: rounded((1 + height) / 2),
    });
  };

  return (
    <figure
      className="canvas-image canvas-photo"
      data-canvas-image={block.id}
      data-image-empty={empty}
      data-photo-editing={!!draft}
      style={{
        width: "100%",
        maxWidth: empty ? "100%" : `${Math.max(360, 560 * ratio)}px`,
        marginInline: "auto",
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && draftRef.current && !gesture.current) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      {empty ? (
        <EmptyCanvasImage>
          {onAttachImage && (
            <div className="canvas-image-empty-actions">
              <button
                type="button"
                className="canvas-image-import"
                ref={importControl}
                aria-disabled={attachmentBlocked}
                onClick={() => attach()}
              >
                <Upload size={15} aria-hidden="true" />
                Import image
              </button>
              {imageAssets.length > 0 && (
                <button
                  type="button"
                  aria-expanded={choosingImage}
                  aria-disabled={attachmentBlocked}
                  onClick={() => {
                    if (!attachmentBlocked) setChoosingImage(!choosingImage);
                  }}
                >
                  Choose existing image
                </button>
              )}
            </div>
          )}
          {onAttachImage && choosingImage && (
            <div
              className="canvas-image-existing"
              role="group"
              aria-label="Existing images"
            >
              {imageAssets.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  aria-label={`Attach ${image.title}`}
                  aria-disabled={attachmentBlocked}
                  onClick={() => attach(image.id)}
                >
                  <AdjustedImage asset={image} alt="" maxHeight={74} />
                  <span>{image.title}</span>
                </button>
              ))}
            </div>
          )}
          <div className="canvas-image-attachment-status" role="status">
            {attachment?.message ||
              (attachment?.pending ? "Attaching your image…" : "")}
          </div>
          {attachment?.pending && onCancelImageAttachment && (
            <button
              type="button"
              onClick={(event) => cancelAttachment(event.currentTarget)}
              onBlur={(event) => forgetCancelledControl(event.currentTarget)}
            >
              Cancel image attachment
            </button>
          )}
          {attachment?.needsCheck && onCheckImageAttachment && (
            <button
              ref={checkControl}
              type="button"
              aria-disabled={!!attachment.pending}
              onClick={() => {
                if (!attachment.pending) onCheckImageAttachment(block.id);
              }}
            >
              Check attachment
            </button>
          )}
        </EmptyCanvasImage>
      ) : (
        <>
          <div className="canvas-photo-heading">
            <span className="canvas-photo-protection">
              <ImageIcon size={13} aria-hidden="true" />
              Original preserved{edited ? " · Adjusted view" : ""}
            </span>
            <div>
              {edited && !draft && (
                <button
                  type="button"
                  aria-pressed={comparing}
                  onClick={() => {
                    setComparing(!comparing);
                    setComparison(50);
                  }}
                >
                  Compare original
                </button>
              )}
              <button
                ref={adjustButton}
                type="button"
                className="canvas-photo-adjust"
                disabled={
                  disabled || awaitingAsset || status !== "ready" || !!draft
                }
                onClick={startDraft}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                Adjust photo
              </button>
            </div>
          </div>
          <div
            className="canvas-photo-mat"
            style={{ maxWidth: `${560 * ratio}px`, marginInline: "auto" }}
          >
            <div
              className="canvas-photo-stage"
              ref={stage}
              style={{ aspectRatio: ratio, maxWidth: `${560 * ratio}px` }}
              data-photo-stage
            >
              {awaitingAsset ? (
                <div className="canvas-image-loading" role="status">
                  <ImageIcon size={24} strokeWidth={1.25} aria-hidden="true" />
                  <span>Loading your image…</span>
                </div>
              ) : (
                <AdjustedImage
                  asset={asset}
                  adjustments={preview}
                  variant={cropMode ? "original" : "adjusted"}
                  framing={cropMode ? "original" : "adjusted"}
                  alt={block.caption || asset?.title || "Unavailable image"}
                  onLoad={setDimensions}
                  onStatusChange={setStatus}
                />
              )}
              {status === "ready" && comparing && !cropMode && (
                <>
                  <div
                    className="canvas-photo-original"
                    style={{ clipPath: `inset(0 ${100 - comparison}% 0 0)` }}
                    aria-hidden="true"
                  >
                    <AdjustedImage
                      asset={asset}
                      adjustments={preview}
                      variant="original"
                      framing="adjusted"
                      alt=""
                    />
                  </div>
                  <span className="canvas-photo-badge original">Original</span>
                  <span className="canvas-photo-badge preview">
                    {draft ? "Preview" : "Saved view"}
                  </span>
                  <div
                    className="canvas-photo-comparison"
                    role="slider"
                    tabIndex={0}
                    aria-label="Original and preview comparison"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={comparison}
                    aria-valuetext={`${comparison}% original, ${100 - comparison}% ${draft ? "preview" : "saved view"}`}
                    onKeyDown={comparisonKey}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.focus({ preventScroll: true });
                      event.currentTarget.setPointerCapture(event.pointerId);
                      comparisonAt(event.clientX);
                    }}
                    onPointerMove={(event) => {
                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      )
                        comparisonAt(event.clientX);
                    }}
                    onPointerUp={(event) => {
                      if (
                        event.currentTarget.hasPointerCapture(event.pointerId)
                      )
                        event.currentTarget.releasePointerCapture(
                          event.pointerId,
                        );
                    }}
                  >
                    <span
                      className="canvas-photo-comparison-line"
                      style={{ left: `${comparison}%` }}
                    >
                      <span>
                        <ChevronLeft size={15} />
                        <ChevronRight size={15} />
                      </span>
                    </span>
                  </div>
                </>
              )}
              {draft && cropMode && status === "ready" && (
                <>
                  <span className="canvas-photo-badge original">
                    Crop original
                  </span>
                  <div
                    className="canvas-photo-crop-box"
                    data-photo-crop
                    style={{
                      left: `${preview.crop.left * 100}%`,
                      top: `${preview.crop.top * 100}%`,
                      width: `${(preview.crop.right - preview.crop.left) * 100}%`,
                      height: `${(preview.crop.bottom - preview.crop.top) * 100}%`,
                    }}
                  >
                    <button
                      type="button"
                      className="canvas-photo-crop-move"
                      aria-label="Move crop area"
                      onPointerDown={(event) => beginCrop(event, "move")}
                      onPointerMove={dragCrop}
                      onPointerUp={releaseGesture}
                      onPointerCancel={cancelCrop}
                      onLostPointerCapture={(event) => {
                        if (gesture.current?.pointerId === event.pointerId)
                          cancelCrop();
                      }}
                      onKeyDown={(event) => cropKey(event, "move")}
                    >
                      <Move size={20} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="canvas-photo-crop-resize"
                      aria-label="Resize crop area"
                      onPointerDown={(event) => beginCrop(event, "resize")}
                      onPointerMove={dragCrop}
                      onPointerUp={releaseGesture}
                      onPointerCancel={cancelCrop}
                      onLostPointerCapture={(event) => {
                        if (gesture.current?.pointerId === event.pointerId)
                          cancelCrop();
                      }}
                      onKeyDown={(event) => cropKey(event, "resize")}
                    >
                      <Maximize2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
      {!empty &&
        !awaitingAsset &&
        status === "unavailable" &&
        onAddMaterial && (
          <button
            type="button"
            className="canvas-secondary-button"
            disabled={disabled}
            onClick={onAddMaterial}
          >
            <Plus size={14} />
            Add material
          </button>
        )}
      {!empty &&
        (attachment?.pending ||
          attachment?.needsCheck ||
          attachment?.message) && (
          <div className="canvas-image-attachment-receipt">
            {!awaitingAsset && (
              <p className="canvas-image-attachment-status" role="status">
                {attachment.message ||
                  (attachment.pending ? "Attaching your image…" : "")}
              </p>
            )}
            {attachment.pending && onCancelImageAttachment && (
              <button
                type="button"
                onClick={(event) => cancelAttachment(event.currentTarget)}
                onBlur={(event) => forgetCancelledControl(event.currentTarget)}
              >
                Cancel image attachment
              </button>
            )}
            {attachment.needsCheck && onCheckImageAttachment && (
              <button
                ref={checkControl}
                type="button"
                aria-disabled={!!attachment.pending}
                onClick={() => {
                  if (!attachment.pending) onCheckImageAttachment(block.id);
                }}
              >
                Check attachment
              </button>
            )}
          </div>
        )}
      {!empty && draft && (
        <div
          className="canvas-photo-controls"
          role="group"
          aria-label="Photo adjustments"
        >
          <div className="canvas-photo-sliders">
            {(
              [
                ["brightness", "Brightness", 0.25, 2, 0.01],
                ["contrast", "Contrast", 0.25, 2, 0.01],
                ["saturation", "Saturation", 0, 2, 0.01],
                ["straighten", "Straighten", -15, 15, 0.1],
              ] as const
            ).map(([field, label, min, max, step]) => (
              <label key={field}>
                <span>
                  {label}
                  <output>
                    {field === "straighten"
                      ? `${preview[field].toFixed(1)}°`
                      : `${Math.round(preview[field] * 100)}%`}
                  </output>
                </span>
                <input
                  type="range"
                  aria-label={label}
                  min={min}
                  max={max}
                  step={step}
                  value={preview[field]}
                  onChange={(event) =>
                    update({ ...preview, [field]: Number(event.target.value) })
                  }
                />
              </label>
            ))}
          </div>
          <div className="canvas-photo-crop-toolbar">
            <button
              type="button"
              aria-pressed={cropMode}
              onClick={() => {
                releaseGesture();
                setCropMode(!cropMode);
              }}
            >
              <Crop size={14} aria-hidden="true" />
              {cropMode ? "Preview crop" : "Crop"}
            </button>
            <button
              type="button"
              onClick={() => {
                releaseGesture();
                update(normalizedImageAdjustments(null));
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              Reset adjustments
            </button>
          </div>
          {cropMode && (
            <div className="canvas-photo-crop-settings">
              <div
                className="canvas-photo-crop-presets"
                role="group"
                aria-label="Crop presets"
              >
                {(
                  [
                    ["Full image", null],
                    ["Square", 1],
                    ["Portrait", 4 / 5],
                    ["Wide", 16 / 9],
                  ] as const
                ).map(([label, value]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => preset(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p>
                Drag the crop or its corner. Arrow keys move 1%; Shift moves
                10%.
              </p>
              <div className="canvas-photo-crop-fields">
                {(["left", "top", "right", "bottom"] as const).map((edge) => (
                  <label key={edge}>
                    <span>{edge[0].toUpperCase() + edge.slice(1)} %</span>
                    <input
                      type="number"
                      aria-label={`Crop ${edge} percent`}
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(preview.crop[edge] * 10000) / 100}
                      onChange={(event) => {
                        if (
                          !event.target.value ||
                          !Number.isFinite(event.target.valueAsNumber)
                        )
                          return;
                        const value = event.target.valueAsNumber / 100;
                        const crop = preview.crop;
                        const min =
                          edge === "right"
                            ? crop.left + 0.05
                            : edge === "bottom"
                              ? crop.top + 0.05
                              : 0;
                        const max =
                          edge === "left"
                            ? crop.right - 0.05
                            : edge === "top"
                              ? crop.bottom - 0.05
                              : 1;
                        updateCrop({
                          ...crop,
                          [edge]: bound(rounded(value), min, max),
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="canvas-photo-decision">
            <span>
              <SlidersHorizontal size={17} aria-hidden="true" />
              <span>
                <strong>
                  {changed ? "Your photo, adjusted" : "Adjust your photo"}
                </strong>
                <small>Preview only · Original preserved</small>
              </span>
            </span>
            <div>
              <button
                type="button"
                className="canvas-photo-keep"
                aria-label="Keep photo adjustments"
                disabled={!changed || status !== "ready"}
                onClick={keep}
              >
                <Check size={14} aria-hidden="true" />
                Keep
              </button>
              <button
                type="button"
                aria-label="Dismiss photo adjustments"
                onClick={dismiss}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {notice && (
        <p className="canvas-photo-notice" role="status">
          {notice}
        </p>
      )}
      <figcaption key="caption">
        <textarea
          ref={captionControl}
          aria-label={block.title ? `${block.title} caption` : "Image caption"}
          value={block.caption}
          placeholder={asset?.title || "Add a caption…"}
          rows={1}
          maxLength={1000}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...block, caption: event.target.value })
          }
        />
      </figcaption>
    </figure>
  );
}
