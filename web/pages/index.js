import React, { useEffect, useMemo, useRef, useState } from "react";

function getApiBase() {
  const envApi = process.env.NEXT_PUBLIC_API_URL;
  if (envApi && envApi.startsWith("http")) return envApi;

  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:40098`;
  }

  return "http://localhost:8000";
}

const API = getApiBase();

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

  const [pdfMessage, setPdfMessage] = useState("");

  const canvasRef = useRef(null);

  // pdf.js (legacy) ładowany dynamicznie (żeby Next SSR nie wywalał)
  const pdfjsRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (typeof window === "undefined") return;

      const mod = await import("pdfjs-dist/legacy/build/pdf");
      if (cancelled) return;

      // worker hostowany lokalnie (public/pdf.worker.min.js)
      mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

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
    setPageNumber(1);
    setPdfDoc(null);

    const pdfjsLib = pdfjsRef.current;
    if (!pdfjsLib) {
      setPdfMessage("PDF.js jeszcze się ładuje — spróbuj ponownie za sekundę.");
      return;
    }

    const oneDriveId = pickField(row, ["onedriveId", "onedrive_id", "OneDriveId"]);
    const pdfUrl = pickField(row, ["pdfWebUrl", "pdf_web_url", "pdfUrl", "PDF_URL"]);

    let proxied = null;
    if (oneDriveId) {
      // url jako fallback dla /shares
      if (pdfUrl) proxied = `${API}/pdf?id=${encodeURIComponent(oneDriveId)}&url=${encodeURIComponent(pdfUrl)}`;
      else proxied = `${API}/pdf?id=${encodeURIComponent(oneDriveId)}`;
    } else if (pdfUrl) {
      // legacy URL mode
      proxied = `${API}/pdf?url=${encodeURIComponent(pdfUrl)}`;
    } else {
      setPdfMessage("Brak onedriveId i brak URL do PDF w rekordzie.");
      return;
    }

    setLoadingPdf(true);
    try {
      const doc = await pdfjsLib
        .getDocument({
          url: proxied,
          disableRange: false,
          disableStream: false,
        })
        .promise;

      setPdfDoc(doc);
      setPdfMessage("PDF załadowany.");
      setPageNumber(1);
    } catch (e) {
      console.error(e);
      setPdfMessage("Nie udało się załadować PDF (pdf.js/proxy/format). Sprawdź konsolę.");
    } finally {
      setLoadingPdf(false);
    }
  }

  async function renderPage() {
    try {
      if (!pdfDoc) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const page = await pdfDoc.getPage(pageNumber);

      // hiDPI canvas render
      const scale = 1.35;
      const viewport = page.getViewport({ scale });
      const outputScale =
        typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;

      const ctx = canvas.getContext("2d");
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      console.error("renderPage failed", e);
      setPdfMessage("renderPage failed: " + (e?.message || String(e)));
    }
  }

  useEffect(() => {
    renderPage().catch((e) => console.error(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageNumber]);

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
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>NaszIndeks</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>NazwaKlienta</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>IloscKlienta</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>CenaOfertowa</th>
            </tr>
          </thead>

          <tbody>
            {items.map((row) => {
              const id = row[pk];
              const status = row.Status ?? row.status ?? "";
              const klient = row.Klient ?? row.klient ?? "";

              const finalIndeks = row.FinalIndeks ?? row.finalIndeks ?? "";
              const nazwaKlienta = row.NazwaKlienta ?? row.nazwaKlienta ?? "";
              const iloscKlienta = row.IloscKlienta ?? row.iloscKlienta ?? "";
              const cena = row.CenaOfertowa ?? row.cenaOfertowa ?? "";
              const waluta = row.OfertaWaluta ?? row.ofertaWaluta ?? "";
              const cenaOfertowa = `${cena}${waluta ? " " + waluta : ""}`;

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

                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{finalIndeks}</td>

                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6, maxWidth: 220 }}>
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {nazwaKlienta}
                    </div>
                  </td>

                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{iloscKlienta}</td>

                  <td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{cenaOfertowa}</td>
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

            <div style={{ border: "1px solid #ddd", display: "inline-block" }}>
              <canvas ref={canvasRef} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
