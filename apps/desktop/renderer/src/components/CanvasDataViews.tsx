import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, BarChart3, ChartLine, ChevronDown, SlidersHorizontal, Table2 } from "lucide-react";
import { numericCanvasCell, type CanvasBlock } from "@eve/contracts";
import "./CanvasDataViews.css";

type Table = Extract<CanvasBlock, { kind: "table" }>;
type Chart = Extract<CanvasBlock, { kind: "chart" }>;
type Metric = Extract<CanvasBlock, { kind: "metric" }>;
type DataViewProps<T> = {
  block: T;
  tables: Table[];
  disabled: boolean;
  onChange(block: CanvasBlock): void;
  onRevealTable?(tableId: string, rowId?: string, column?: number): void;
};
const colors = ["#5278e8", "#8b76b5", "#527e7b"];
const exactNumber = (value: number) => Math.abs(value) >= 1e12 || (value !== 0 && Math.abs(value) < 1e-6)
  ? String(value)
  : value.toLocaleString(undefined, { maximumSignificantDigits: 21 });
const axisNumber = (value: number) => value.toLocaleString(undefined, {
  notation: Math.abs(value) >= 1e12 || (value !== 0 && Math.abs(value) < 1e-4) ? "scientific" : Math.abs(value) >= 10000 ? "compact" : "standard", maximumSignificantDigits: 3,
});
const rowLabel = (table: Table, row: number, column = 0) => table.rows[row]?.cells[column]?.trim() || `Row ${row + 1}`;
const shortLabel = (label: string, length = 13) => label.length > length ? `${label.slice(0, length - 1)}…` : label;
const valueDescription = (value: number | null, raw: string | undefined) => value === null
  ? raw?.trim() ? "Not numeric" : "No value"
  : exactNumber(value);

function TableAttribution({ table, disabled, onReveal, kind }: {
  table?: Table;
  disabled: boolean;
  kind: "chart" | "metric";
  onReveal?: () => void;
}) {
  if (!table) return null;
  return <div className="canvas-data-attribution">
    <span><Table2 size={12} aria-hidden="true" /> From {table.title || "Untitled table"}</span>
    {onReveal && <button type="button" aria-label={`Edit ${kind} data`} aria-disabled={disabled}
      onClick={() => { if (!disabled) onReveal(); }}>Edit data <ArrowUpRight size={13} aria-hidden="true" /></button>}
  </div>;
}

function TableChooser({ tables, value, label, disabled, onChange }: {
  tables: Table[];
  value: string | null;
  label: string;
  disabled: boolean;
  onChange(value: string | null): void;
}) {
  return <label className="canvas-data-field">{label}
    <select aria-label={label} value={value ?? ""} aria-disabled={disabled}
      onChange={event => { if (!disabled) onChange(event.target.value || null); }}>
      <option value="">Choose a table</option>
      {value && !tables.some(table => table.id === value) && <option value={value}>Table unavailable</option>}
      {tables.map(table => <option key={table.id} value={table.id}>{table.title || "Untitled table"}</option>)}
    </select>
  </label>;
}

/** A live view of registered table cells. No copied values or executable expressions. */
export function ChartBlock({ block, tables, disabled, onChange, onRevealTable }: DataViewProps<Chart>) {
  const table = tables.find(table => table.id === block.tableId);
  const [settingsOpen, setSettingsOpen] = useState(!table || !block.valueColumns.length);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const rowButtons = useRef(new Map<string, SVGGElement>());
  const [availableWidth, setAvailableWidth] = useState(600);
  const graphId = useId();
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setAvailableWidth(Math.max(240, element.getBoundingClientRect().width));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const series = table ? block.valueColumns.filter(column => column < table.columns.length) : [];
  const rows = table?.rows.map((row, index) => ({
    id: row.id,
    label: rowLabel(table, index, block.labelColumn),
    values: series.map(column => numericCanvasCell(table.rows, index, column)),
    raw: series.map(column => row.cells[column]),
  })) ?? [];
  const selectedIndex = Math.max(0, rows.findIndex(row => row.id === selectedRowId));
  const selected = rows[selectedIndex];
  const finiteValues = rows.flatMap(row => row.values.filter((value): value is number => value !== null));
  const scale = Math.max(...finiteValues.map(Math.abs), 0) || 1;
  const low = Math.min(0, ...finiteValues.map(value => value / scale));
  const high = Math.max(0, ...finiteValues.map(value => value / scale)) || (low === 0 ? 1 : 0);
  const graphWidth = Math.max(availableWidth, rows.length * 38 + 62);
  const graphHeight = 245;
  const inset = { left: 48, right: 14, top: 17, bottom: 37 };
  const plotWidth = graphWidth - inset.left - inset.right;
  const plotHeight = graphHeight - inset.top - inset.bottom;
  const step = plotWidth / Math.max(rows.length, 1);
  const x = (index: number) => inset.left + step * (index + .5);
  const y = (normalized: number) => inset.top + (high - normalized) / (high - low) * plotHeight;
  const zero = y(0);
  const canPlot = !!table && !!rows.length && !!series.length && !!finiteValues.length;
  const missing = rows.some(row => row.values.some(value => value === null));
  const selectFromKeyboard = (event: KeyboardEvent<SVGGElement>, index: number) => {
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? Math.max(0, index - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      setSelectedRowId(rows[next]!.id);
      const target = rowButtons.current.get(rows[next]!.id);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedRowId(rows[index]!.id);
    }
  };
  const paths = series.map((_, seriesIndex) => {
    const segments: string[] = [];
    let run = "";
    rows.forEach((row, index) => {
      const value = row.values[seriesIndex];
      if (value === null) {
        if (run) segments.push(run);
        run = "";
      } else run += `${run ? " L" : "M"}${x(index)} ${y(value / scale)}`;
    });
    if (run) segments.push(run);
    return segments;
  });

  return <div className="canvas-data-view canvas-chart" data-chart-type={block.chartType}>
    <div className="canvas-chart-toolbar">
      <div className="canvas-chart-legend" aria-label="Chart series" data-line={block.chartType === "line"}>
        {table && series.map((column, index) => <span key={column} data-series={index}><i style={block.chartType === "line" ? { borderColor: colors[index] } : { background: colors[index] }} />{table.columns[column]}</span>)}
      </div>
      <div className="canvas-chart-style" role="group" aria-label="Chart style">
        {([ ["bar", "Bars", BarChart3], ["line", "Line", ChartLine] ] as const).map(([type, label, Icon]) => <button
          key={type} type="button" aria-pressed={block.chartType === type} aria-disabled={disabled}
          onClick={() => { if (!disabled) onChange({ ...block, chartType: type }); }}><Icon size={13} aria-hidden="true" />{label}</button>)}
      </div>
    </div>
    <div className="canvas-chart-viewport" ref={viewport}>
      {canPlot ? <svg width={graphWidth} height={graphHeight} viewBox={`0 0 ${graphWidth} ${graphHeight}`}
        role="group" aria-labelledby={`${graphId}-title`} aria-describedby={`${graphId}-help`} className="canvas-chart-graphic">
        <title id={`${graphId}-title`}>{block.title || "Chart"}. {block.chartType === "bar" ? "Bar" : "Line"} chart from {table.title || "your table"}.</title>
        <desc id={`${graphId}-help`}>Select a row to inspect its values. Use arrow keys to move between rows. Missing values have no mark.</desc>
        {[0, 1, 2, 3, 4].map(tick => {
          const value = low + (high - low) * tick / 4;
          return <g key={tick} aria-hidden="true"><line x1={inset.left} x2={graphWidth - inset.right} y1={y(value)} y2={y(value)} className={value === 0 ? "canvas-chart-axis" : "canvas-chart-gridline"} />
            <text x={inset.left - 9} y={y(value) + 3} textAnchor="end" className="canvas-chart-axis-label">{axisNumber(value * scale)}</text></g>;
        })}
        {low < 0 && high > 0 && <line x1={inset.left} x2={graphWidth - inset.right} y1={zero} y2={zero} className="canvas-chart-axis" aria-hidden="true" />}
        {block.chartType === "line" && paths.map((segments, seriesIndex) => segments.map((path, index) => <path key={`${seriesIndex}-${index}`} d={path} fill="none" stroke={colors[seriesIndex]} strokeWidth={2.3} strokeDasharray={seriesIndex === 1 ? "6 4" : seriesIndex === 2 ? "2 4" : undefined} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" />))}
        {rows.map((row, index) => <g key={row.id} ref={element => { if (element) rowButtons.current.set(row.id, element); else rowButtons.current.delete(row.id); }}
          role="button" tabIndex={index === selectedIndex ? 0 : -1} aria-pressed={index === selectedIndex}
          aria-label={`${row.label}. ${series.map((column, seriesIndex) => `${table.columns[column]}: ${valueDescription(row.values[seriesIndex]!, row.raw[seriesIndex])}`).join(". ")}`}
          className="canvas-chart-row" data-selected={index === selectedIndex} data-row-id={row.id}
          onFocus={() => setSelectedRowId(row.id)} onClick={() => setSelectedRowId(row.id)} onKeyDown={event => selectFromKeyboard(event, index)}>
          <rect className="canvas-chart-row-band" x={inset.left + step * index + 1} y={inset.top - 7} width={Math.max(1, step - 2)} height={plotHeight + 14} rx={5} />
          {row.values.map((value, seriesIndex) => {
            if (value === null) return null;
            const pointY = y(value / scale);
            const groupWidth = Math.min(step * .68, 72);
            const barWidth = groupWidth / series.length;
            return block.chartType === "bar"
              ? <rect key={seriesIndex} x={x(index) - groupWidth / 2 + seriesIndex * barWidth + 1} y={Math.min(pointY, zero)} width={Math.max(1, barWidth - 2)} height={Math.max(1.5, Math.abs(pointY - zero))} rx={2} fill={colors[seriesIndex]} opacity={index === selectedIndex ? 1 : .78} data-value={value} />
              : <circle key={seriesIndex} cx={x(index)} cy={pointY} r={index === selectedIndex ? 4.3 : 3} fill={colors[seriesIndex]} stroke="var(--paper, #fbfbf8)" strokeWidth={1.6} data-value={value} />;
          })}
          <text x={x(index)} y={graphHeight - 13} textAnchor="middle" className="canvas-chart-category" aria-hidden="true">{shortLabel(row.label, Math.max(4, Math.min(16, Math.floor(step / 6))))}</text>
        </g>)}
      </svg> : <div className="canvas-data-empty">
        <BarChart3 size={25} strokeWidth={1.25} aria-hidden="true" />
        <p>{!table ? "A clearer view of your numbers." : !series.length ? "Choose what you’d like to see." : !rows.length ? "Your data has room to grow." : "Waiting for a number."}</p>
        <span>{!table ? "Connect a table from this canvas to begin." : !series.length ? "Pick up to three columns in the chart settings." : !rows.length ? "Add rows to the linked table to bring this chart to life." : "Blank cells and text stay unplotted. Add a numeric value to the linked table."}</span>
      </div>}
    </div>
    {selected && series.length > 0 && <div className="canvas-chart-inspector" role="group" aria-label="Selected chart row">
      <span className="canvas-chart-inspector-label">{selected.label}</span>
      <div>{series.map((column, index) => <span key={column}><i style={{ background: colors[index] }} />
        <span>{table!.columns[column]}</span><strong>{valueDescription(selected.values[index]!, selected.raw[index])}</strong></span>)}</div>
    </div>}
    {missing && <p className="canvas-chart-footnote">Blank or nonnumeric cells are shown as gaps.</p>}
    <TableAttribution table={table} disabled={disabled} kind="chart" onReveal={table && onRevealTable ? () => onRevealTable(table.id, selected?.id, series[0]) : undefined} />
    <details className="canvas-data-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
      <summary aria-label={`Configure ${block.title || "chart"}`}><SlidersHorizontal size={13} aria-hidden="true" />Chart settings<ChevronDown size={12} aria-hidden="true" /></summary>
      <div className="canvas-data-settings-body" role="group" aria-label={`${block.title || "Chart"} settings`}>
        <TableChooser tables={tables} value={block.tableId} label="Chart table" disabled={disabled} onChange={tableId => onChange({ ...block, tableId, labelColumn: 0, valueColumns: [] })} />
        {table && <>
          <label className="canvas-data-field">Label column<select aria-label="Label column" value={block.labelColumn} aria-disabled={disabled}
            onChange={event => { if (!disabled) onChange({ ...block, labelColumn: Number(event.target.value) }); }}>
            {table.columns.map((column, index) => <option key={index} value={index}>{column}</option>)}
          </select></label>
          <fieldset className="canvas-chart-series-picker"><legend>Values to plot <span>Choose up to three</span></legend>
            {table.columns.map((column, index) => <label key={index}><input type="checkbox" aria-label={`Plot ${column}`} checked={block.valueColumns.includes(index)}
              aria-disabled={disabled || (!block.valueColumns.includes(index) && block.valueColumns.length >= 3)}
              onChange={event => {
                if (disabled || (event.target.checked && block.valueColumns.length >= 3)) return;
                onChange({ ...block, valueColumns: event.target.checked ? [...block.valueColumns, index] : block.valueColumns.filter(value => value !== index) });
              }} />{column}</label>)}
          </fieldset>
        </>}
        {!tables.length && <p className="canvas-data-settings-note">Add a table to this canvas, then link it here.</p>}
      </div>
    </details>
    {table && series.length > 0 && <details className="canvas-data-table-details"><summary>View chart data <ChevronDown size={12} aria-hidden="true" /></summary>
      <div className="canvas-data-table-scroll"><table><caption>{block.title || "Chart"} data from {table.title || "Untitled table"}</caption>
        <thead><tr><th scope="col">{table.columns[block.labelColumn]}</th>{series.map(column => <th scope="col" key={column}>{table.columns[column]}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} data-selected={row.id === selected?.id}><th scope="row"><button type="button" aria-pressed={row.id === selected?.id} onClick={() => setSelectedRowId(row.id)}>{row.label}</button></th>
          {row.values.map((value, index) => <td key={series[index]}>{valueDescription(value, row.raw[index])}</td>)}</tr>)}</tbody>
      </table></div>
    </details>}
  </div>;
}

/** One linked cell, addressed by stable row identity even when its table is reordered. */
export function MetricBlock({ block, tables, disabled, onChange, onRevealTable }: DataViewProps<Metric>) {
  const table = tables.find(table => table.id === block.tableId);
  const rowIndex = table?.rows.findIndex(row => row.id === block.rowId) ?? -1;
  const row = rowIndex >= 0 ? table?.rows[rowIndex] : undefined;
  const value = table && row ? numericCanvasCell(table.rows, rowIndex, block.column) : null;
  const [settingsOpen, setSettingsOpen] = useState(!table || !row);
  const formatted = value === null ? "—" : value.toLocaleString(undefined, {
    minimumFractionDigits: block.decimals, maximumFractionDigits: block.decimals,
    notation: Math.abs(value) >= 1e12 ? "scientific" : "standard",
  });
  return <div className="canvas-data-view canvas-metric">
    <div className="canvas-metric-face" role="group" aria-label={`${block.title || "Metric"} value`} data-empty={value === null}>
      <div className="canvas-metric-number" title={value === null ? undefined : `Source value: ${exactNumber(value)}`}>
        {value !== null && block.prefix && <span className="canvas-metric-prefix">{block.prefix}</span>}
        <span className="canvas-metric-value" data-length={formatted.length > 11 ? "long" : "normal"}>{formatted}</span>
        {value !== null && block.suffix && <span className="canvas-metric-suffix">{block.suffix}</span>}
      </div>
      <p className="canvas-metric-caption">{!table ? "Keep an important number in sight." : !row ? "Choose the row you’d like to follow." : value === null
        ? row.cells[block.column]?.trim() ? "This cell doesn’t contain a numeric value." : "This cell is still empty."
        : `${rowLabel(table, rowIndex)} · ${table.columns[block.column]}`}</p>
    </div>
    <TableAttribution table={table} disabled={disabled} kind="metric" onReveal={table && onRevealTable ? () => onRevealTable(table.id, row?.id, block.column) : undefined} />
    <details className="canvas-data-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
      <summary aria-label={`Configure ${block.title || "metric"}`}><SlidersHorizontal size={13} aria-hidden="true" />Metric settings<ChevronDown size={12} aria-hidden="true" /></summary>
      <div className="canvas-data-settings-body" role="group" aria-label={`${block.title || "Metric"} settings`}>
        <TableChooser tables={tables} value={block.tableId} label="Metric table" disabled={disabled} onChange={tableId => onChange({ ...block, tableId, rowId: null, column: 0 })} />
        {table && <>
          <label className="canvas-data-field">Metric row<select aria-label="Metric row" value={block.rowId ?? ""} aria-disabled={disabled}
            onChange={event => { if (!disabled) onChange({ ...block, rowId: event.target.value || null }); }}>
            <option value="">Choose a row</option>
            {block.rowId && !row && <option value={block.rowId}>Row unavailable</option>}
            {table.rows.map((row, index) => <option key={row.id} value={row.id}>{rowLabel(table, index)}</option>)}
          </select></label>
          <label className="canvas-data-field">Metric column<select aria-label="Metric column" value={block.column} aria-disabled={disabled}
            onChange={event => { if (!disabled) onChange({ ...block, column: Number(event.target.value) }); }}>
            {table.columns.map((column, index) => <option key={index} value={index}>{column}</option>)}
          </select></label>
        </>}
        <div className="canvas-metric-format">
          <label className="canvas-data-field">Prefix<input aria-label="Prefix" value={block.prefix} maxLength={12} readOnly={disabled} onChange={event => onChange({ ...block, prefix: event.target.value })} placeholder="e.g. $" /></label>
          <label className="canvas-data-field">Suffix<input aria-label="Suffix" value={block.suffix} maxLength={24} readOnly={disabled} onChange={event => onChange({ ...block, suffix: event.target.value })} placeholder="e.g. hours" /></label>
          <label className="canvas-data-field">Decimal places<select aria-label="Decimal places" value={block.decimals} aria-disabled={disabled}
            onChange={event => { if (!disabled) onChange({ ...block, decimals: Number(event.target.value) }); }}>
            {[0, 1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
        </div>
        {!tables.length && <p className="canvas-data-settings-note">Add a table to this canvas, then link one of its cells here.</p>}
      </div>
    </details>
  </div>;
}
