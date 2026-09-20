import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Grip,
  Image as ImageIcon,
  Layers,
  Maximize2,
  Minus,
  Move,
  Plus,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { CanvasBlock, CanvasDesignLayer } from "@eve/contracts";
import type { TaskAsset } from "../../../shared/bridge";
import "./DesignSurface.css";

type Design = Extract<CanvasBlock, { kind: "design" }>;
type Geometry = Pick<CanvasDesignLayer, "x" | "y" | "width" | "height">;
type Props = {
  block: Design;
  assets: TaskAsset[];
  disabled: boolean;
  onChange(block: CanvasBlock): void;
  onAddMaterial?(): void;
};
type Gesture = {
  id: string;
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  scale: number;
  viewScale: number;
  scrollLeft: number;
  scrollTop: number;
  lastX: number;
  lastY: number;
  initial: CanvasDesignLayer;
  geometry: Geometry;
  block: Design;
  target: HTMLElement;
};
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));
const geometryOf = ({ x, y, width, height }: CanvasDesignLayer): Geometry => ({
  x,
  y,
  width,
  height,
});
const geometryEqual = (a: Geometry, b: Geometry) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const layerName = (layer: CanvasDesignLayer) => layer.name;
const LayerIcon = ({
  kind,
  size = 14,
}: {
  kind: CanvasDesignLayer["kind"];
  size?: number;
}) =>
  kind === "text" ? (
    <Type size={size} aria-hidden="true" />
  ) : kind === "image" ? (
    <ImageIcon size={size} aria-hidden="true" />
  ) : (
    <Square size={size} aria-hidden="true" />
  );

function LayerImage({
  asset,
  fit,
}: {
  asset?: TaskAsset;
  fit: "cover" | "contain";
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return asset && failedUrl !== asset.url ? (
    <img
      className="design-image"
      src={asset.url}
      alt=""
      draggable={false}
      style={{ objectFit: fit }}
      onError={() => setFailedUrl(asset.url)}
    />
  ) : (
    <div className="design-missing-image">
      <ImageIcon size={28} aria-hidden="true" />
      <span>Image unavailable</span>
    </div>
  );
}

/** Valid numeric edits save immediately; intermediate typing never emits invalid geometry. */
function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const dirty = useRef(false);
  const hintId = useId();
  const parsed = draft.trim() ? Number(draft) : NaN;
  const invalid =
    dirty.current &&
    (!Number.isInteger(parsed) || parsed < min || parsed > max);
  useEffect(() => {
    if (!focused.current || !dirty.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    if (disabled || !dirty.current) {
      setDraft(String(value));
      dirty.current = false;
      return;
    }
    const parsed = draft.trim() ? Number(draft) : NaN;
    const next = Number.isFinite(parsed) ? clamp(parsed, min, max) : value;
    dirty.current = false;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="design-field">
      {label}
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? hintId : undefined}
        type="number"
        inputMode="numeric"
        value={draft}
        min={min}
        max={max}
        step={1}
        readOnly={disabled}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(event) => {
          if (disabled) return;
          const input = event.target.value;
          dirty.current = true;
          setDraft(input);
          const next = input.trim() ? Number(input) : NaN;
          if (
            Number.isInteger(next) &&
            next >= min &&
            next <= max &&
            next !== value
          )
            onCommit(next);
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            dirty.current = false;
            setDraft(String(value));
            event.stopPropagation();
          }
        }}
      />
      {invalid && (
        <small className="design-field-error" id={hintId}>
          Enter a whole number from {min} to {max}. Keeping {value} until this
          is valid.
        </small>
      )}
    </label>
  );
}

function ColorField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <label className="design-field">
      {label}
      <span className="design-color-field">
        <input
          type="color"
          aria-label={label}
          value={value}
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (disabled && (event.key === " " || event.key === "Enter"))
              event.preventDefault();
          }}
          onChange={(event) => {
            if (!disabled) onChange(event.target.value);
          }}
        />
        <span aria-hidden="true">{value.toUpperCase()}</span>
      </span>
    </label>
  );
}

/** A bounded, declarative artboard. Native editors stay mounted as layers move and stack. */
export function DesignSurface({
  block,
  assets,
  disabled,
  onChange,
  onAddMaterial,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorId = useId();
  const layersButton = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [zoom, setZoom] = useState<number | null>(null);
  const [viewRevision, setViewRevision] = useState(0);
  const [preview, setPreview] = useState<{
    id: string;
    geometry: Geometry;
  } | null>(null);
  const [clippedText, setClippedText] = useState<Set<string>>(new Set());
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pendingView = useRef<{ x: number; y: number } | null>(null);
  const addTextButton = useRef<HTMLButtonElement>(null);
  const addImageButton = useRef<HTMLButtonElement>(null);
  const stageLayers = useRef(new Map<string, HTMLDivElement>());
  const listButtons = useRef(new Map<string, HTMLButtonElement>());
  const editors = useRef(new Map<string, HTMLTextAreaElement>());
  const textPreviews = useRef(new Map<string, HTMLDivElement>());
  const mountOrder = useRef(new Map<string, number>());
  const nextMount = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const pendingFocus = useRef<{
    id: string;
    target: "text" | "stage" | "list";
  } | null>(null);
  const latest = useRef({ block, disabled, onChange });
  latest.current = { block, disabled, onChange };
  for (const layer of block.layers)
    if (!mountOrder.current.has(layer.id))
      mountOrder.current.set(layer.id, nextMount.current++);
  const mountedLayers = [...block.layers].sort(
    (a, b) => mountOrder.current.get(a.id)! - mountOrder.current.get(b.id)!,
  );
  const selected = block.layers.find((layer) => layer.id === selectedId);
  const viewportHeight = availableWidth < 460 ? 480 : 640;
  const fitScale = Math.max(
    0.01,
    Math.min(1, availableWidth / block.width, viewportHeight / block.height),
  );
  const scale = zoom ?? fitScale;
  const zoomSteps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
  const images = assets.filter((asset) => asset.mediaType.startsWith("image/"));
  const full = block.layers.length >= 24;

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setAvailableWidth(Math.max(1, element.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const cancelGesture = () => {
    const current = gesture.current;
    gesture.current = null;
    setPreview(null);
    if (current?.target.hasPointerCapture(current.pointerId))
      current.target.releasePointerCapture(current.pointerId);
  };
  useLayoutEffect(() => {
    const current = gesture.current;
    if (
      current &&
      (disabled || current.block !== block || current.viewScale !== scale)
    )
      cancelGesture();
  }, [block, disabled, scale]);
  useLayoutEffect(() => {
    const point = pendingView.current;
    const viewport = host.current;
    const artboard = stage.current;
    if (!point || !viewport || !artboard) return;
    pendingView.current = null;
    if (zoom === null) {
      viewport.scrollTo({ left: 0, top: 0, behavior: "instant" });
      return;
    }
    const frame = viewport.getBoundingClientRect();
    const board = artboard.getBoundingClientRect();
    const actualScale = board.width / block.width;
    const originX =
      board.left - frame.left - viewport.clientLeft + viewport.scrollLeft;
    const originY =
      board.top - frame.top - viewport.clientTop + viewport.scrollTop;
    viewport.scrollTo({
      left: originX + point.x * actualScale - viewport.clientWidth / 2,
      top: originY + point.y * actualScale - viewport.clientHeight / 2,
      behavior: "instant",
    });
  }, [viewRevision, scale, zoom, block.width]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        cancelGesture();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (!request || !block.layers.some((layer) => layer.id === request.id))
      return;
    const element =
      request.target === "text"
        ? editors.current.get(request.id)
        : request.target === "list"
          ? listButtons.current.get(request.id)
          : stageLayers.current.get(request.id);
    if (element) {
      pendingFocus.current = null;
      element.focus({ preventScroll: true });
    }
  }, [block, selectedId, inspectorOpen]);
  useEffect(() => {
    let active = true;
    const measure = () => {
      if (!active) return;
      const clipped = new Set<string>();
      for (const layer of block.layers) {
        const element = textPreviews.current.get(layer.id);
        if (
          layer.kind === "text" &&
          layer.text &&
          element &&
          (element.scrollHeight > element.clientHeight + 1 ||
            element.scrollWidth > element.clientWidth + 1)
        )
          clipped.add(layer.id);
      }
      setClippedText((previous) =>
        previous.size === clipped.size &&
        [...previous].every((id) => clipped.has(id))
          ? previous
          : clipped,
      );
    };
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
    };
  }, [block, preview]);

  const change = (transform: (current: Design) => Design) => {
    if (latest.current.disabled) return;
    latest.current.onChange(transform(latest.current.block));
  };
  const changeZoom = (next: number | null) => {
    // View controls are available in read-only mode; they never change the document.
    cancelGesture();
    const viewport = host.current;
    const board = stage.current?.getBoundingClientRect();
    const frame = viewport?.getBoundingClientRect();
    const actualScale = board ? board.width / block.width : scale;
    pendingView.current = selected
      ? {
          x: selected.x + selected.width / 2,
          y: selected.y + selected.height / 2,
        }
      : viewport && board && frame
        ? {
            x: Math.max(
              0,
              Math.min(
                block.width,
                (frame.left +
                  viewport.clientLeft +
                  viewport.clientWidth / 2 -
                  board.left) /
                  actualScale,
              ),
            ),
            y: Math.max(
              0,
              Math.min(
                block.height,
                (frame.top +
                  viewport.clientTop +
                  viewport.clientHeight / 2 -
                  board.top) /
                  actualScale,
              ),
            ),
          }
        : { x: block.width / 2, y: block.height / 2 };
    setZoom(next);
    setViewRevision((revision) => revision + 1);
  };
  const updateLayer = (
    id: string,
    transform: (layer: CanvasDesignLayer) => CanvasDesignLayer,
  ) =>
    change((current) => ({
      ...current,
      layers: current.layers.map((layer) =>
        layer.id === id ? transform(layer) : layer,
      ),
    }));
  const editText = (id: string) => {
    setSelectedId(id);
    setInspectorOpen(true);
    pendingFocus.current = { id, target: "text" };
    // Existing panels are made visible by this selection before focus is applied.
    if (selectedId === id && inspectorOpen) {
      pendingFocus.current = null;
      editors.current.get(id)?.focus({ preventScroll: true });
    }
  };
  const addLayer = (kind: CanvasDesignLayer["kind"], asset?: TaskAsset) => {
    const current = latest.current.block;
    if (
      latest.current.disabled ||
      current.layers.length >= 24 ||
      (kind === "image" && !asset)
    )
      return;
    const count =
      current.layers.filter((layer) => layer.kind === kind).length + 1;
    const width = Math.round(current.width * (kind === "shape" ? 0.4 : 0.72));
    const height = Math.round(
      current.height *
        (kind === "text" ? 0.28 : kind === "shape" ? 0.32 : 0.68),
    );
    const base = {
      id: crypto.randomUUID(),
      name: `${kind === "text" ? "Text" : kind === "shape" ? "Shape" : "Image"} ${count}`,
      x: Math.round((current.width - width) / 2),
      y: Math.round((current.height - height) / 2),
      width,
      height,
    };
    const layer: CanvasDesignLayer =
      kind === "text"
        ? {
            ...base,
            kind,
            text: "",
            fontFamily: "serif",
            fontSize: clamp(
              Math.min(current.width, current.height) * 0.085,
              8,
              96,
            ),
            fontWeight: "medium",
            color: "#20283f",
            align: "left",
          }
        : kind === "shape"
          ? { ...base, kind, shape: "rectangle", fill: "#dbe5fb" }
          : {
              ...base,
              name: asset!.title.slice(0, 80) || base.name,
              kind,
              assetId: asset!.id,
              fit: "contain",
            };
    pendingFocus.current = {
      id: layer.id,
      target: kind === "text" ? "text" : "stage",
    };
    setSelectedId(layer.id);
    setInspectorOpen(true);
    setPickerOpen(false);
    change((document) => ({
      ...document,
      layers: [...document.layers, layer],
    }));
  };
  const removeLayer = (id: string) => {
    if (latest.current.disabled) return;
    const current = latest.current.block;
    const index = current.layers.findIndex((layer) => layer.id === id);
    const remaining = current.layers.filter((layer) => layer.id !== id);
    const next = remaining[Math.min(index, remaining.length - 1)];
    setSelectedId(next?.id ?? null);
    if (next) pendingFocus.current = { id: next.id, target: "list" };
    change((document) => ({
      ...document,
      layers: document.layers.filter((layer) => layer.id !== id),
    }));
    if (!next) addTextButton.current?.focus({ preventScroll: true });
  };
  const reorder = (id: string, delta: number) =>
    change((current) => {
      const index = current.layers.findIndex((layer) => layer.id === id);
      const destination = index + delta;
      if (index < 0 || destination < 0 || destination >= current.layers.length)
        return current;
      const layers = [...current.layers];
      [layers[index], layers[destination]] = [
        layers[destination]!,
        layers[index]!,
      ];
      return { ...current, layers };
    });
  const resizeBoard = (axis: "width" | "height", value: number) =>
    change((current) => {
      const next = { ...current, [axis]: value };
      return {
        ...next,
        layers: current.layers.map((layer) => ({
          ...layer,
          width: Math.min(layer.width, next.width),
          height: Math.min(layer.height, next.height),
          x: Math.min(layer.x, Math.max(0, next.width - layer.width)),
          y: Math.min(layer.y, Math.max(0, next.height - layer.height)),
        })),
      };
    });
  const startGesture = (
    event: PointerEvent<HTMLElement>,
    layer: CanvasDesignLayer,
    mode: "move" | "resize",
  ) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cancelGesture();
    setSelectedId(layer.id);
    setInspectorOpen(true);
    stageLayers.current.get(layer.id)?.focus({ preventScroll: true });
    const initial = geometryOf(layer);
    const actualScale =
      (stage.current?.getBoundingClientRect().width ?? block.width * scale) /
      block.width;
    gesture.current = {
      id: layer.id,
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scale: actualScale,
      viewScale: scale,
      scrollLeft: host.current?.scrollLeft ?? 0,
      scrollTop: host.current?.scrollTop ?? 0,
      lastX: event.clientX,
      lastY: event.clientY,
      initial: layer,
      geometry: initial,
      block,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview({ id: layer.id, geometry: initial });
  };
  const updateGesturePreview = (current: Gesture) => {
    if (latest.current.disabled || latest.current.block !== current.block) {
      cancelGesture();
      return;
    }
    const dx =
      (current.lastX -
        current.startX +
        (host.current?.scrollLeft ?? 0) -
        current.scrollLeft) /
      current.scale;
    const dy =
      (current.lastY -
        current.startY +
        (host.current?.scrollTop ?? 0) -
        current.scrollTop) /
      current.scale;
    const initial = current.initial;
    const geometry: Geometry =
      current.mode === "move"
        ? {
            ...geometryOf(initial),
            x: clamp(initial.x + dx, 0, current.block.width - initial.width),
            y: clamp(initial.y + dy, 0, current.block.height - initial.height),
          }
        : {
            ...geometryOf(initial),
            width: clamp(
              initial.width + dx,
              1,
              current.block.width - initial.x,
            ),
            height: clamp(
              initial.height + dy,
              1,
              current.block.height - initial.y,
            ),
          };
    current.geometry = geometry;
    setPreview({ id: current.id, geometry });
  };
  const moveGesture = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.lastX = event.clientX;
    current.lastY = event.clientY;
    updateGesturePreview(current);
  };
  const finishGesture = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const valid =
      !latest.current.disabled && latest.current.block === current.block;
    cancelGesture();
    if (valid && !geometryEqual(current.initial, current.geometry))
      updateLayer(current.id, (layer) => ({ ...layer, ...current.geometry }));
  };
  const layerKey = (
    event: KeyboardEvent<HTMLElement>,
    layer: CanvasDesignLayer,
    mode: "move" | "resize" = "move",
  ) => {
    if (event.target !== event.currentTarget || disabled) return;
    const step = event.shiftKey ? 10 : 1;
    const dx =
      event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy =
      event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    if (dx || dy) {
      event.preventDefault();
      event.stopPropagation();
      updateLayer(layer.id, (current) =>
        mode === "move"
          ? {
              ...current,
              x: clamp(
                current.x + dx,
                0,
                latest.current.block.width - current.width,
              ),
              y: clamp(
                current.y + dy,
                0,
                latest.current.block.height - current.height,
              ),
            }
          : {
              ...current,
              width: clamp(
                current.width + dx,
                1,
                latest.current.block.width - current.x,
              ),
              height: clamp(
                current.height + dy,
                1,
                latest.current.block.height - current.y,
              ),
            },
      );
    } else if (
      event.key === "Enter" &&
      layer.kind === "text" &&
      mode === "move"
    ) {
      event.preventDefault();
      editText(layer.id);
    }
  };
  const pointerEvents = {
    onPointerMove: moveGesture,
    onPointerUp: finishGesture,
    onPointerCancel: cancelGesture,
    onLostPointerCapture: () => {
      if (gesture.current) cancelGesture();
    },
  };

  return (
    <div className="design-surface" data-disabled={disabled}>
      <div className="design-toolbar" role="group" aria-label="Design tools">
        <div className="design-add-tools">
          <button
            ref={addTextButton}
            type="button"
            aria-disabled={disabled || full}
            onClick={() => addLayer("text")}
          >
            <Type size={15} aria-hidden="true" /> Add text
          </button>
          <button
            type="button"
            aria-disabled={disabled || full}
            onClick={() => addLayer("shape")}
          >
            <Square size={14} aria-hidden="true" /> Add shape
          </button>
          <button
            ref={addImageButton}
            type="button"
            aria-disabled={disabled || full}
            aria-expanded={pickerOpen}
            onClick={() => {
              if (!disabled && !full) setPickerOpen((open) => !open);
            }}
          >
            <ImageIcon size={15} aria-hidden="true" /> Add image
          </button>
        </div>
        <span className="design-layer-count">
          {block.layers.length} / 24 layers
        </span>
      </div>
      {pickerOpen && (
        <section
          className="design-image-picker"
          aria-label="Choose a design image"
        >
          <div className="design-picker-heading">
            <span>Choose an image</span>
            <button
              type="button"
              aria-label="Close image chooser"
              onClick={() => {
                setPickerOpen(false);
                addImageButton.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>
          {images.length ? (
            <div className="design-image-options">
              {images.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  aria-label={`Use ${asset.title}`}
                  aria-disabled={disabled || full}
                  onClick={() => addLayer("image", asset)}
                >
                  <img src={asset.url} alt="" />
                  <span>{asset.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <p>
              Add an image from your materials to place it on this artboard.
            </p>
          )}
          {onAddMaterial && (
            <button
              className="design-import-image"
              type="button"
              aria-disabled={disabled}
              onClick={() => {
                if (!disabled) onAddMaterial();
              }}
            >
              <Plus size={14} aria-hidden="true" /> Import image
            </button>
          )}
          <small>Your original images are preserved.</small>
        </section>
      )}
      <div className="design-workspace">
        <div className="design-stage-column">
          <div
            className="design-view-tools"
            role="group"
            aria-label="Artboard view"
          >
            <div className="design-view-presets">
              <button
                type="button"
                aria-label="Fit artboard"
                aria-pressed={zoom === null}
                onClick={() => changeZoom(null)}
              >
                Fit
              </button>
              <button
                type="button"
                aria-label="View at 100%"
                aria-pressed={zoom === 1}
                onClick={() => changeZoom(1)}
              >
                100%
              </button>
            </div>
            <button
              ref={layersButton}
              type="button"
              className="design-layers-toggle"
              aria-label="Layers"
              aria-expanded={inspectorOpen}
              aria-controls={inspectorId}
              title="Layers and properties"
              onClick={() => {
                if (inspectorOpen) pendingFocus.current = null;
                setInspectorOpen((open) => !open);
              }}
            >
              <Layers size={13} aria-hidden="true" /> Layers
              <span aria-hidden="true">{block.layers.length}</span>
            </button>
            <div className="design-view-zoom">
              <button
                type="button"
                aria-label="Zoom out"
                aria-disabled={scale <= zoomSteps[0]!}
                onClick={() => {
                  const next = [...zoomSteps]
                    .reverse()
                    .find((step) => step < scale - 0.001);
                  if (next !== undefined) changeZoom(next);
                }}
              >
                <Minus size={13} aria-hidden="true" />
              </button>
              <span
                aria-label={`Artboard zoom ${Math.round(scale * 100)}%`}
                data-design-zoom
              >
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                aria-disabled={scale >= zoomSteps[zoomSteps.length - 1]!}
                onClick={() => {
                  const next = zoomSteps.find((step) => step > scale + 0.001);
                  if (next !== undefined) changeZoom(next);
                }}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div
            className="design-stage-host"
            ref={host}
            data-design-viewport
            data-zoomed={scale > fitScale + 0.001}
            style={{ maxHeight: viewportHeight }}
            role="region"
            aria-label="Artboard viewport"
            tabIndex={0}
            onScroll={() => {
              if (gesture.current) updateGesturePreview(gesture.current);
            }}
          >
            <div
              className="design-paper"
              style={{
                width: block.width * scale,
                height: block.height * scale,
              }}
            >
              <div
                className="design-stage"
                ref={stage}
                data-design-stage=""
                aria-label={`${block.title || "Design"} artboard`}
                style={
                  {
                    width: block.width,
                    height: block.height,
                    background: block.background,
                    transform: `scale(${scale})`,
                    "--design-scale": scale,
                    "--design-inverse-scale": 1 / scale,
                  } as CSSProperties
                }
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) setSelectedId(null);
                }}
              >
                {mountedLayers.map((layer) => {
                  const geometry =
                    preview?.id === layer.id ? preview.geometry : layer;
                  const active = selectedId === layer.id;
                  const asset =
                    layer.kind === "image"
                      ? images.find((asset) => asset.id === layer.assetId)
                      : undefined;
                  const order = block.layers.findIndex(
                    (item) => item.id === layer.id,
                  );
                  return (
                    <div
                      key={layer.id}
                      className="design-layer"
                      data-layer-id={layer.id}
                      data-design-layer-id={layer.id}
                      data-selected={active}
                      data-kind={layer.kind}
                      role="group"
                      aria-label={`${layerName(layer)} layer on artboard`}
                      aria-disabled={disabled}
                      tabIndex={0}
                      ref={(element) => {
                        if (element) stageLayers.current.set(layer.id, element);
                        else stageLayers.current.delete(layer.id);
                      }}
                      style={
                        {
                          left: geometry.x,
                          top: geometry.y,
                          width: geometry.width,
                          height: geometry.height,
                          zIndex: order + 1,
                          "--design-reading-order": order + 1,
                        } as CSSProperties
                      }
                      onFocus={(event) => {
                        if (event.target === event.currentTarget) {
                          setSelectedId(layer.id);
                          setInspectorOpen(true);
                        }
                      }}
                      onPointerDown={(event) =>
                        startGesture(event, layer, "move")
                      }
                      {...pointerEvents}
                      onKeyDown={(event) => layerKey(event, layer)}
                      onDoubleClick={() => {
                        if (layer.kind === "text") editText(layer.id);
                      }}
                    >
                      <div className="design-layer-content">
                        {layer.kind === "shape" && (
                          <div
                            className="design-shape"
                            style={{
                              background: layer.fill,
                              borderRadius:
                                layer.shape === "ellipse" ? "50%" : 0,
                            }}
                          />
                        )}
                        {layer.kind === "image" && (
                          <LayerImage asset={asset} fit={layer.fit} />
                        )}
                        {layer.kind === "text" && (
                          <div
                            className="design-text-preview"
                            data-empty={!layer.text}
                            ref={(element) => {
                              if (element)
                                textPreviews.current.set(layer.id, element);
                              else textPreviews.current.delete(layer.id);
                            }}
                            style={{
                              fontFamily:
                                layer.fontFamily === "serif"
                                  ? "var(--serif)"
                                  : '"Inter Variable", sans-serif',
                              fontSize: layer.fontSize,
                              fontWeight:
                                layer.fontWeight === "regular"
                                  ? 400
                                  : layer.fontWeight === "medium"
                                    ? 500
                                    : 700,
                              color: layer.color,
                              textAlign: layer.align,
                            }}
                          >
                            {layer.text || (
                              <span className="design-empty-text">
                                Add your text
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <button
                        className="design-layer-handle design-move-handle"
                        style={
                          geometry.y * scale >= 28
                            ? { top: -28 / scale }
                            : geometry.x * scale >= 28
                              ? { left: -28 / scale }
                              : undefined
                        }
                        type="button"
                        aria-label={`Move ${layerName(layer)} layer`}
                        aria-disabled={disabled}
                        tabIndex={active ? 0 : -1}
                        onPointerDown={(event) =>
                          startGesture(event, layer, "move")
                        }
                        {...pointerEvents}
                        onKeyDown={(event) => layerKey(event, layer)}
                      >
                        <Move size={13} aria-hidden="true" />
                      </button>
                      <button
                        className="design-layer-handle design-resize-handle"
                        type="button"
                        aria-label={`Resize ${layerName(layer)} layer`}
                        aria-disabled={disabled}
                        tabIndex={active ? 0 : -1}
                        onPointerDown={(event) =>
                          startGesture(event, layer, "resize")
                        }
                        {...pointerEvents}
                        onKeyDown={(event) => layerKey(event, layer, "resize")}
                      >
                        <Maximize2 size={12} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
              {!block.layers.length && (
                <div className="design-empty-board">
                  <span>
                    <Type size={22} aria-hidden="true" />
                    <Plus size={12} aria-hidden="true" />
                    <ImageIcon size={22} aria-hidden="true" />
                  </span>
                  <p>A little room for your ideas.</p>
                  <span>Add text, an image, or a shape to begin.</span>
                </div>
              )}
            </div>
          </div>
          <div className="design-stage-caption">
            <span>
              {block.width} × {block.height} <i>·</i> {Math.round(scale * 100)}%
            </span>
            <span aria-live="polite">
              {preview
                ? `${gesture.current?.mode === "resize" ? "Resizing" : "Moving"} · Release to keep · Esc to cancel`
                : selected
                  ? "Arrow keys to move · Shift for 10 px"
                  : "Select a layer to make it yours"}
            </span>
          </div>
          <details className="design-board-settings">
            <summary>
              <SlidersHorizontal size={13} aria-hidden="true" /> Artboard
              settings <ChevronDown size={12} aria-hidden="true" />
            </summary>
            <div className="design-board-fields">
              <NumberField
                label="Artboard width"
                value={block.width}
                min={240}
                max={2400}
                disabled={disabled}
                onCommit={(value) => resizeBoard("width", value)}
              />
              <NumberField
                label="Artboard height"
                value={block.height}
                min={240}
                max={2400}
                disabled={disabled}
                onCommit={(value) => resizeBoard("height", value)}
              />
              <ColorField
                label="Artboard background"
                value={block.background}
                disabled={disabled}
                onChange={(background) =>
                  change((current) => ({ ...current, background }))
                }
              />
              <small>
                Layers stay within the artboard when its size changes.
              </small>
            </div>
          </details>
        </div>
        <aside
          id={inspectorId}
          className="design-sidebar"
          aria-label="Design layers and properties"
          hidden={!inspectorOpen}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            pendingFocus.current = null;
            setInspectorOpen(false);
            layersButton.current?.focus({ preventScroll: true });
          }}
        >
          <div className="design-sidebar-heading">
            <Layers size={14} aria-hidden="true" />
            <span>Layers</span>
            <small>Front to back</small>
          </div>
          <div
            className="design-layer-list"
            role="group"
            aria-label="Choose a layer"
          >
            {mountedLayers.map((layer) => {
              const rank =
                block.layers.length -
                block.layers.findIndex((item) => item.id === layer.id);
              return (
                <button
                  key={layer.id}
                  type="button"
                  aria-label={`Select ${layerName(layer)} layer`}
                  aria-pressed={selectedId === layer.id}
                  ref={(element) => {
                    if (element) listButtons.current.set(layer.id, element);
                    else listButtons.current.delete(layer.id);
                  }}
                  style={
                    {
                      order: rank,
                      "--design-reading-order": rank,
                    } as CSSProperties
                  }
                  onClick={() => setSelectedId(layer.id)}
                  onKeyDown={(event) => layerKey(event, layer)}
                >
                  <LayerIcon kind={layer.kind} />
                  <span>{layerName(layer)}</span>
                  {selectedId === layer.id ? (
                    <Check size={12} aria-hidden="true" />
                  ) : (
                    <Grip size={12} aria-hidden="true" />
                  )}
                </button>
              );
            })}
            {!block.layers.length && <p>Your layers will appear here.</p>}
          </div>
          {!selected && (
            <div className="design-inspector-welcome">
              <p>Details, in your hands.</p>
              <span>
                Select a layer to adjust its text, color, and position.
              </span>
            </div>
          )}
          {mountedLayers.map((layer) => {
            const order = block.layers.findIndex(
              (item) => item.id === layer.id,
            );
            return (
              <div
                className="design-inspector"
                key={layer.id}
                data-design-inspector={layer.id}
                hidden={selectedId !== layer.id}
                aria-label={`${layerName(layer)} properties`}
              >
                <label className="design-field">
                  Layer name
                  <input
                    aria-label="Layer name"
                    value={layer.name}
                    maxLength={80}
                    readOnly={disabled}
                    onChange={(event) => {
                      const name = event.target.value;
                      if (name.trim())
                        updateLayer(layer.id, (current) => ({
                          ...current,
                          name,
                        }));
                    }}
                  />
                </label>
                {layer.kind === "text" && (
                  <>
                    <label className="design-field design-text-field">
                      Text
                      <textarea
                        aria-label={`${layerName(layer)} text`}
                        value={layer.text}
                        maxLength={4000}
                        readOnly={disabled}
                        placeholder="Write something…"
                        ref={(element) => {
                          if (element) editors.current.set(layer.id, element);
                          else editors.current.delete(layer.id);
                        }}
                        onChange={(event) =>
                          updateLayer(layer.id, (current) =>
                            current.kind === "text"
                              ? { ...current, text: event.target.value }
                              : current,
                          )
                        }
                      />
                    </label>
                    {clippedText.has(layer.id) && (
                      <p className="design-clipped-hint" role="status">
                        Some text is outside this layer’s frame. Enlarge the
                        layer or reduce its text size to show it all.
                      </p>
                    )}
                    <div className="design-field-grid">
                      <label className="design-field">
                        Typeface
                        <select
                          aria-label="Typeface"
                          value={layer.fontFamily}
                          aria-disabled={disabled}
                          onChange={(event) =>
                            updateLayer(layer.id, (current) =>
                              current.kind === "text"
                                ? {
                                    ...current,
                                    fontFamily: event.target.value as
                                      "serif" | "sans",
                                  }
                                : current,
                            )
                          }
                        >
                          <option value="serif">Editorial serif</option>
                          <option value="sans">Clean sans</option>
                        </select>
                      </label>
                      <NumberField
                        label="Text size"
                        value={layer.fontSize}
                        min={8}
                        max={240}
                        disabled={disabled}
                        onCommit={(fontSize) =>
                          updateLayer(layer.id, (current) =>
                            current.kind === "text"
                              ? { ...current, fontSize }
                              : current,
                          )
                        }
                      />
                      <label className="design-field">
                        Text weight
                        <select
                          aria-label="Text weight"
                          value={layer.fontWeight}
                          aria-disabled={disabled}
                          onChange={(event) =>
                            updateLayer(layer.id, (current) =>
                              current.kind === "text"
                                ? {
                                    ...current,
                                    fontWeight: event.target.value as
                                      "regular" | "medium" | "bold",
                                  }
                                : current,
                            )
                          }
                        >
                          <option value="regular">Regular</option>
                          <option value="medium">Medium</option>
                          <option value="bold">Bold</option>
                        </select>
                      </label>
                      <ColorField
                        label="Text color"
                        value={layer.color}
                        disabled={disabled}
                        onChange={(color) =>
                          updateLayer(layer.id, (current) =>
                            current.kind === "text"
                              ? { ...current, color }
                              : current,
                          )
                        }
                      />
                    </div>
                    <div
                      className="design-text-align"
                      role="group"
                      aria-label="Text alignment"
                    >
                      {(["left", "center", "right"] as const).map((align) => (
                        <button
                          key={align}
                          type="button"
                          aria-label={`Align text ${align}`}
                          aria-pressed={layer.align === align}
                          aria-disabled={disabled}
                          onClick={() =>
                            updateLayer(layer.id, (current) =>
                              current.kind === "text"
                                ? { ...current, align }
                                : current,
                            )
                          }
                        >
                          {align === "left" ? (
                            <AlignLeft size={15} />
                          ) : align === "center" ? (
                            <AlignCenter size={15} />
                          ) : (
                            <AlignRight size={15} />
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {layer.kind === "shape" && (
                  <div className="design-field-grid">
                    <label className="design-field">
                      Shape
                      <select
                        aria-label="Shape"
                        value={layer.shape}
                        aria-disabled={disabled}
                        onChange={(event) =>
                          updateLayer(layer.id, (current) =>
                            current.kind === "shape"
                              ? {
                                  ...current,
                                  shape: event.target.value as
                                    "rectangle" | "ellipse",
                                }
                              : current,
                          )
                        }
                      >
                        <option value="rectangle">Rectangle</option>
                        <option value="ellipse">Ellipse</option>
                      </select>
                    </label>
                    <ColorField
                      label="Fill color"
                      value={layer.fill}
                      disabled={disabled}
                      onChange={(fill) =>
                        updateLayer(layer.id, (current) =>
                          current.kind === "shape"
                            ? { ...current, fill }
                            : current,
                        )
                      }
                    />
                  </div>
                )}
                {layer.kind === "image" && (
                  <label className="design-field">
                    Image fit
                    <select
                      aria-label="Image fit"
                      value={layer.fit}
                      aria-disabled={disabled}
                      onChange={(event) =>
                        updateLayer(layer.id, (current) =>
                          current.kind === "image"
                            ? {
                                ...current,
                                fit: event.target.value as "cover" | "contain",
                              }
                            : current,
                        )
                      }
                    >
                      <option value="contain">Show whole image</option>
                      <option value="cover">Fill frame</option>
                    </select>
                    <small>The original image stays unchanged.</small>
                  </label>
                )}
                <div className="design-geometry">
                  <span>Position & size</span>
                  <div className="design-field-grid">
                    <NumberField
                      label="X position"
                      value={layer.x}
                      min={0}
                      max={block.width - layer.width}
                      disabled={disabled}
                      onCommit={(x) =>
                        updateLayer(layer.id, (current) => ({
                          ...current,
                          x: Math.min(
                            x,
                            latest.current.block.width - current.width,
                          ),
                        }))
                      }
                    />
                    <NumberField
                      label="Y position"
                      value={layer.y}
                      min={0}
                      max={block.height - layer.height}
                      disabled={disabled}
                      onCommit={(y) =>
                        updateLayer(layer.id, (current) => ({
                          ...current,
                          y: Math.min(
                            y,
                            latest.current.block.height - current.height,
                          ),
                        }))
                      }
                    />
                    <NumberField
                      label="Layer width"
                      value={layer.width}
                      min={1}
                      max={block.width - layer.x}
                      disabled={disabled}
                      onCommit={(width) =>
                        updateLayer(layer.id, (current) => ({
                          ...current,
                          width: Math.min(
                            width,
                            latest.current.block.width - current.x,
                          ),
                        }))
                      }
                    />
                    <NumberField
                      label="Layer height"
                      value={layer.height}
                      min={1}
                      max={block.height - layer.y}
                      disabled={disabled}
                      onCommit={(height) =>
                        updateLayer(layer.id, (current) => ({
                          ...current,
                          height: Math.min(
                            height,
                            latest.current.block.height - current.y,
                          ),
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="design-order-tools">
                  <button
                    type="button"
                    aria-label="Bring forward"
                    aria-disabled={
                      disabled || order === block.layers.length - 1
                    }
                    onClick={() => {
                      if (order < block.layers.length - 1) reorder(layer.id, 1);
                    }}
                  >
                    <ArrowUp size={13} aria-hidden="true" /> Forward
                  </button>
                  <button
                    type="button"
                    aria-label="Send backward"
                    aria-disabled={disabled || order === 0}
                    onClick={() => {
                      if (order > 0) reorder(layer.id, -1);
                    }}
                  >
                    <ArrowDown size={13} aria-hidden="true" /> Backward
                  </button>
                </div>
                <button
                  className="design-remove-layer"
                  type="button"
                  aria-disabled={disabled}
                  onClick={() => removeLayer(layer.id)}
                >
                  <Trash2 size={12} aria-hidden="true" /> Remove layer
                </button>
              </div>
            );
          })}
        </aside>
      </div>
    </div>
  );
}
