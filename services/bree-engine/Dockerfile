# Multi-stage build
FROM rust:1.78-alpine AS builder

WORKDIR /app

RUN apk add --no-cache musl-dev pkgconfig openssl-dev

COPY Cargo.toml Cargo.lock ./
# Create dummy main to cache dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release
RUN rm -rf src

COPY src/ src/
RUN touch src/main.rs && cargo build --release

# Final stage
FROM alpine:latest

WORKDIR /app

RUN apk --no-cache add ca-certificates tzdata curl

COPY --from=builder /app/target/release/bree-engine .

RUN addgroup -g 1000 app && \
    adduser -D -u 1000 -G app app

USER app

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8081/health || exit 1

EXPOSE 8081 9091

ENV PORT=8081 \
    LOG_LEVEL=info \
    ENVIRONMENT=production

CMD ["./bree-engine"]
