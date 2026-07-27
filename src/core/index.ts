// Pure core: parse a `.env.source`, compile it for an environment, and
// materialize/validate the result against providers. No I/O lives here.
export * from "./types.js";
export * from "./errors.js";
export * from "./path.js";
export * from "./config.js";
export { parseEnvSource } from "./parse.js";
export { compile, type CompileOptions } from "./compile.js";
export { serializeDotenv } from "./dotenv.js";
export { materialize } from "./materialize.js";
export { validate, hasErrors } from "./validate.js";
export {
  diffCompiled,
  isEmptyDelta,
  renderDeltaText,
  renderDeltaMarkdown,
} from "./diff.js";
