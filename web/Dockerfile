# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app

# kopiujemy również lockfile, żeby instalacje były powtarzalne
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund


# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# (opcjonalnie) jeśli Next build wywala przez eslint, dodaj next.config.js (patrz niżej)
RUN npm run build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
CMD ["npm", "run", "start"]

