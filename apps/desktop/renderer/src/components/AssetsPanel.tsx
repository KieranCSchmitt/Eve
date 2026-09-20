import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon } from "lucide-react";
import type { TaskAsset } from "../../../shared/bridge";

const PREVIEW_CHARACTERS = 200_000;

export function AssetsPanel({
  assets,
  requestedAssetId,
  requestToken,
  active = true,
  onSelected,
}: {
  assets: TaskAsset[];
  requestedAssetId?: string;
  requestToken?: string;
  active?: boolean;
  onSelected?: (assetId: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const selectionListener = useRef(onSelected);
  selectionListener.current = onSelected;
  const handledRequest = useRef<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const token = requestToken ?? requestedAssetId;
    if (
      !requestedAssetId ||
      token === handledRequest.current ||
      !assets.some((asset) => asset.id === requestedAssetId)
    )
      return;
    handledRequest.current = token;
    setSelectedId(requestedAssetId);
    panel.current?.scrollIntoView({ block: "nearest" });
  }, [requestedAssetId, requestToken, assets]);
  const selected =
    assets.find((asset) => asset.id === selectedId) ??
    assets.find((asset) => asset.mediaType.startsWith("image/")) ??
    assets[0];
  useEffect(() => {
    if (active && selected) selectionListener.current?.(selected.id);
  }, [active, selected?.id]);
  const [text, setText] = useState<{
    assetId: string;
    body: string;
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    if (!selected?.mediaType.startsWith("text/")) return;
    let cancelled = false;
    void window.eve
      .assetText(selected.taskId, selected.id)
      .then((body) => {
        if (!cancelled)
          setText({
            assetId: selected.id,
            body: body.slice(0, PREVIEW_CHARACTERS),
            truncated: body.length > PREVIEW_CHARACTERS,
          });
      })
      .catch((error: Error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.url, selected?.mediaType]);
  if (!selected) return null;
  const isImage = selected.mediaType.startsWith("image/");
  return (
    <aside
      ref={panel}
      className="assets-panel"
      aria-label="Material in this space"
    >
      <div className="asset-preview">
        {isImage ? (
          <figure className="photo-artifact">
            <img
              src={selected.url}
              alt={selected.title}
              onError={() => setError("This saved image could not be opened.")}
            />
            <figcaption className="asset-caption">
              <span>
                <ImageIcon size={13} />
                REFERENCE IMAGE
              </span>
              <strong>{selected.title}</strong>
            </figcaption>
          </figure>
        ) : (
          <div className="text-artifact">
            <div className="asset-text-heading">
              <FileText size={17} />
              <strong>{selected.title}</strong>
              <span>Read-only reference</span>
            </div>
            {text?.assetId === selected.id ? (
              <>
                <pre>{text.body || "This reference is empty."}</pre>
                {text.truncated && (
                  <p className="asset-preview-limit">
                    Showing the first 200,000 characters. Your complete original
                    is preserved.
                  </p>
                )}
              </>
            ) : (
              !error && (
                <p className="asset-loading" role="status">
                  Opening your reference…
                </p>
              )
            )}
          </div>
        )}
        {error && (
          <p className="asset-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {assets.length > 1 && (
        <div
          className="material-picker"
          role="group"
          aria-label="Choose material"
        >
          {assets.map((asset) => (
            <button
              key={asset.id}
              className={asset.id === selected.id ? "active" : ""}
              aria-pressed={asset.id === selected.id}
              onClick={() => setSelectedId(asset.id)}
            >
              {asset.mediaType.startsWith("image/") ? (
                <ImageIcon size={14} />
              ) : (
                <FileText size={14} />
              )}
              <span>{asset.title}</span>
            </button>
          ))}
        </div>
      )}
      <details className="asset-provenance">
        <summary>About this material</summary>
        <p>{selected.provenance.attribution}</p>
        <p>{selected.provenance.rights}</p>
        <small>
          Saved copy ·{" "}
          {new Intl.NumberFormat(undefined, {
            maximumFractionDigits: 1,
          }).format(selected.byteLength / 1024)}{" "}
          KB · Your original stays unchanged.
        </small>
      </details>
    </aside>
  );
}
