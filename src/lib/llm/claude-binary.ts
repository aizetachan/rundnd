/**
 * Resolve the path to the @anthropic-ai/claude-agent-sdk native CLI
 * binary on the current platform.
 *
 * The SDK normally finds this on its own via require.resolve against
 * its optionalDependencies, but Firebase App Hosting's buildpack
 * sometimes ships the runtime image without the linux-x64 binary
 * resolved correctly, leaving `query()` to throw "Native CLI binary
 * for linux-x64 not found" the first time KA tries to spawn.
 *
 * This helper walks the same set of platform-specific package names
 * the SDK does (linux-x64-musl → linux-x64 → darwin-* → win32-*) and
 * returns the first one that resolves. Pass the result as
 * `options.pathToClaudeCodeExecutable` so the SDK skips its own
 * lookup entirely.
 *
 * Returns undefined when nothing resolves — caller should let the SDK
 * fall through to its native lookup (which will give a clearer error
 * if even the explicit-dep variant is missing).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function candidatePackages(): string[] {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
      `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
    ];
  }
  return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
}

let cached: string | undefined | null = null;

export function resolveClaudeCodeBinary(): string | undefined {
  if (cached !== null) return cached;
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const pkg of candidatePackages()) {
    try {
      cached = require.resolve(`${pkg}/claude${suffix}`);
      return cached;
    } catch {
      // try next
    }
  }
  cached = undefined;
  return undefined;
}
