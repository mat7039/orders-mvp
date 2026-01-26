import os
import re
from typing import Any, Dict, List, Optional, Tuple
import time
from urllib.parse import quote
import base64
import io
from openai import OpenAI
import pyodbc
import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse


def env(name: str, default: Optional[str] = None) -> str:
    v = os.getenv(name, default)
    if v is None:
        raise RuntimeError(f"Missing required env: {name}")
    return v


# --------------------------
# Config (DB, columns, CORS)
# --------------------------
MSSQL_SERVER = env("MSSQL_SERVER")
MSSQL_PORT = env("MSSQL_PORT", "1433")
MSSQL_DB = env("MSSQL_DB")
MSSQL_USER = env("MSSQL_USER")
MSSQL_PASSWORD = env("MSSQL_PASSWORD")
MSSQL_TABLE = env("MSSQL_TABLE", "dbo.krakowiakZamowienian8n")
MSSQL_PK = env("MSSQL_PK", "Id")

SOURCEQUOTE_COLUMN = env("SOURCEQUOTE_COLUMN", "sourceQuote")
PDF_URL_COLUMN = env("PDF_URL_COLUMN", "pdfWebUrl")
STATUS_COLUMN = env("STATUS_COLUMN", "Status")
CLIENT_COLUMN = env("CLIENT_COLUMN", "Klient")

CORS_ALLOW_ORIGINS = env("CORS_ALLOW_ORIGINS", "*")
PDF_MAX_PAGES_SCAN = int(env("PDF_MAX_PAGES_SCAN", "50"))


def build_conn_str() -> str:
    return (
        "DRIVER={ODBC Driver 18 for SQL Server};"
        f"SERVER={MSSQL_SERVER},{MSSQL_PORT};"
        f"DATABASE={MSSQL_DB};"
        f"UID={MSSQL_USER};"
        f"PWD={MSSQL_PASSWORD};"
        "Encrypt=yes;"
        "TrustServerCertificate=yes;"
        "Connection Timeout=30;"
    )


def get_conn():
    try:
        return pyodbc.connect(build_conn_str())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DB connect failed: {e}")


IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_schema_table(fully_qualified: str) -> Tuple[str, str]:
    if "." in fully_qualified:
        schema, table = fully_qualified.split(".", 1)
    else:
        schema, table = "dbo", fully_qualified
    return schema, table


def safe_ident(name: str) -> str:
    if not IDENT_RE.match(name):
        raise HTTPException(status_code=400, detail=f"Invalid identifier: {name}")
    return f"[{name}]"


def safe_table(fully_qualified: str) -> str:
    schema, table = parse_schema_table(fully_qualified)
    if not IDENT_RE.match(schema) or not IDENT_RE.match(table):
        raise HTTPException(status_code=400, detail=f"Invalid table name: {fully_qualified}")
    return f"[{schema}].[{table}]"


def fetch_table_columns() -> List[str]:
    schema, table = parse_schema_table(MSSQL_TABLE)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
            """,
            (schema, table),
        )
        return [row[0] for row in cur.fetchall()]


def row_to_dict(cursor, row) -> Dict[str, Any]:
    columns = [col[0] for col in cursor.description]
    return {columns[i]: row[i] for i in range(len(columns))}


def validate_config_columns(existing_cols: List[str]) -> Dict[str, bool]:
    s = set(existing_cols)
    return {
        "has_pk": MSSQL_PK in s,
        "has_sourceQuote": SOURCEQUOTE_COLUMN in s,
        "has_pdfUrl": PDF_URL_COLUMN in s,
        "has_status": STATUS_COLUMN in s,
        "has_client": CLIENT_COLUMN in s,
    }


# -------------
# FastAPI app
# -------------
app = FastAPI(title="Orders MVP API")

origins = [o.strip() for o in CORS_ALLOW_ORIGINS.split(",")] if CORS_ALLOW_ORIGINS != "*" else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/meta")
def meta():
    cols = fetch_table_columns()
    return {
        "table": MSSQL_TABLE,
        "pk": MSSQL_PK,
        "columns": cols,
        "configured_columns": {
            "sourceQuote": SOURCEQUOTE_COLUMN,
            "pdfUrl": PDF_URL_COLUMN,
            "status": STATUS_COLUMN,
            "client": CLIENT_COLUMN,
        },
        "pdf_max_pages_scan": PDF_MAX_PAGES_SCAN,
    }


@app.get("/diag")
def diag():
    cols = fetch_table_columns()
    flags = validate_config_columns(cols)
    table_sql = safe_table(MSSQL_TABLE)

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT DB_NAME()")
        current_db = cur.fetchone()[0]

        cur.execute(f"SELECT COUNT(1) FROM {table_sql};")
        cnt = int(cur.fetchone()[0])

    return {
        "mssql_server": MSSQL_SERVER,
        "mssql_port": MSSQL_PORT,
        "mssql_user": MSSQL_USER,
        "configured_db": MSSQL_DB,
        "current_db": current_db,
        "table": MSSQL_TABLE,
        "pk": MSSQL_PK,
        "count": cnt,
        "column_flags": flags,
    }


@app.get("/diag_graph")
def diag_graph():
    drive_id = os.getenv("MS_DRIVE_ID") or ""
    tenant_id = os.getenv("MS_TENANT_ID") or ""
    client_id = os.getenv("MS_CLIENT_ID") or ""
    client_secret = os.getenv("MS_CLIENT_SECRET") or ""
    return {
        "has_ms_drive_id": bool(drive_id.strip()),
        "ms_drive_id_prefix": (drive_id[:6] + "...") if drive_id.strip() else None,
        "has_ms_tenant_id": bool(tenant_id.strip()),
        "ms_tenant_id_prefix": (tenant_id[:6] + "...") if tenant_id.strip() else None,
        "has_ms_client_id": bool(client_id.strip()),
        "ms_client_id_prefix": (client_id[:6] + "...") if client_id.strip() else None,
        "has_ms_client_secret": bool(client_secret.strip()),
        "ms_client_secret_prefix": (client_secret[:3] + "...") if client_secret.strip() else None,
    }


# --------------------------
# Orders endpoints
# --------------------------
@app.get("/orders")
def list_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    status: Optional[str] = Query(None),
    klient: Optional[str] = Query(None),
):
    cols = fetch_table_columns()
    flags = validate_config_columns(cols)

    if not flags["has_pk"]:
        raise HTTPException(status_code=500, detail=f"PK column '{MSSQL_PK}' not found in table")

    table_sql = safe_table(MSSQL_TABLE)
    pk_sql = safe_ident(MSSQL_PK)

    where = []
    params: List[Any] = []

    if status and flags["has_status"]:
        where.append(f"{safe_ident(STATUS_COLUMN)} = ?")
        params.append(status)

    if klient and flags["has_client"]:
        where.append(f"{safe_ident(CLIENT_COLUMN)} LIKE ?")
        params.append(f"%{klient}%")

    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    offset = (page - 1) * page_size

    count_sql = f"SELECT COUNT(1) AS cnt FROM {table_sql}{where_sql};"
    items_sql = (
        f"SELECT * FROM {table_sql}{where_sql} "
        f"ORDER BY {pk_sql} DESC "
        f"OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;"
    )

    with get_conn() as conn:
        cur = conn.cursor()

        cur.execute(count_sql, params)
        total = int(cur.fetchone()[0])

        cur.execute(items_sql, params + [offset, page_size])
        rows = cur.fetchall()
        items = [row_to_dict(cur, r) for r in rows]

    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "items": items,
        "notes": {
            "status_filter_applied": bool(status and flags["has_status"]),
            "client_filter_applied": bool(klient and flags["has_client"]),
            "missing_columns_ignored": [k for k, v in flags.items() if k.startswith("has_") and not v],
        },
    }


@app.get("/orders/{id}")
def get_order(id: int):
    cols = fetch_table_columns()
    flags = validate_config_columns(cols)

    if not flags["has_pk"]:
        raise HTTPException(status_code=500, detail=f"PK column '{MSSQL_PK}' not found in table")

    table_sql = safe_table(MSSQL_TABLE)
    pk_sql = safe_ident(MSSQL_PK)

    sql = f"SELECT * FROM {table_sql} WHERE {pk_sql} = ?;"
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql, (id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        return row_to_dict(cur, row)


@app.post("/orders/{id}/status")
def set_status(id: int, status: str = Query(..., pattern="^(new|confirmed|rejected)$")):
    cols = fetch_table_columns()
    flags = validate_config_columns(cols)

    if not flags["has_pk"]:
        raise HTTPException(status_code=500, detail=f"PK column '{MSSQL_PK}' not found in table")
    if not flags["has_status"]:
        raise HTTPException(
            status_code=500,
            detail=f"Status column '{STATUS_COLUMN}' not found in table (add it or change STATUS_COLUMN env)",
        )

    table_sql = safe_table(MSSQL_TABLE)
    pk_sql = safe_ident(MSSQL_PK)
    status_sql = safe_ident(STATUS_COLUMN)

    sql = f"UPDATE {table_sql} SET {status_sql} = ? WHERE {pk_sql} = ?;"
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql, (status, id))
        conn.commit()

        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Not found")

    return {"ok": True, "id": id, "status": status}


# --------------------------
# Microsoft Graph helpers
# --------------------------
_graph_token = {"value": None, "exp": 0}

_openai_client = None

def get_openai_client() -> OpenAI:
    global _openai_client
    if _openai_client is None:
        # OPENAI_API_KEY musi być w env
        _openai_client = OpenAI()
    return _openai_client

async def graph_token() -> str:
    tenant_id = os.getenv("MS_TENANT_ID")
    client_id = os.getenv("MS_CLIENT_ID")
    client_secret = os.getenv("MS_CLIENT_SECRET")

    if not (tenant_id and client_id and client_secret):
        raise HTTPException(
            status_code=500,
            detail="Missing Graph env: MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET",
        )

    now = int(time.time())
    if _graph_token["value"] and now < _graph_token["exp"] - 60:
        return _graph_token["value"]

    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(token_url, data=data)

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Graph token failed: HTTP {r.status_code} {r.text[:200]}")

    j = r.json()
    _graph_token["value"] = j["access_token"]
    _graph_token["exp"] = now + int(j.get("expires_in", 3600))
    return _graph_token["value"]


def to_graph_share_id(raw_url: str) -> str:
    # Graph expects: u!{base64url(url)}
    b = raw_url.encode("utf-8")
    s = base64.b64encode(b).decode("ascii")
    s = s.replace("+", "-").replace("/", "_").rstrip("=")
    return f"u!{s}"


async def fetch_pdf_stream_graph_item(item_id: str, range_header: Optional[str] = None):
    drive_id = os.getenv("MS_DRIVE_ID")
    if not drive_id:
        raise HTTPException(status_code=500, detail="Missing Graph env: MS_DRIVE_ID")

    token = await graph_token()

    url = f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{quote(item_id)}/content"

    req_headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "orders-mvp/1.0",
    }
    if range_header:
        req_headers["Range"] = range_header

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(120.0, connect=20.0),
    ) as client:
        r = await client.get(url, headers=req_headers)

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Graph download failed: HTTP {r.status_code} {r.text[:200]}")

    ctype = (r.headers.get("content-type") or "").lower()
    first = r.content[:4] if r.content else b""
    is_pdf = ("application/pdf" in ctype) or (first == b"%PDF")
    if not is_pdf:
        raise HTTPException(status_code=502, detail=f"Graph returned non-PDF (content-type={ctype or 'unknown'})")

    async def gen():
        yield r.content

    return gen, r.headers, r.status_code


async def fetch_pdf_stream_graph_share(pdf_web_url: str, range_header: Optional[str] = None):
    token = await graph_token()

    share_id = to_graph_share_id(pdf_web_url)
    url = f"https://graph.microsoft.com/v1.0/shares/{share_id}/driveItem/content"

    req_headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "orders-mvp/1.0",
    }
    if range_header:
        req_headers["Range"] = range_header

async def fetch_pdf_bytes_graph(item_id: str, pdf_web_url: Optional[str] = None) -> bytes:
    """
    Pobiera pełny PDF (bytes) przez Graph.
    1) /drives/{driveId}/items/{itemId}/content
    2) jeśli itemNotFound i mamy pdf_web_url -> /shares/u!{base64}/driveItem/content
    """
    drive_id = os.getenv("MS_DRIVE_ID")
    if not drive_id:
        raise HTTPException(status_code=500, detail="Missing Graph env: MS_DRIVE_ID")

    token = await graph_token()

    async def _get(url: str) -> httpx.Response:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(180.0, connect=20.0),
        ) as client:
            return await client.get(url, headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "orders-mvp/1.0",
            })

    # 1) itemId direct
    url1 = f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{quote(item_id)}/content"
    r = await _get(url1)

    # fallback na shares
    if r.status_code == 404 and pdf_web_url:
        share_id = to_graph_share_id(pdf_web_url)
        url2 = f"https://graph.microsoft.com/v1.0/shares/{share_id}/driveItem/content"
        r = await _get(url2)

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Graph download failed: HTTP {r.status_code} {r.text[:200]}")

    ctype = (r.headers.get("content-type") or "").lower()
    first = r.content[:4] if r.content else b""
    is_pdf = ("application/pdf" in ctype) or (first == b"%PDF")
    if not is_pdf:
        raise HTTPException(status_code=502, detail=f"Graph returned non-PDF (content-type={ctype or 'unknown'})")

    return r.content
    
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(120.0, connect=20.0),
    ) as client:
        r = await client.get(url, headers=req_headers)

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Graph share download failed: HTTP {r.status_code} {r.text[:200]}")

    ctype = (r.headers.get("content-type") or "").lower()
    first = r.content[:4] if r.content else b""
    is_pdf = ("application/pdf" in ctype) or (first == b"%PDF")
    if not is_pdf:
        raise HTTPException(status_code=502, detail=f"Graph returned non-PDF (content-type={ctype or 'unknown'})")

    async def gen():
        yield r.content

    return gen, r.headers, r.status_code


# --------------------------
# Legacy direct-url fetch (fallback)
# --------------------------
def candidate_download_urls(url: str) -> List[str]:
    cands = [url]

    if "download=1" not in url:
        if "?" in url:
            cands.append(url + "&download=1")
        else:
            cands.append(url + "?download=1")

    out = []
    seen = set()
    for u in cands:
        if u not in seen:
            out.append(u)
            seen.add(u)
    return out


async def fetch_pdf_stream(url: str, range_header: Optional[str] = None):
    timeout = httpx.Timeout(60.0, connect=20.0)

    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
        last_error = None
        for u in candidate_download_urls(url):
            try:
                req_headers = {"User-Agent": "orders-mvp/1.0"}
                if range_header:
                    req_headers["Range"] = range_header

                r = await client.get(u, headers=req_headers)

                ctype = (r.headers.get("content-type") or "").lower()
                first = r.content[:4] if r.content else b""
                is_pdf = ("application/pdf" in ctype) or (first == b"%PDF")

                if r.status_code >= 400:
                    last_error = f"HTTP {r.status_code}"
                    continue

                if not is_pdf:
                    last_error = f"Not a PDF (content-type={ctype or 'unknown'})"
                    continue

                async def gen():
                    yield r.content

                return gen, r.headers, r.status_code

            except Exception as e:
                last_error = str(e)
                continue

        raise HTTPException(status_code=502, detail=f"Could not fetch PDF from url. Last error: {last_error}")


# --------------------------
# /pdf endpoint (Graph + Range + fallbacks)
# --------------------------
@app.get("/pdf")
async def pdf_proxy(
    request: Request,
    url: Optional[str] = Query(None),
    id: Optional[str] = Query(None),
):
    range_header = request.headers.get("range")

    def build_response(gen, headers: Dict[str, str], upstream_status: int):
        resp_headers = {
            "Cache-Control": "no-store",
            "Accept-Ranges": "bytes",
        }
        # Forward a few useful headers if present
        if "content-disposition" in headers:
            resp_headers["Content-Disposition"] = headers["content-disposition"]
        if "content-range" in headers:
            resp_headers["Content-Range"] = headers["content-range"]
        if "content-length" in headers:
            resp_headers["Content-Length"] = headers["content-length"]

        status_code = 206 if range_header and upstream_status == 206 else 200
        return StreamingResponse(gen(), media_type="application/pdf", headers=resp_headers, status_code=status_code)

    # Prefer Graph by item id (secure)
    if id:
        # 1) try driveId + itemId
        try:
            gen, headers, upstream_status = await fetch_pdf_stream_graph_item(id, range_header=range_header)
            return build_response(gen, headers, upstream_status)
        except HTTPException as e:
            # If it's 404 itemNotFound from Graph, and we have a webUrl, try shares-based fallback
            msg = str(e.detail) if hasattr(e, "detail") else ""
            is_item_not_found = "itemNotFound" in msg or "HTTP 404" in msg

            if is_item_not_found and url:
                gen2, headers2, upstream_status2 = await fetch_pdf_stream_graph_share(url, range_header=range_header)
                return build_response(gen2, headers2, upstream_status2)

            raise

    # Fallback: legacy URL mode (may 403 on SharePoint if not Graph)
    if not url:
        raise HTTPException(status_code=400, detail="Provide either ?id=... or ?url=...")

    gen, headers, upstream_status = await fetch_pdf_stream(url, range_header=range_header)
    return build_response(gen, headers, upstream_status)


from pydantic import BaseModel, Field

class MatchRequest(BaseModel):
    id: str = Field(..., description="OneDrive item id")
    url: Optional[str] = Field(None, description="pdfWebUrl (opcjonalnie, pomaga w fallback /shares)")
    sourceQuote: str = Field(..., description="Tekst źródłowy z rekordu")

class MatchResponse(BaseModel):
    page: int
    anchors: List[str]
    confidence: float
    reason: str

@app.post("/match_pdf", response_model=MatchResponse)
async def match_pdf(req: MatchRequest):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Missing env: OPENAI_API_KEY")

    model = os.getenv("OPENAI_MODEL", "gpt-5")

    # 1) pobierz pdf bytes (Graph)
    pdf_bytes = await fetch_pdf_bytes_graph(req.id, pdf_web_url=req.url)

    # OpenAI PDF input limit per request: 50MB total across files (dla jednego requestu) :contentReference[oaicite:1]{index=1}
    if len(pdf_bytes) > 45 * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"PDF too large for model input: {len(pdf_bytes)} bytes")

    client = get_openai_client()

    # 2) upload file jako user_data (rekomendowane do użycia jako input) :contentReference[oaicite:2]{index=2}
    file_obj = client.files.create(
        file=("doc.pdf", io.BytesIO(pdf_bytes)),
        purpose="user_data",
        # opcjonalnie auto-wygaszenie (tu 24h)
        expires_after={"anchor": "created_at", "seconds": 86400},
    )

    schema = {
        "name": "pdf_match",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "page": {"type": "integer", "minimum": 1, "description": "Page number (1-indexed) where the quote best matches"},
                "anchors": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 12,
                    "description": "Short anchor strings to highlight on that page (codes, product numbers, key words, amounts)."
                },
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "reason": {"type": "string"}
            },
            "required": ["page", "anchors", "confidence", "reason"]
        }
    }

    prompt = f"""
You are matching a record's sourceQuote to the location in a PDF document.
The sourceQuote may differ from the PDF text (different line breaks, spacing, missing/extra words).
Task:
1) Find the single best page where this quote refers to a line/item.
2) Return 5-30 short anchor strings that appear on that page and uniquely identify the item (e.g., product numbers, codes with dashes, key words, quantities, prices).
Rules:
- Output MUST follow the JSON schema.
- Page number must be 1-indexed.
- Anchors must be short (1-40 chars each) and should be present on the chosen page.
- Prefer anchors with digits/dashes (e.g., 51139009-03, 0187-200-599, 152815) and key item name words.

sourceQuote:
{req.sourceQuote}
""".strip()

    # 3) Responses API z Structured Outputs :contentReference[oaicite:3]{index=3}
    resp = client.responses.create(
        model=model,
        response_format={"type": "json_schema", "json_schema": schema},
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_file", "file_id": file_obj.id},
                    {"type": "input_text", "text": prompt},
                ],
            }
        ],
    )

    # SDK zwraca tekst JSON w output_text (bo response_format wymusza JSON)
    data = resp.output_text
    # output_text jest stringiem JSON; parsujemy
    try:
        import json
        j = json.loads(data)
    except Exception:
        raise HTTPException(status_code=502, detail=f"OpenAI returned non-JSON: {data[:200]}")

    return MatchResponse(**j)




