import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "docker-infra-supply-chain",
  kind: "positive",
  defectClass: "supply-chain-curl-pipe-sh",
  description: "Agent adds a RUN step that pipes a remote install script straight into sh with no checksum verification.",
  baseFiles: {
    "Dockerfile": `FROM alpine:3.18
RUN apk add --no-cache curl
COPY app /app
CMD ["/app"]
`,
  },
  headFiles: {
    "Dockerfile": `FROM alpine:3.18
RUN apk add --no-cache curl
RUN curl -sL https://example.com/install.sh | sh
COPY app /app
CMD ["/app"]
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "curl|sh|supply|chain|unverified|checksum|pipe|integrity" },
    ],
    anchorFile: "Dockerfile",
    anchorLineRange: [3, 3],
  },
};

export default spec;
