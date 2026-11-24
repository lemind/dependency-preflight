import * as core from "@actions/core";

if (!process.env.GITHUB_WORKSPACE) {
  core.setFailed("GITHUB_WORKSPACE is required");
} else {
  core.setFailed("dependency-preflight is not implemented yet");
}
