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
const [openGroups, setOpenGroups] = useState(() => ({}));
  const [pdfMessage, setPdfMessage] = useState("");
  const [editOpen, setEditOpen] = useState(false);
const [editSaving, setEditSaving] = useState(false);
const [editError, setEditError] = useState("");
const [editForm, setEditForm] = useState({
  Klient: "",
  FinalIndeks: "",
  NazwaKlienta: "",
  IloscKlienta: "",
  CenaOfertowa: "",
});
  const canvasRef = useRef(null);

  // pdf.js (legacy) ładowany dynamicznie (żeby Next SSR nie wywalał)
  const pdfjsRef = useRef(null);

  // =========================
  // PDF CACHE (tu dodane)
  // =========================
  // cache: key -> { doc, lastUsed }
  const pdfCacheRef = useRef(new Map());
  const MAX_PDF_CACHE = 5;

  function prunePdfCache() {
    const cache = pdfCacheRef.current;
    if (cache.size <= MAX_PDF_CACHE) return;

    let oldestKey = null;
    let oldest = Infinity;

    for (const [k, v] of cache.entries()) {
      const t = v?.lastUsed ?? 0;
      if (t < oldest) {
        oldest = t;
        oldestKey = k;
      }
    }

    if (oldestKey) cache.delete(oldestKey);
  }
  // =========================

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
async function saveEdits() {
  if (!selected) return;

  setEditSaving(true);
  setEditError("");
  try {
    // zbuduj payload (tylko pola, które chcesz wysłać)
    const payload = {
      Klient: editForm.Klient,
      FinalIndeks: editForm.FinalIndeks,
      NazwaKlienta: editForm.NazwaKlienta,
      // konwersje na liczbę jeśli chcesz:
      IloscKlienta: editForm.IloscKlienta === "" ? null : Number(editForm.IloscKlienta),
      CenaOfertowa: editForm.CenaOfertowa === "" ? null : Number(editForm.CenaOfertowa),
    };

    // usuń null-e żeby nie nadpisywać (opcjonalnie)
    Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);

    const id = selected[pk];

    const r = await fetch(`${API}/orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`PATCH failed: ${r.status} ${t}`);
    }

    const updated = await r.json();

    // zaktualizuj selected
    setSelected(updated);

    // zaktualizuj listę w pamięci (żeby od razu było w tabeli po lewej)
    setItems((prev) => prev.map((x) => (x[pk] === id ? updated : x)));

    setEditOpen(false);
  } catch (e) {
    console.error(e);
    setEditError(e?.message || String(e));
  } finally {
    setEditSaving(false);
  }
}
  function pickField(row, candidates) {
    for (const k of candidates) {
      if (row && row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
    }
    return null;
  }

  // =========================
  // PDF CACHE KEY (tu dodane)
  // =========================
  function getPdfCacheKey(row) {
    const oneDriveId = pickField(row, ["onedriveId", "onedrive_id", "OneDriveId"]);
    const pdfUrl = pickField(row, ["pdfWebUrl", "pdf_web_url", "pdfUrl", "PDF_URL"]);
    return oneDriveId ? `id:${oneDriveId}` : pdfUrl ? `url:${pdfUrl}` : null;
  }
  // =========================

  // =========================
  // onSelect z cache (już masz, tu wklejone w całości)
  // =========================
  async function onSelect(row) {
    setSelected(row);
    setPdfMessage("");
    setPageNumber(1);
    setEditOpen(false);
    setEditError("");
    setEditForm({
  Klient: row.Klient ?? row.klient ?? "",
  FinalIndeks: row.FinalIndeks ?? row.finalIndeks ?? "",
  NazwaKlienta: row.NazwaKlienta ?? row.nazwaKlienta ?? "",
  IloscKlienta: row.IloscKlienta ?? row.iloscKlienta ?? "",
  CenaOfertowa: row.CenaOfertowa ?? row.cenaOfertowa ?? "",
});
    
    const pdfjsLib = pdfjsRef.current;
    if (!pdfjsLib) {
      setPdfMessage("PDF.js jeszcze się ładuje — spróbuj ponownie za sekundę.");
      return;
    }

    const cacheKey = getPdfCacheKey(row);
    if (!cacheKey) {
      setPdfMessage("Brak onedriveId i brak URL do PDF w rekordzie.");
      return;
    }

    // 1) HIT w cache -> natychmiast
    const cached = pdfCacheRef.current.get(cacheKey);
    if (cached?.doc) {
      cached.lastUsed = Date.now();
      setPdfDoc(cached.doc);
      setPdfMessage("PDF z cache.");
      return;
    }

    // 2) MISS -> pobierz jak dotąd
    const oneDriveId = pickField(row, ["onedriveId", "onedrive_id", "OneDriveId"]);
    const pdfUrl = pickField(row, ["pdfWebUrl", "pdf_web_url", "pdfUrl", "PDF_URL"]);

    let proxied = null;
    if (oneDriveId) {
      if (pdfUrl) proxied = `${API}/pdf?id=${encodeURIComponent(oneDriveId)}&url=${encodeURIComponent(pdfUrl)}`;
      else proxied = `${API}/pdf?id=${encodeURIComponent(oneDriveId)}`;
    } else if (pdfUrl) {
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

      // zapisz do cache
      pdfCacheRef.current.set(cacheKey, { doc, lastUsed: Date.now() });
      prunePdfCache();

      setPdfDoc(doc);
      setPdfMessage("PDF załadowany (cache zapisany).");
    } catch (e) {
      console.error(e);
      setPdfMessage("Nie udało się załadować PDF (pdf.js/proxy/format). Sprawdź konsolę.");
    } finally {
      setLoadingPdf(false);
    }
  }
  // =========================

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
  function getPdfName(row) {
  // dostosuj fallbacki jeśli masz inne pole
  return (
    row.pdfFileName ??
    row.PdfFileName ??
    row.pdf_filename ??
    row.pdf ??
    "(brak pdfFileName)"
  );
}

const grouped = useMemo(() => {
  // Map<pdfName, rows[]>
  const m = new Map();
  for (const r of items) {
    const key = getPdfName(r);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(r);
  }

  // jeżeli backend już sortuje po Klient/pdfFileName/Pozycja, to kolejność w mapie będzie OK.
  // Jeśli chcesz dodatkowo sortować w obrębie grupy po Pozycja:
  for (const [k, arr] of m.entries()) {
    arr.sort((a, b) => {
      const pa = a.Pozycja ?? a.pozycja ?? 0;
      const pb = b.Pozycja ?? b.pozycja ?? 0;
      return Number(pa) - Number(pb);
    });
    m.set(k, arr);
  }

  return Array.from(m.entries()); // [ [pdfName, rows[]], ... ]
}, [items]);

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
              {/* dla usera pokazujesz Pozycja, a nie {pk} */}
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Pozycja</th>

              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Status</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>Klient</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>NaszIndeks</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>NazwaKlienta</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>IloscKlienta</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 6 }}>CenaOfertowa</th>
            </tr>
          </thead>

<tbody>
{grouped.map(([pdfName, rows]) => {
const isOpen = openGroups[pdfName] ?? false; 


return (
<React.Fragment key={pdfName}>
{/* Wiersz-nagłówek grupy */}
<tr
onClick={(e) => {
  e.stopPropagation(); // żeby klik w pozycję nie zwijał od razu nagłówka grupy
  setOpenGroups((p) => ({ ...p, [pdfName]: !(p[pdfName] ?? false) })); // toggle grupy
  onSelect(row);
}}
style={{
cursor: "pointer",
background: "#f7f7f7",
borderTop: "1px solid #eee",
}}
>
<td style={{ padding: 6, borderBottom: "1px solid #eee" }} colSpan={7}>
<span style={{ display: "inline-block", width: 18 }}>
{isOpen ? "▾" : "▸"}
</span>
<b>{pdfName}</b>
<span style={{ marginLeft: 10, color: "#666", fontSize: 12 }}>
({rows.length} pozycji)
</span>
</td>
</tr>


{/* Pozycje w grupie */}
{isOpen &&
rows.map((row) => {
const id = row[pk];
const pozycja = row.Pozycja ?? row.pozycja ?? "";
const status = row.Status ?? row.status ?? "";
const klient = row.Klient ?? row.klient ?? "";
const naszIndeks = row.FinalIndeks ?? row.finalIndeks ?? "";
const nazwaKlienta = row.NazwaKlienta ?? row.nazwaKlienta ?? "";
const iloscKlienta = row.IloscKlienta ?? row.iloscKlienta ?? "";
const cenaOfertowa = row.CenaOfertowa ?? row.cenaOfertowa ?? "";


const isSel = selectedId === id;


return (
<tr
key={id}
onClick={(e) => {
e.stopPropagation(); // żeby klik w pozycję nie zwijał grupy
// upewnij się, że grupa jest otwarta
setOpenGroups((p) => ({ ...p, [pdfName]: true }));
onSelect(row);
}}
style={{
cursor: "pointer",
background: isSel ? "#f3f6ff" : "transparent",
}}
>
<td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{pozycja}</td>
<td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{status}</td>
<td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{klient}</td>
<td style={{ borderBottom: "1px solid #f3f3f3", padding: 6 }}>{naszIndeks}</td>


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
</React.Fragment>
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
            <div style={{ marginBottom: 10, padding: 10, border: "1px solid #eee", background: "#fafafa" }}>
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <button onClick={() => setEditOpen((v) => !v)}>
      {editOpen ? "Zamknij edycję" : "Edytuj"}
    </button>
    {editSaving && <span style={{ fontSize: 12 }}>Zapisywanie...</span>}
    {editError && <span style={{ fontSize: 12, color: "crimson" }}>{editError}</span>}
  </div>

  {editOpen && (
    <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "160px 1fr", gap: 8 }}>
      <div>Klient</div>
      <input
        value={editForm.Klient}
        onChange={(e) => setEditForm((p) => ({ ...p, Klient: e.target.value }))}
      />

      <div>NaszIndeks</div>
      <input
        value={editForm.FinalIndeks}
        onChange={(e) => setEditForm((p) => ({ ...p, FinalIndeks: e.target.value }))}
      />

      <div>NazwaKlienta</div>
      <input
        value={editForm.NazwaKlienta}
        onChange={(e) => setEditForm((p) => ({ ...p, NazwaKlienta: e.target.value }))}
      />

      <div>IloscKlienta</div>
      <input
        value={editForm.IloscKlienta}
        onChange={(e) => setEditForm((p) => ({ ...p, IloscKlienta: e.target.value }))}
      />

      <div>CenaOfertowa</div>
      <input
        value={editForm.CenaOfertowa}
        onChange={(e) => setEditForm((p) => ({ ...p, CenaOfertowa: e.target.value }))}
      />

      <div />
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={saveEdits} disabled={editSaving}>
          Zapisz
        </button>
        <button
          onClick={() => {
            // reset do wartości z selected
            setEditError("");
            setEditForm({
              Klient: selected?.Klient ?? "",
              FinalIndeks: selected?.FinalIndeks ?? "",
              NazwaKlienta: selected?.NazwaKlienta ?? "",
              IloscKlienta: selected?.IloscKlienta ?? "",
              CenaOfertowa: selected?.CenaOfertowa ?? "",
            });
            setEditOpen(false);
          }}
          disabled={editSaving}
        >
          Anuluj
        </button>
      </div>
    </div>
  )}
</div>
            <details style={{ marginBottom: 10 }}>
  <summary>Szczegóły pozycji</summary>

  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 10 }}>
    <tbody>
      {[
        ["Klient", selected?.Klient ?? selected?.klient ?? ""],
        ["NaszIndeks", selected?.FinalIndeks ?? selected?.finalIndeks ?? ""],
        ["NazwaKlienta", selected?.NazwaKlienta ?? selected?.nazwaKlienta ?? ""],
        ["NumerRysunku", selected?.nrRys ?? selected?.nrRys ?? ""],
        ["Oferta", selected?.oferta ?? selected?.oferta ?? ""],
        ["DataUtworzeniaOferty", selected?.DataUtworzenia ?? selected?.DataUtworzenia ?? ""],
        ["DataWaznosciOferty", selected?.DataWaznosci ?? selected?.DataWaznosci ?? ""],
        ["IloscZOferty", selected?.IloscZOferty ?? selected?.IloscZOferty ?? ""],
        ["IloscKlienta", selected?.IloscKlienta ?? selected?.iloscKlienta ?? ""],
        ["CenaOfertowa", selected?.CenaOfertowa ?? selected?.cenaOfertowa ?? ""],
        ["pdfFileName", selected?.pdfFileName ?? selected?.PdfFileName ?? ""],
      ].map(([label, value]) => (
        <tr key={label}>
          <td style={{ width: 180, padding: 6, borderBottom: "1px solid #eee", color: "#666" }}>{label}</td>
          <td style={{ padding: 6, borderBottom: "1px solid #eee" }}>
            {value === null || value === undefined || value === "" ? <span style={{ color: "#999" }}>—</span> : String(value)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
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
