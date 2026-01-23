# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app

# (opcjonalnie) czasem potrzebne dla niektórych paczek binarnych
RUN apk add --no-cache libc6-compat

# kopiujemy również lockfile, żeby instalacje były powtarzalne
COPY package.json package-lock.json* ./

# preferuj npm ci jeśli jest package-lock.json
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi


# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Skopiuj pdf.js worker do /public/pdf.worker.min.js (lokalnie dla przeglądarki)
# Bez postinstall, z fallbackami na różne layouty pdfjs-dist.
RUN node - <<'NODE'
const fs = require('fs');
const path = require('path');

const candidates = [
  // najczęstsze
  'pdfjs-dist/build/pdf.worker.min.js',
  'pdfjs-dist/legacy/build/pdf.worker.min.js',
  // czasem występują warianty .mjs
  'pdfjs-dist/build/pdf.worker.min.mjs',
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
];

let src = null;
for (const c of candidates) {
  try { src = require.resolve(c); break; } catch (e) {}
}

if (!src) {
  console.error('ERROR: pdf.js worker not found in pdfjs-dist.');
  console.error('Checked candidates:', candidates);
  // pokaż co faktycznie jest w node_modules/pdfjs-dist (pomaga w debug)
  try {
    const pdfjsDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
    console.error('pdfjs-dist dir exists:', fs.existsSync(pdfjsDir));
    if (fs.existsSync(pdfjsDir)) {
      const walk = (dir, depth=0) => {
        if (depth > 3) return;
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          const st = fs.statSync(p);
          if (st.isDirectory()) walk(p, depth+1);
          else if (name.includes('worker') && (name.endsWith('.js') || name.endsWith('.mjs'))) {
            console.error('found:', path.relative(process.cwd(), p));
          }
        }
      };
      walk(pdfjsDir);
    }
  } catch (_) {}
  process.exit(1);
}

fs.mkdirSync('public', { recursive: true });
fs.copyFileSync(src, path.join('public', 'pdf.worker.min.js'));
console.log('OK: copied worker from', src, 'to public/pdf.worker.min.js');
NODE

# Build Next.js (z diagnostyką npm logów jeśli padnie)
RUN npm run build || (echo "---- npm logs ----" && ls -la /root/.npm/_logs || true && cat /root/.npm/_logs/*.log || true && echo "---- end npm logs ----" && exit 1)


# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache libc6-compat

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
CMD ["npm", "run", "start"]


