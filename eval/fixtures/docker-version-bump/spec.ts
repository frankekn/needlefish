import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "docker-version-bump",
  kind: "negative",
  defectClass: "base-image-patch-bump",
  description: "The base image is bumped from 20.3.0 to 20.3.1 (patch). No contract change.",
  baseFiles: {
    "Dockerfile": `FROM node:20.3.0
COPY app /app
CMD ["/app"]
`,
  },
  headFiles: {
    "Dockerfile": `FROM node:20.3.1
COPY app /app
CMD ["/app"]
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
