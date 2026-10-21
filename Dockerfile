# Finans sunucusu + web arayüzü (self-host). Derleme: docker build -t finans-server .

# 1) Web arayüzü
FROM node:20-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
# postinstall (tauri icon) web derlemesinde gerekmez
RUN npm ci --ignore-scripts
COPY index.html vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY public public
COPY src src
# Tanıtım sayfasının indirme bağlantıları bu dosyadan okunur
COPY scripts/release-names.json scripts/release-names.json
RUN npm run build:web

# 2) Sunucu
FROM rust:1-bookworm AS build
WORKDIR /src
COPY crates/finans-core crates/finans-core
COPY crates/finans-server crates/finans-server
RUN cd crates/finans-server && cargo build --release --locked

# 3) Çalışma imajı
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 finans && mkdir /data && chown finans /data
COPY --from=build /src/crates/finans-server/target/release/finans-server /usr/local/bin/finans-server
COPY --from=web /src/dist /app/web
USER finans
ENV FINANS_DATA_DIR=/data FINANS_WEB_DIR=/app/web PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["finans-server", "health"]
CMD ["finans-server"]
