FROM node:18-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Upewnij się, że public/ istnieje + skopiuj pdf.worker do public/
RUN mkdir -p public && node -e "\
  const fs=require('fs'); const path=require('path'); \
  const src=path.join('node_modules','pdfjs-dist','build','pdf.worker.min.js'); \
  const dst=path.join('public','pdf.worker.min.js'); \
  if(!fs.existsSync(src)){ console.error('pdf.worker not found at',src); process.exit(1);} \
  fs.copyFileSync(src,dst); console.log('Copied pdf.worker to public/'); \
"

RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
CMD ["npm", "run", "start"]


