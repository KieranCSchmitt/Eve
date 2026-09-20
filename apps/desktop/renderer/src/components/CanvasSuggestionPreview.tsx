import { useId, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Layers,
  Link2,
  Sparkles,
  X,
} from "lucide-react";
import {
  calculateCell,
  canvasDocumentSchema,
  canvasDataEqual,
  numericCanvasCell,
  normalizedImageAdjustments,
  imageAdjustmentsEqual,
  type CanvasBlock,
  type CanvasDocument,
  type SourceRecord,
} from "@eve/contracts";
import type { IntentProposal, TaskAsset } from "../../../shared/bridge";
import { AdjustedImage } from "./AdjustedImage";
import { EmptyCanvasImage } from "./CanvasImage";
import { CanvasArrangementPreview } from "./CanvasArrangementPreview";
import { compactCanvasChange } from "./compactCanvasChange";
import { retiredCanvasChoices } from "./retiredCanvasChoices";
import { useCanvasReviewExpiration } from "./useCanvasReviewExpiration";
import "./CanvasSuggestionPreview.css";
import "./CanvasInlineReview.css";

export interface CanvasSuggestionPreviewProps {
  proposal: IntentProposal;
  assets: TaskAsset[];
  sources: SourceRecord[];
  onKeep(): void;
  onDismiss(): void;
  disabled?: boolean;
}
type ViewProps = {
  block: CanvasBlock;
  other?: CanvasBlock;
  document: CanvasDocument;
  assets: TaskAsset[];
  sources: SourceRecord[];
  side: "before" | "after";
};
const kindNames: Record<CanvasBlock["kind"], string> = {
  text: "Writing",
  checklist: "Checklist",
  table: "Table",
  chart: "Chart",
  metric: "Value",
  timeline: "Schedule",
  image: "Image",
  design: "Design",
  timer: "Timer",
  deadline: "Deadline",
  sources: "Sources",
  note: "Note",
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const numberText = (value: number) =>
  Math.abs(value) >= 1e12 || (value !== 0 && Math.abs(value) < 1e-6)
    ? String(value)
    : value.toLocaleString(undefined, { maximumSignificantDigits: 21 });
const durationText = (seconds: number) =>
  `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${Math.floor(seconds / 60) % 60 < 10 && seconds >= 3600 ? "0" : ""}${Math.floor(seconds / 60) % 60}:${String(seconds % 60).padStart(2, "0")}`;
const timeText = (minutes: number) =>
  `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${minutes % 1440 < 720 ? "AM" : "PM"}`;
const dateText = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const findTable = (document: CanvasDocument, id: string | null) =>
  document.blocks.find(
    (block): block is Extract<CanvasBlock, { kind: "table" }> =>
      block.kind === "table" && block.id === id,
  );

function ChangedText({
  text,
  other,
  side,
}: {
  text: string;
  other?: string;
  side: "before" | "after";
}) {
  if (!text) return <span className="suggestion-preview-empty">Empty</span>;
  if (other === undefined || text === other) return <>{text}</>;
  let prefix = 0;
  while (
    prefix < Math.min(text.length, other.length) &&
    text[prefix] === other[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(text.length, other.length) - prefix &&
    text[text.length - suffix - 1] === other[other.length - suffix - 1]
  )
    suffix++;
  const word = (character: string | undefined) =>
    !!character && /[\p{L}\p{N}]/u.test(character);
  while (
    prefix > 0 &&
    word(text[prefix - 1]) &&
    (word(text[prefix]) || word(other[prefix]))
  )
    prefix--;
  while (suffix > 0 && word(text[text.length - suffix])) suffix--;
  const middle = text.slice(prefix, text.length - suffix);
  return (
    <>
      {text.slice(0, prefix)}
      {side === "before" ? <del>{middle}</del> : <ins>{middle}</ins>}
      {suffix > 0 && text.slice(-suffix)}
    </>
  );
}

function DesignPreview({
  block,
  other,
  side,
  assets,
}: {
  block: Extract<CanvasBlock, { kind: "design" }>;
  other?: Extract<CanvasBlock, { kind: "design" }>;
  side: "before" | "after";
  assets: TaskAsset[];
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const titleId = useId();
  return (
    <div className="suggestion-preview-design">
      <svg
        viewBox={`0 0 ${block.width} ${block.height}`}
        role="img"
        aria-labelledby={titleId}
        style={{ background: block.background }}
      >
        <title id={titleId}>
          {block.title || "Design"}, {block.layers.length} layers
        </title>
        {block.layers.map((layer) => {
          if (layer.kind === "shape")
            return layer.shape === "ellipse" ? (
              <ellipse
                key={layer.id}
                cx={layer.x + layer.width / 2}
                cy={layer.y + layer.height / 2}
                rx={layer.width / 2}
                ry={layer.height / 2}
                fill={layer.fill}
              />
            ) : (
              <rect
                key={layer.id}
                x={layer.x}
                y={layer.y}
                width={layer.width}
                height={layer.height}
                fill={layer.fill}
              />
            );
          if (layer.kind === "image") {
            const asset = assets.find(
              (asset) =>
                asset.id === layer.assetId &&
                asset.mediaType.startsWith("image/"),
            );
            return asset && !failed.has(asset.url) ? (
              <svg
                key={layer.id}
                x={layer.x}
                y={layer.y}
                width={layer.width}
                height={layer.height}
                viewBox={`0 0 ${layer.width} ${layer.height}`}
                overflow="hidden"
              >
                <image
                  href={asset.url}
                  width={layer.width}
                  height={layer.height}
                  preserveAspectRatio={
                    layer.fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"
                  }
                  onError={() =>
                    setFailed((previous) => new Set([...previous, asset.url]))
                  }
                />
              </svg>
            ) : (
              <g key={layer.id}>
                <rect
                  x={layer.x}
                  y={layer.y}
                  width={layer.width}
                  height={layer.height}
                  fill="#edf0f7"
                />
                <text
                  x={layer.x + layer.width / 2}
                  y={layer.y + layer.height / 2}
                  fontSize={Math.max(8, Math.min(24, layer.width / 12))}
                  textAnchor="middle"
                  fill="#6f7d95"
                >
                  Image unavailable
                </text>
              </g>
            );
          }
          return (
            <foreignObject
              key={layer.id}
              x={layer.x}
              y={layer.y}
              width={layer.width}
              height={layer.height}
              overflow="hidden"
            >
              <div
                className="suggestion-preview-design-text"
                style={{
                  fontSize: layer.fontSize,
                  fontFamily:
                    layer.fontFamily === "serif"
                      ? "var(--serif)"
                      : '"Inter Variable", sans-serif',
                  fontWeight:
                    layer.fontWeight === "bold"
                      ? 700
                      : layer.fontWeight === "medium"
                        ? 500
                        : 400,
                  color: layer.color,
                  textAlign: layer.align,
                }}
              >
                {layer.text}
              </div>
            </foreignObject>
          );
        })}
      </svg>
      <span className="suggestion-preview-caption">
        {block.width} × {block.height} · {block.layers.length}{" "}
        {block.layers.length === 1 ? "layer" : "layers"}
      </span>
      {block.layers
        .filter(
          (layer) =>
            layer.kind === "text" &&
            other?.layers.some(
              (previous) =>
                previous.id === layer.id &&
                previous.kind === "text" &&
                previous.text !== layer.text,
            ),
        )
        .map((layer) => {
          if (layer.kind !== "text") return null;
          const previous = other?.layers.find(
            (previous) => previous.id === layer.id,
          );
          return (
            <div key={layer.id} className="suggestion-preview-design-change">
              <small>{layer.name}</small>
              <p>
                <ChangedText
                  text={layer.text}
                  other={previous?.kind === "text" ? previous.text : undefined}
                  side={side}
                />
              </p>
            </div>
          );
        })}
      <details className="suggestion-preview-details">
        <summary>
          <Layers size={12} aria-hidden="true" /> Layer contents{" "}
          <ChevronDown size={12} aria-hidden="true" />
        </summary>
        <ol className="suggestion-preview-layer-details">
          {block.layers.map((layer) => (
            <li key={layer.id}>
              <strong>{layer.name}</strong>
              <small>
                {layer.kind} · {layer.x}, {layer.y} · {layer.width} ×{" "}
                {layer.height}
                {layer.kind === "text"
                  ? ` · ${layer.fontSize}px ${layer.fontFamily}, ${layer.fontWeight}, ${layer.align}, ${layer.color}`
                  : layer.kind === "shape"
                    ? ` · ${layer.shape}, ${layer.fill}`
                    : ` · ${layer.fit}`}
              </small>
              {layer.kind === "text" && (
                <p>{layer.text || "Empty text layer"}</p>
              )}
              {layer.kind === "image" && (
                <p>
                  {assets.find((asset) => asset.id === layer.assetId)?.title ??
                    "Image unavailable"}
                </p>
              )}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function TablePreview({
  block,
}: {
  block: Extract<CanvasBlock, { kind: "table" }>;
}) {
  return (
    <div
      className="suggestion-preview-scroll"
      tabIndex={0}
      role="region"
      aria-label={`${block.title || "Table"} cells`}
    >
      <table>
        <thead>
          <tr>
            {block.columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={row.id}>
              {row.cells.map((cell, column) => {
                const value = calculateCell(block.rows, rowIndex, column);
                return (
                  <td key={column}>
                    {value === "" ? (
                      <span
                        className="suggestion-preview-empty"
                        aria-label="Empty cell"
                      >
                        —
                      </span>
                    ) : typeof value === "number" ? (
                      numberText(value)
                    ) : (
                      value
                    )}
                    {cell.startsWith("=") && (
                      <small className="suggestion-preview-formula">
                        {cell}
                      </small>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!block.rows.length && (
        <p className="suggestion-preview-empty">No rows yet.</p>
      )}
    </div>
  );
}

function ChartPreview({
  block,
  document,
}: {
  block: Extract<CanvasBlock, { kind: "chart" }>;
  document: CanvasDocument;
}) {
  const table = findTable(document, block.tableId);
  const series = table
    ? block.valueColumns.filter((column) => column < table.columns.length)
    : [];
  const rows =
    table?.rows.map((row, index) => ({
      id: row.id,
      label: row.cells[block.labelColumn]?.trim() || `Row ${index + 1}`,
      values: series.map((column) =>
        numericCanvasCell(table.rows, index, column),
      ),
    })) ?? [];
  const values = rows.flatMap((row) =>
    row.values.filter((value): value is number => value !== null),
  );
  if (!table || !series.length || !rows.length || !values.length)
    return (
      <p className="suggestion-preview-empty">
        {!table
          ? "No linked table selected."
          : !series.length
            ? "No value columns selected."
            : "No numeric values to plot."}
      </p>
    );
  const scale = Math.max(...values.map(Math.abs), 0) || 1;
  const low = Math.min(0, ...values.map((value) => value / scale));
  const high =
    Math.max(0, ...values.map((value) => value / scale)) || (low === 0 ? 1 : 0);
  const width = Math.max(360, rows.length * 30 + 40),
    height = 180;
  const step = (width - 44) / rows.length;
  const x = (index: number) => 28 + step * (index + 0.5);
  const y = (value: number) =>
    14 + ((high - value / scale) / (high - low)) * 130;
  const palette = ["#597de1", "#8b78a9", "#548b84"];
  return (
    <div className="suggestion-preview-chart">
      <div className="suggestion-preview-chart-legend">
        {series.map((column, index) => (
          <span key={column}>
            <i
              style={{
                background: palette[index],
                borderRadius: index === 0 ? "50%" : index === 1 ? 0 : "2px",
              }}
            />
            {table.columns[column]}
          </span>
        ))}
      </div>
      <div
        className="suggestion-preview-chart-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${block.title || "Chart"} graphic`}
      >
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${block.chartType === "line" ? "Line" : "Bar"} chart from ${table.title || "table"}. Exact values follow in Chart data.`}
        >
          <line x1={20} y1={y(0)} x2={width - 10} y2={y(0)} stroke="#cad3e4" />
          {series.map((column, seriesIndex) =>
            block.chartType === "bar" ? (
              <g key={column}>
                {rows.map((row, index) => {
                  const value = row.values[seriesIndex];
                  return value === null || value === undefined ? null : (
                    <rect
                      key={row.id}
                      x={
                        x(index) -
                        step * 0.34 +
                        (seriesIndex * step * 0.68) / series.length
                      }
                      y={Math.min(y(value), y(0))}
                      width={Math.max(1, (step * 0.68) / series.length - 2)}
                      height={Math.max(1, Math.abs(y(value) - y(0)))}
                      fill={palette[seriesIndex]}
                    >
                      <title>
                        {row.label}: {numberText(value)}
                      </title>
                    </rect>
                  );
                })}
              </g>
            ) : (
              <g key={column}>
                {rows.map((row, index) => {
                  const value = row.values[seriesIndex];
                  const previous = rows[index - 1]?.values[seriesIndex];
                  if (value === null || value === undefined) return null;
                  return (
                    <g key={row.id}>
                      {previous !== undefined && previous !== null && (
                        <line
                          x1={x(index - 1)}
                          y1={y(previous)}
                          x2={x(index)}
                          y2={y(value)}
                          stroke={palette[seriesIndex]}
                          strokeWidth={2}
                          strokeDasharray={
                            seriesIndex === 1
                              ? "6 4"
                              : seriesIndex === 2
                                ? "2 4"
                                : undefined
                          }
                        />
                      )}
                      <circle
                        cx={x(index)}
                        cy={y(value)}
                        r={3}
                        fill={palette[seriesIndex]}
                      >
                        <title>
                          {row.label}: {numberText(value)}
                        </title>
                      </circle>
                    </g>
                  );
                })}
              </g>
            ),
          )}
          {rows.map((row, index) => (
            <text
              key={row.id}
              x={x(index)}
              y={166}
              textAnchor="middle"
              fontSize={9}
              fill="#778399"
            >
              {row.label.length > 11 ? `${row.label.slice(0, 10)}…` : row.label}
            </text>
          ))}
        </svg>
      </div>
      <details className="suggestion-preview-details">
        <summary>
          Chart data <ChevronDown size={12} aria-hidden="true" />
        </summary>
        <div className="suggestion-preview-scroll" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{table.columns[block.labelColumn]}</th>
                {series.map((column) => (
                  <th key={column} scope="col">
                    {table.columns[column]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.label}</th>
                  {row.values.map((value, index) => (
                    <td key={index}>
                      {value === null ? "No numeric value" : numberText(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <span className="suggestion-preview-caption">
        <Link2 size={11} aria-hidden="true" /> Linked to{" "}
        {table.title || "Untitled table"}
      </span>
    </div>
  );
}

function BlockPreview({
  block,
  other,
  document,
  assets,
  sources,
  side,
}: ViewProps) {
  switch (block.kind) {
    case "text":
      return (
        <div
          className="suggestion-preview-prose"
          tabIndex={block.body.length > 1200 ? 0 : undefined}
        >
          <ChangedText
            text={block.body}
            other={other?.kind === "text" ? other.body : undefined}
            side={side}
          />
        </div>
      );
    case "note":
    case "sources":
      return (
        <>
          <div className="suggestion-preview-prose">
            <ChangedText
              text={block.description}
              other={other?.kind === block.kind ? other.description : undefined}
              side={side}
            />
          </div>
          {block.kind === "sources" && (
            <ul className="suggestion-preview-sources">
              {block.sourceIds.map((id) => (
                <li key={id}>
                  <FileText size={13} aria-hidden="true" />
                  <span>
                    {sources.find((source) => source.id === id)?.title ??
                      "Source unavailable"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    case "checklist":
      return block.items.length ? (
        <ul className="suggestion-preview-checklist">
          {block.items.map((item) => (
            <li key={item.id} data-checked={item.checked}>
              <span
                className="suggestion-preview-check"
                aria-label={item.checked ? "Checked" : "Not checked"}
              >
                {item.checked && <Check size={12} aria-hidden="true" />}
              </span>
              <span>{item.label || "Empty item"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="suggestion-preview-empty">No checklist items yet.</p>
      );
    case "table":
      return <TablePreview block={block} />;
    case "chart":
      return <ChartPreview block={block} document={document} />;
    case "metric": {
      const table = findTable(document, block.tableId);
      const row = table?.rows.findIndex((row) => row.id === block.rowId) ?? -1;
      const value =
        table && row >= 0
          ? numericCanvasCell(table.rows, row, block.column)
          : null;
      return (
        <div className="suggestion-preview-metric">
          <div>
            {value === null ? (
              <span className="suggestion-preview-empty">No numeric value</span>
            ) : (
              <>
                <span>{block.prefix}</span>
                <strong>
                  {value.toLocaleString(undefined, {
                    notation:
                      Math.abs(value) >= 1e12 ? "scientific" : "standard",
                    minimumFractionDigits: block.decimals,
                    maximumFractionDigits: block.decimals,
                  })}
                </strong>
                <span>{block.suffix}</span>
              </>
            )}
          </div>
          <small>
            {table
              ? `${table.title || "Untitled table"} · ${row >= 0 ? table.rows[row]?.cells[0] || `Row ${row + 1}` : "No row selected"} · ${table.columns[block.column] ?? "No column selected"}`
              : "No linked table selected"}
          </small>
        </div>
      );
    }
    case "image": {
      const settings = normalizedImageAdjustments(block.adjustments);
      const hasSettings =
        !imageAdjustmentsEqual(block.adjustments, null) ||
        (other?.kind === "image" &&
          !imageAdjustmentsEqual(other.adjustments, null));
      const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;
      return (
        <figure>
          {block.assetId === null ? (
            <EmptyCanvasImage />
          ) : (
            <AdjustedImage
              asset={assets.find((asset) => asset.id === block.assetId)}
              adjustments={block.adjustments}
              alt={block.title || "Attached image"}
              maxHeight={310}
            />
          )}
          {block.caption && (
            <figcaption className="suggestion-preview-caption">
              {block.caption}
            </figcaption>
          )}
          {block.assetId !== null && hasSettings && (
            <details className="suggestion-preview-image-settings">
              <summary>Photo settings</summary>
              <dl>
                <div>
                  <dt>Brightness</dt>
                  <dd>{percent(settings.brightness)}</dd>
                </div>
                <div>
                  <dt>Contrast</dt>
                  <dd>{percent(settings.contrast)}</dd>
                </div>
                <div>
                  <dt>Color intensity</dt>
                  <dd>{percent(settings.saturation)}</dd>
                </div>
                <div>
                  <dt>Straighten</dt>
                  <dd>{settings.straighten}°</dd>
                </div>
                <div className="is-crop">
                  <dt>Crop edges</dt>
                  <dd>
                    Left {percent(settings.crop.left)} · Top{" "}
                    {percent(settings.crop.top)} · Right{" "}
                    {percent(settings.crop.right)} · Bottom{" "}
                    {percent(settings.crop.bottom)}
                  </dd>
                </div>
              </dl>
            </details>
          )}
        </figure>
      );
    }
    case "design":
      return (
        <DesignPreview
          block={block}
          other={other?.kind === "design" ? other : undefined}
          side={side}
          assets={assets}
        />
      );
    case "timeline":
      return (
        <div className="suggestion-preview-timeline">
          <p>
            {block.date || "Date not set"}{" "}
            <span>
              {timeText(block.startHour * 60)} – {timeText(block.endHour * 60)}
            </span>
          </p>
          {block.items.length ? (
            <ol>
              {block.items.map((item) => (
                <li key={item.id} data-status={item.status}>
                  <time>
                    {timeText(item.startMinutes)} – {timeText(item.endMinutes)}
                  </time>
                  <strong>{item.title || "Untitled event"}</strong>
                  {item.detail && <span>{item.detail}</span>}
                  <small>{item.status}</small>
                </li>
              ))}
            </ol>
          ) : (
            <span className="suggestion-preview-empty">No events yet.</span>
          )}
        </div>
      );
    case "timer":
      return (
        <div className="suggestion-preview-time">
          <strong>{durationText(block.remainingSeconds)}</strong>
          <span>
            {durationText(block.durationSeconds)} total ·{" "}
            {block.endsAt === null
              ? "Stopped"
              : `Running · ends ${dateText(block.endsAt)}`}
          </span>
          <small>
            Preview only. This view does not start or update a timer.
          </small>
        </div>
      );
    case "deadline":
      return (
        <div className="suggestion-preview-time">
          <strong>
            {block.dueAt === null ? "No deadline set" : dateText(block.dueAt)}
          </strong>
        </div>
      );
  }
}

function statusText(proposal: IntentProposal, expired: boolean) {
  if (expired) return "This preview has expired. Open the suggestion again.";
  switch (proposal.status) {
    case "ready":
      return "Your work stays as it is until you choose Keep.";
    case "applying":
      return "Keeping your changes…";
    case "applied":
      return "Kept in your space.";
    case "discarded":
      return "Dismissed. Your work is unchanged.";
    case "stale":
      return "Your work has changed. Ask for fresh next steps to review new choices from your current space.";
    case "expired":
      return "This preview has expired. Open the suggestion again.";
    case "uncertain":
      return "Eve could not confirm whether these changes were kept. Check your space before trying again.";
    case "error":
      return proposal.message || "These changes could not be kept.";
    case "unsupported":
      return "This change is not available to keep.";
  }
}

/** A review of host-resolved data only. No editor, mutation callback, or model request lives here. */
export function CanvasSuggestionPreview({
  proposal,
  assets,
  sources,
  onKeep,
  onDismiss,
  disabled = false,
}: CanvasSuggestionPreviewProps) {
  const headingId = useId();
  const [comparisonSides, setComparisonSides] = useState<
    Record<string, "before" | "after">
  >({});
  const [inspectedProposal, setInspectedProposal] = useState<string | null>(
    null,
  );
  const baseline = canvasDocumentSchema.safeParse(proposal.beforeCanvas);
  const candidate = canvasDocumentSchema.safeParse(proposal.canvas);
  const before = baseline.success ? baseline.data : null;
  const after = candidate.success ? candidate.data : null;
  const valid = proposal.kind === "canvas" && before && after;
  const expired = useCanvasReviewExpiration(
    proposal.status === "ready" ? proposal.expiresAt : undefined,
  );
  const ids = valid
    ? [
        ...new Set([
          ...after.blocks.map((block) => block.id),
          ...before.blocks.map((block) => block.id),
        ]),
      ]
    : [];
  const changes = valid
    ? ids.flatMap((id) => {
        const previous = before.blocks.find((block) => block.id === id);
        const next = after.blocks.find((block) => block.id === id);
        const linkedChanged =
          next &&
          (next.kind === "chart" || next.kind === "metric") &&
          !same(
            findTable(before, next.tableId),
            findTable(after, next.tableId),
          );
        return same(previous, next) && !linkedChanged
          ? []
          : [
              {
                id,
                before: previous,
                after: next,
                linked: same(previous, next) && !!linkedChanged,
              },
            ];
      })
    : [];
  const arrangementChanged =
    !!valid &&
    (before.layout !== after.layout ||
      !same(
        before.blocks.map(({ id, placement }) => ({ id, placement })),
        after.blocks.map(({ id, placement }) => ({ id, placement })),
      ));
  const titleChanged =
    !!valid &&
    (before.title !== after.title || before.subtitle !== after.subtitle);
  const metadataChanged = titleChanged || arrangementChanged;
  const nextStepsChanged =
    !!valid &&
    !same(
      (before.suggestions ?? []).filter(
        (suggestion) => suggestion.id !== proposal.preparedSuggestionId,
      ),
      after.suggestions ?? [],
    );
  const hasChanges = changes.length > 0 || metadataChanged;
  const repeatedSummary = !!before?.suggestions?.some(
    (suggestion) =>
      suggestion.id === proposal.preparedSuggestionId &&
      suggestion.description === proposal.summary,
  );
  const canKeep =
    !!valid &&
    hasChanges &&
    proposal.status === "ready" &&
    !expired &&
    !disabled;
  const canDismiss = !disabled && proposal.status !== "applying";
  const single = changes.length === 1 ? changes[0] : undefined;
  const retiredChoices =
    valid && proposal.preparedSuggestionId
      ? retiredCanvasChoices(before, after, proposal.preparedSuggestionId)
      : null;
  // General host proposals have no chosen card to retire. Compact review is
  // safe only when their entire suggestion metadata stays exactly unchanged.
  const choicesCovered = proposal.preparedSuggestionId
    ? retiredChoices !== null
    : !!valid && canvasDataEqual(before.suggestions, after.suggestions);
  const reconstructed =
    valid && single?.after
      ? {
          ...before,
          blocks: before.blocks.map((block) =>
            block.id === single.id ? single.after : block,
          ),
        }
      : null;
  if (reconstructed && after) {
    // Optional metadata can be absent in canonical documents. Preserve that
    // ownership exactly instead of inventing an own `undefined` property.
    if (Object.hasOwn(after, "suggestions"))
      reconstructed.suggestions = after.suggestions;
    else delete reconstructed.suggestions;
  }
  const documentCovered =
    !!reconstructed && canvasDataEqual(reconstructed, after);
  const compact =
    !metadataChanged &&
    choicesCovered &&
    documentCovered &&
    single?.before &&
    single.after &&
    !single.linked
      ? compactCanvasChange(
          single.before,
          single.after,
          proposal.textSelection ?? before?.suggestions?.find(
            (suggestion) => suggestion.id === proposal.preparedSuggestionId,
          )?.textSelection,
        )
      : null;
  const inspecting = inspectedProposal === proposal.id;
  const keepLabel =
    proposal.status === "applying"
      ? "Keeping…"
      : proposal.status === "applied"
        ? "Kept"
        : "Keep";
  const approval = (
    <div
      className="suggestion-inline-actions"
      role="group"
      aria-label="Review this change"
    >
      <button
        type="button"
        className="suggestion-preview-keep"
        aria-label={keepLabel}
        title={keepLabel}
        aria-disabled={!canKeep}
        onPointerDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          if (canKeep) onKeep();
        }}
      >
        <Check size={17} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="suggestion-preview-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        aria-disabled={!canDismiss}
        onPointerDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          if (canDismiss) onDismiss();
        }}
      >
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
  return (
    <section
      className="canvas-suggestion-preview"
      data-testid="canvas-suggestion-preview"
      data-status={proposal.status}
      data-compact={changes.length === 1 && !metadataChanged}
      data-review-mode={compact ? "compact" : "full"}
      data-inspecting={!!compact && inspecting}
      aria-label="Suggestion preview"
      aria-describedby={headingId}
      aria-busy={proposal.status === "applying" || undefined}
    >
      <div className="suggestion-preview-shell">
        <header className="suggestion-preview-heading">
          <span className="suggestion-preview-kicker">
            <Sparkles size={14} aria-hidden="true" />{" "}
            {compact ? "Suggested change" : "A change to consider"}
          </span>
          <h2 id={headingId}>
            {compact
              ? single!.before!.title || kindNames[single!.before!.kind]
              : proposal.label || "Preview your changes"}
          </h2>
          {!compact && proposal.summary && !repeatedSummary && (
            <p>{proposal.summary}</p>
          )}
        </header>
        {(!valid || !hasChanges || proposal.status !== "ready" || expired) && (
          <div className="suggestion-preview-status" role="status">
            {!valid
              ? "A complete before-and-after preview is unavailable. Your work has not been changed by this preview."
              : !hasChanges
                ? "This preview does not change your space."
                : statusText(proposal, expired)}
          </div>
        )}
        {compact && (
          <div
            className="suggestion-compact-change"
            data-compact-block-id={single!.id}
          >
            <p className="suggestion-compact-field">{compact.field}</p>
            <div
              className="suggestion-compact-values"
              data-short={
                Math.max(compact.before.length, compact.after.length) <= 40
              }
            >
              <div
                className="suggestion-inline-original"
                aria-label={`Before: ${compact.field}`}
              >
                <del>{compact.before || <em>Empty</em>}</del>
              </div>
              <ArrowRight size={15} aria-hidden="true" />
              <div
                className="suggestion-inline-proposed"
                aria-label={`After: ${compact.field}`}
              >
                <ins>{compact.after || <em>Empty</em>}</ins> {approval}
              </div>
            </div>
            {!!retiredChoices?.length && (
              <details className="suggestion-compact-retirements">
                <summary>
                  <span>
                    Also removes {retiredChoices.length} outdated{" "}
                    {retiredChoices.length === 1 ? "suggestion" : "suggestions"}
                  </span>
                  <ChevronDown size={12} aria-hidden="true" />
                </summary>
                <ul aria-label="Outdated suggestions removed by this change">
                  {retiredChoices.map(({ suggestion, reason, target }) => (
                    <li key={suggestion.id}>
                      <strong>{suggestion.label}</strong>
                      <span>
                        {target
                          ? target.title
                            ? `${target.title} · ${kindNames[target.kind]}`
                            : kindNames[target.kind]
                          : "Whole canvas"}
                      </span>
                      <p>{reason}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="suggestion-compact-inspection">
              {compact.note && <span>{compact.note}</span>}
              <button
                type="button"
                aria-expanded={inspecting}
                aria-controls={`${headingId}-full-review`}
                onClick={() =>
                  setInspectedProposal(inspecting ? null : proposal.id)
                }
              >
                {inspecting ? "Close full inspection" : "Inspect full item"}{" "}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {valid && (
          <div
            id={`${headingId}-full-review`}
            className="suggestion-preview-changes"
            hidden={!!compact && !inspecting}
          >
            {titleChanged && (
              <div className="suggestion-preview-document">
                <div>
                  <span>Current space</span>
                  <strong>{before.title}</strong>
                  {before.subtitle && <p>{before.subtitle}</p>}
                  <small>
                    {before.layout === "focus"
                      ? "Page"
                      : before.layout === "split"
                        ? "Beside"
                        : "Gallery"}{" "}
                    · {before.blocks.length} items
                  </small>
                </div>
                <ArrowRight size={16} aria-hidden="true" />
                <div>
                  <span>With this change</span>
                  <strong>{after.title}</strong>
                  {after.subtitle && <p>{after.subtitle}</p>}
                  <small>
                    {after.layout === "focus"
                      ? "Page"
                      : after.layout === "split"
                        ? "Beside"
                        : "Gallery"}{" "}
                    · {after.blocks.length} items
                  </small>
                </div>
              </div>
            )}
            {arrangementChanged && (
              <CanvasArrangementPreview
                before={before}
                after={after}
                assets={assets}
                sources={sources}
              />
            )}
            {changes.map((change) => (
              <article
                className="suggestion-preview-change"
                key={change.id}
                data-preview-block-id={change.id}
              >
                <div className="suggestion-preview-change-heading">
                  <h3>
                    {change.after?.title ||
                      change.before?.title ||
                      kindNames[(change.after ?? change.before)!.kind]}
                  </h3>
                  <span>
                    {!change.before
                      ? "Added"
                      : !change.after
                        ? "Removed"
                        : change.linked
                          ? "Linked values update"
                          : "Updated"}
                  </span>
                </div>
                <div
                  className="suggestion-preview-comparison"
                  role="group"
                  aria-label={`Compare ${change.after?.title || change.before?.title || "canvas item"}`}
                >
                  {(["before", "after"] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      aria-pressed={
                        (comparisonSides[change.id] ??
                          (change.after ? "after" : "before")) === side
                      }
                      aria-controls={`${headingId}-${change.id}-${side}`}
                      onClick={() =>
                        setComparisonSides((previous) => ({
                          ...previous,
                          [change.id]: side,
                        }))
                      }
                    >
                      {side === "before" ? "Before" : "After"}
                    </button>
                  ))}
                </div>
                <div
                  className="suggestion-preview-pair"
                  data-narrow-side={
                    comparisonSides[change.id] ??
                    (change.after ? "after" : "before")
                  }
                >
                  {(["before", "after"] as const).map((side) => {
                    const block = change[side];
                    const other =
                      change[side === "before" ? "after" : "before"];
                    return (
                      <section
                        key={side}
                        id={`${headingId}-${change.id}-${side}`}
                        className={`suggestion-preview-side is-${side}`}
                        aria-label={`${side === "before" ? "Before" : "After"}: ${change.after?.title || change.before?.title || "canvas item"}`}
                      >
                        <div className="suggestion-preview-side-heading">
                          <span>{side === "before" ? "Before" : "After"}</span>
                          {block && (
                            <small>
                              {kindNames[block.kind]}
                              {block.pinned ? " · Pinned" : ""} ·{" "}
                              {block.placement === "aside"
                                ? "Beside"
                                : block.placement === "full"
                                  ? "Full width"
                                  : "Main"}
                            </small>
                          )}
                        </div>
                        {block ? (
                          <>
                            {block.title !==
                              (change.after?.title || change.before?.title) && (
                              <h4>{block.title}</h4>
                            )}
                            <BlockPreview
                              block={block}
                              other={other}
                              document={side === "before" ? before : after}
                              assets={assets}
                              sources={sources}
                              side={side}
                            />
                            {block.sourceIds.length > 0 &&
                              block.kind !== "sources" && (
                                <div className="suggestion-preview-attribution">
                                  <Link2 size={11} aria-hidden="true" />
                                  {block.sourceIds
                                    .map(
                                      (id) =>
                                        sources.find(
                                          (source) => source.id === id,
                                        )?.title ?? "Source unavailable",
                                    )
                                    .join(" · ")}
                                </div>
                              )}
                          </>
                        ) : (
                          <div className="suggestion-preview-empty-slot">
                            {side === "before"
                              ? "A new item for your space"
                              : "This item will be removed"}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              </article>
            ))}
            {nextStepsChanged && (
              <details className="suggestion-preview-details suggestion-preview-next-steps">
                <summary>
                  Suggested next steps update{" "}
                  <ChevronDown size={12} aria-hidden="true" />
                </summary>
                <div className="suggestion-preview-pair">
                  {[before, after].map((document, index) => (
                    <div key={index}>
                      <strong>{index === 0 ? "Before" : "After"}</strong>
                      {document.suggestions?.length ? (
                        <ul>
                          {document.suggestions.map((suggestion) => (
                            <li key={suggestion.id}>
                              <strong>{suggestion.label}</strong>
                              <p>{suggestion.description}</p>
                              <small>{suggestion.request}</small>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No suggested next steps.</p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
        {!compact && (
          <footer className="suggestion-preview-actions">
            <span>
              <CheckCheck size={14} aria-hidden="true" />{" "}
              {proposal.status === "applied"
                ? "Changes kept"
                : proposal.status === "ready"
                  ? "Not kept yet"
                  : "Review before keeping"}
            </span>
            {approval}
          </footer>
        )}
      </div>
    </section>
  );
}
