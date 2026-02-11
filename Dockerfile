FROM alpine:3.20

ARG PB_VERSION=0.22.17

RUN apk add --no-cache ca-certificates unzip wget
RUN wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip" -O /tmp/pb.zip \
  && unzip /tmp/pb.zip -d /pb \
  && chmod +x /pb/pocketbase \
  && rm /tmp/pb.zip

WORKDIR /pb
EXPOSE 8080

CMD ["./pocketbase", "serve", "--http=0.0.0.0:8080"]
