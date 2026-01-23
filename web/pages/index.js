import React, { useEffect, useMemo, useRef, useState } from "react";

function getApiBase() {
  // 1) jeśli jednak masz NEXT_PUBLIC_API_URL i działa – użyj
  const envApi = process.env.NEXT_PUBLIC_API_URL;
  if (envApi && envApi.startsWith("http")) return envApi;

  // 2) runtime fallback: ten sam host co UI, ale port API
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:40098`;
  }

  // SSR fallback (nie powinno być użyte)
  return "http://localhost:8000";
}

const API = getApiBase();


function normChar(ch) {
  const map = {
    "–": "-",
    "—": "-",
    "“": '"',
    "”": '"',
    "„": '"',
    "’": "'",
    "‘": "'",
  };
  return map[ch] || ch;
}

function normalizeText(s) {
  if (!s) return "";
  return s
    .split("")
    .map(normChar)
    .join("")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Buduje:
 * - normStr: znormalizowany string (lower, single spaces)
 * - map: normIndex -> spanIdx
 * MVP: highlightujemy całe spany, nie dokładny zakres znaków.
 */
function buildNormalizedWithSpanMap(spanTexts) {
  let norm = "";
  const map = []; // norm char index -> spanIdx
  let prevWasSpace = true;

  for (let i = 0; i < spanTexts.length; i++) {
    const raw = spanTexts[i] || "";
    for (let j = 0; j < raw.length; j++) {
      let ch = normChar(raw[j]).toLowerCase();
      const isSpace = /\s/.test(ch);

      if (isSpace) {
        if (!prevWasSpace) {
          norm += " ";
          map.push(i);
          prevWasSpace = true;
        }
      } else {
        norm += ch;
        map.push(i);
        prevWasSpace = false;
      }
    }
    // separator między spanami
    if (!prevWasSpace) {
      norm += " ";
      map.push(i);
      prevWasSpace = true;
    }
  }

  norm = norm.trimEnd();
  while (map.length > norm.length) map.pop();

  return { normStr: norm, map };
}

export default function Home() {
  const [meta, setMeta] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);

  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);

  const [statusFilter, setStatusFilter] = useState("");
  const [klientFilter, setKlientFilter] = useState("");

  const [selected, setSelected] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(false);

  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [highlightSpanIndexes, setHighlightSpanIndexes] = useState([]);
  const [pdfMessage, setPdfMessage] = useState("");

  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);

  // pdf.js ładowany dynamicznie (żeby next build nie wywalał SSR)
  const pdfjsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === "undefined") return;
      const mod = await import("pdfjs-dist/legacy/build/pdf");
      if (cancelled) return;

      mod.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${mod.version}/pdf.worker.min.js`;
      pdfjsRef.current = mod;
    })().catch((e) => {
      console.error("Failed to load pdfjs", e);
      setPdfMessage("Nie udało się załadować pdf.js (sprawdź logi przeglądarki).");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const pk = useMemo(() => meta?.pk || "Id", [meta]);

  async function loadMeta() {
    const r = await fetch(`${API}/meta`);
    if (!r.ok) throw new Error("meta failed");
    const j = await r.json();
    setMeta(j);
  }

  async function loadList() {
    setLoadingList(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      if (statusFilter) params.set("status", statusFilter);
      if (klientFilter) params.set("klient", klientFilter);

      const r = await fetch(`${API}/orders?${params.toString()}`);
      const j = await r.json();
      setItems(j.items || []);
      setTotal(j.total || 0);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    loadMeta().catch((e) => console.error(e));
  }, []);

  useEffect(() => {
    loadList().catch((e) => console.error(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter, klientFilter]);

  async function updateStatus(id, status) {
    const r = await fetch(`${API}/orders/${id}/status?status=${encodeURIComponent(status)}`, {
      method: "POST",
    });
    if (!r.ok) {
      alert("Nie udało się zmienić statusu");
      return;
    }
    await loadList();
    if (selected && selected[pk] === id) {
      setSelected({ ...selected, Status: status });
    }
  }

  function pickField(row, candidates) {
    for (const k of candidates) {
      if (row && row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
    }
    return null;
  }

async function onSelect(row) {
  setSelected(row);
  setPdfMessage("");
  setHighlightSpanIndexes([]);
  setPageNumber(1);
  setPdfDoc(null);

  const pdfjsLib = pdfjsRef.current;
  if (!pdfjsLib) {
    setPdfMessage("PDF.js jeszcze się ładuje — spróbuj ponownie za sekundę.");
    return;
  }

  const oneDriveId = pickField(row, ["onedriveId", "onedrive_id", "OneDriveId"]);
  const pdfUrl = pickField(row, ["pdfWebUrl", "pdf_web_url", "pdfUrl", "PDF_URL"]);
  const quote = pickField(row, ["sourceQuote", "source_quote", "SourceQuote", "SOURCEQUOTE"]);

  let proxied = null;
  if (oneDriveId) {
    proxied = `${API}/pdf?id=${encodeURIComponent(oneDriveId)}`;
  } else if (pdfUrl) {
    proxied = `${API}/pdf?url=${encodeURIComponent(pdfUrl)}`; // fallback
  } else {
    setPdfMessage("Brak onedriveId i brak URL do PDF w rekordzie.");
    return;
  }

  setLoadingPdf(true);
  try {
    const doc = await pdfjsLib
  .getDocument({
    url: proxied,
    disableRange: true,
    disableStream: true,
  })
  .promise;
    setPdfDoc(doc);

    if (!quote) {
      setPdfMessage("Brak sourceQuote — pokazuję PDF bez podświetlenia.");
      setPageNumber(1);
      return;
    }

    const maxPages = Math.min(doc.numPages, meta?.pdf_max_pages_scan || 50);
    const target = normalizeText(quote);

    let found = false;
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const textContent = await page.getTextContent();
      const spans = textContent.items.map((it) => it.str || "");

      const { normStr, map } = buildNormalizedWithSpanMap(spans);
      const idx = normStr.indexOf(target);

      if (idx >= 0) {
        const start = idx;
        const end = idx + target.length - 1;
        const spanSet = new Set();
        for (let k = start; k <= end && k < map.length; k++) spanSet.add(map[k]);
        setHighlightSpanIndexes(Array.from(spanSet.values()));
        setPageNumber(p);
        setPdfMessage(`Znaleziono cytat na stronie ${p}.`);
        found = true;
        break;
      }
    }

    if (!found) {
      setPdfMessage(`Nie znaleziono cytatu w limicie ${meta?.pdf_max_pages_scan || 50} stron.`);
      setPageNumber(1);
    }
  } catch (e) {
    console.error(e);
    setPdfMessage("Nie udało się załadować PDF (proxy/OneDrive/format). Sprawdź logi API.");
  } finally {
    setLoadingPdf(false);
  }
}


  async function renderPage() {
    if (!pdfDoc) return;

    const pdfjsLib = pdfjsRef.current;
    if (!pdfjsLib) return;

    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.35 });

    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    textLayerDiv.innerHTML = "";
    textLayerDiv.style.position = "absolute";
    textLayerDiv.style.left = "0";
    textLayerDiv.style.top = "0";
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;

    await page.render({ canvasContext: ctx, viewport }).promise;

    const textContent = await page.getTextContent();

    textContent.items.forEach((item, idx) => {
      const span = document.createElement("span");
      span.textContent = item.str || "";
      span.style.position = "absolute";
      span.style.whiteSpace = "pre";

      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x = tx[4];
      const y = tx[5];
      const fontHeight = Math.hypot(tx[2], tx[3]);

      span.style.left = `${x}px`;
      span.style.top = `${y - fontHeight}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.transformOrigin = "0 0";

      if (highlightSpanIndexes.includes(idx)) {
        span.style.background = "yellow";
      }

      textLayerDiv.appendChild(span);
    });
  }

  useEffect(() => {
    renderPage().catch((e) => console.error(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageNumber, highlightSpanIndexes]);

  const selectedId = selected ? selected[pk] : null;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif" }}>
      {/* LEFT: list */}
      <div style={{ width: "45%", borderRight: "1px solid #ddd", padding: 12, overflow: "auto" }}>
        <h2 style={{ marginTop: 0 }}>Orders MVP</h2>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
  API: <b>{API}</b>
</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <select
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value);
            }}
          >
            <option value="">status: (all)</option>
            <option value="new">new</option>
            <option value="confirmed">confirmed</option>
            <option value="rejected">rejected</option>
          </select>

          <input
            placeholder="Klient contains..."
            value={klientFilter}
            onChange={(e) => {
              setPage(1);
              setKlientFilter(e.target.value);
            }}
            style={{ flex: 1 }}
          />

          <button onClick={() => loadList()} disabled={loadingList}>
            {loadingList ? "Ładowanie..." : "Odśwież"}
          </button>
        </div>

        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          Razem: {total} | Strona: {page}
          <span style={{ marginLeft: 10 }}>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              ◀
            </button>
            <button onClick={() => setPage((p) => p + 1)} style={{ marginLeft: 6 }}>
              ▶
            </button>
          </span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>{pk}</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Status</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Klient</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>sourceQuote</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const id = row[pk];
              const status = row.Status ?? row.status ?? "";
              const klient = row.Klient ?? row.klient ?? "";
              const quoteText = row.sourceQuote ?? "";

              const isSel = selectedId === id;

              return (
                <tr
                  key={id}
                  onClick={() => onSelect(row)}
                  style={{ cursor: "pointer", background: isSel ? "#f3f6ff" : "transparent" }}
                >
                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{id}</td>
                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{status}</td>
                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{klient}</td>
                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6, maxWidth: 220 }}>
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
  {quoteText}
</div>

                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* RIGHT: details + PDF */}
      <div style={{ flex: 1, padding: 12, overflow: "auto" }}>
        <h3 style={{ marginTop: 0 }}>Szczegóły</h3>

        {!selected && <div>Kliknij rekord po lewej.</div>}

        {selected && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
              <b>ID:</b> {selectedId}
              <button onClick={() => updateStatus(selectedId, "new")}>new</button>
              <button onClick={() => updateStatus(selectedId, "confirmed")}>confirmed</button>
              <button onClick={() => updateStatus(selectedId, "rejected")}>rejected</button>
              {loadingPdf && <span style={{ marginLeft: 8, fontSize: 12 }}>Ładowanie PDF...</span>}
            </div>

            <div style={{ fontSize: 12, color: "#444", marginBottom: 10 }}>{pdfMessage}</div>

            <details style={{ marginBottom: 10 }}>
              <summary>JSON rekordu</summary>
              <pre style={{ fontSize: 12, background: "#fafafa", padding: 10, border: "1px solid #eee" }}>
                {JSON.stringify(selected, null, 2)}
              </pre>
            </details>

            <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setPageNumber((p) => Math.max(1, p - 1))}>Poprzednia strona</button>
              <button
                onClick={() => setPageNumber((p) => p + 1)}
                disabled={!pdfDoc || pageNumber >= (pdfDoc?.numPages || 1)}
              >
                Następna strona
              </button>
              <div style={{ fontSize: 12, color: "#666" }}>
                Strona: {pageNumber}/{pdfDoc?.numPages || "-"}
              </div>
            </div>

            <div style={{ position: "relative", border: "1px solid #ddd", display: "inline-block" }}>
              <canvas ref={canvasRef} />
              <div ref={textLayerRef} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

