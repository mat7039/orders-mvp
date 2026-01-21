import os
import re
from typing import Any, Dict, List, Optional, Tuple

import pyodbc
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse


def env(name: str, default: Optional[str] = None) -> str:
    v = os.getenv(name, default)
    if v is None:
        raise RuntimeError(f"Missing required env: {name}")
    return v


MSSQL_SERVER = env("MSSQL_SERVER")
MSSQL_PORT = env("MSSQL_PORT", "1433")
MSSQL_DB = env("MSSQL_DB")
MSSQL_USER = env("MSSQL_USER")
MSSQL_PASSWORD = env("MSSQL_PASSWORD")
MSSQL_TABLE = env("MSSQL_TABLE", "dbo.krakowiakZamowienian8n")
MSSQL_PK = env("MSSQL_PK", "Id")

SOURCEQUOTE_COLUMN = env("SOURCEQUOTE_COLUMN", "sourceQuote")
PDF_URL_COLUMN = env("PDF_URL_COLUMN", "pdf_web_url")
STATUS_COLUMN = env("STATUS_COLUMN", "Status")
CLIENT_COLUMN = env("CLIENT_COLUMN", "Klient")

CORS_ALLOW_ORIGINS = env("CORS_ALLOW_ORIGINS", "*")
PDF_MAX_PAGES_SCAN = int(env("PDF_MAX_PAGES_SCAN", "50"))  # used by UI; API returns it in /meta


def build_conn_str() -> str:
    # Encrypt/TrustServerCertificate are pragmatic defaults for on-prem MVP.
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
    return pyodbc.connect(build_conn_str())


IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_schema_table(fully_qualified: str) -> Tuple[str, str]:
    # supports "dbo.Table" or "Table"
    if "." in fully_qualified:
        schema, table = fully_qualified.split(".", 1)
    else:
        schema, table = "dbo", fully_qualified
    return schema, table


def safe_ident(name: str) -> str:
    # allow [Id] etc; but we validate raw names and quote with brackets.
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


def validate_config_columns(existing_cols: List[str]) -> Dict[str, bool]:
    s = set(existing_cols)
    return {
        "has_pk": MSSQL_PK in s,
        "has_sourceQuote": SOURCEQUOTE_COLUMN in s,
        "has_pdfUrl": PDF_URL_COLUMN in s,
        "has_status": STATUS_COLUMN in s,
        "has_client": CLIENT_COLUMN in s,
    }


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
        # contains search (case depends on collation)
        where.append(f"{safe_ident(CLIENT_COLUMN)} LIKE ?")
        params.append(f"%{klient}%")

    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    offset = (page - 1) * page_size

    # total count
    count_sql = f"SELECT COUNT(1) AS cnt FROM {table_sql}{where_sql};"

    # paged query
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


def candidate_download_urls(url: str) -> List[str]:
    # Try original + common "force download" variants.
    cands = [url]

    if "download=1" not in url:
        if "?" in url:
            cands.append(url + "&download=1")
        else:
            cands.append(url + "?download=1")

    # Some share links work better with direct download query:
    if "onedrive.live.com" in url and "download=1" not in url:
        if "?" in url:
            cands.append(url + "&download=1")
        else:
            cands.append(url + "?download=1")

    # dedupe preserving order
    out = []
    seen = set()
    for u in cands:
        if u not in seen:
            out.append(u)
            seen.add(u)
    return out


async def fetch_pdf_stream(url: str):
    timeout = httpx.Timeout(60.0, connect=20.0)
    headers = {"User-Agent": "orders-mvp/1.0"}

    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, headers=headers) as client:
        last_error = None
        for u in candidate_download_urls(url):
            try:
                r = await client.get(u)
                # If it returns HTML, it’s probably a landing page / auth gate.
                ctype = (r.headers.get("content-type") or "").lower()

                # Quick signature check (PDF starts with %PDF)
                first = r.content[:4] if r.content else b""
                is_pdf = ("application/pdf" in ctype) or (first == b"%PDF")

                if r.status_code >= 400:
                    last_error = f"HTTP {r.status_code}"
                    continue

                if not is_pdf:
                    last_error = f"Not a PDF (content-type={ctype or 'unknown'})"
                    continue

                # stream bytes
                async def gen():
                    yield r.content  # content is already buffered by httpx here
                return gen, r.headers

            except Exception as e:
                last_error = str(e)
                continue

        raise HTTPException(status_code=502, detail=f"Could not fetch PDF from url. Last error: {last_error}")


@app.get("/pdf")
async def pdf_proxy(url: str = Query(..., min_length=8)):
    gen, headers = await fetch_pdf_stream(url)

    resp_headers = {}
    # keep filename if present
    if "content-disposition" in headers:
        resp_headers["Content-Disposition"] = headers["content-disposition"]
    resp_headers["Cache-Control"] = "no-store"

    return StreamingResponse(gen(), media_type="application/pdf", headers=resp_headers)
