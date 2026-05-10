/**
 * Resolve the path to the @anthropic-ai/claude-agent-sdk native CLI
 * binary on the current platform.
 *
 * The SDK normally finds this on its own via require.resolve against
 * its optionalDependencies, but Firebase App Hosting's buildpack
 * sometimes ships a runtime image where pnpm symlinks are flattened
 * in ways that break require.resolve, leaving `query()` to throw
 * "Native CLI binary for linux-x64 not found" the first time KA
 * tries to spawn.
 *
 * This helper has two strategies:
 *   1. Try require.resolve first (fastest, works in normal envs).
 *   2. Fall back to a filesystem walk over node_modules/@anthropic-ai/
 *      looking for any claude-agent-sdk-* package and a `claude`
 *      executable inside it. Catches the case where pnpm hoisting
 *      makes the package present on disk but invisible to resolve.
 *
 * Returns undefined when nothing is found — caller should let the
 * SDK fall through to its native error message.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

function tryRequireResolve(): string | undefined {
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const pkg of candidatePackages()) {
    try {
      return require.resolve(`${pkg}/claude${suffix}`);
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Walk up from the current file looking for any node_modules/@anthropic-ai/
 * directory that contains a claude-agent-sdk-* package with the binary.
 * Handles both flat node_modules layouts and pnpm-style nested ones.
 */
function tryFilesystemWalk(): string | undefined {
  const platform = process.platform;
  const suffix = platform === "win32" ? ".exe" : "";
  const target = `claude${suffix}`;
  const archMatcher =
    platform === "linux"
      ? new RegExp(`^claude-agent-sdk-linux-${process.arch}(?:-musl)?$`)
      : new RegExp(`^claude-agent-sdk-${platform}-${process.arch}$`);

  const seen = new Set<string>();

  function scanForAnthropicDirs(start: string): string[] {
    const found: string[] = [];
    let dir = start;
    for (let depth = 0; depth < 10; depth++) {
      const candidate = join(dir, "node_modules", "@anthropic-ai");
      if (existsSync(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
      const pnpmDir = join(dir, "node_modules", ".pnpm");
      if (existsSync(pnpmDir) && !seen.has(pnpmDir)) {
        seen.add(pnpmDir);
        // .pnpm holds packages namespaced with `+` in place of `/`.
        try {
          for (const entry of readdirSync(pnpmDir)) {
            if (!entry.startsWith("@anthropic-ai+claude-agent-sdk")) continue;
            const inner = join(pnpmDir, entry, "node_modules", "@anthropic-ai");
            if (existsSync(inner)) found.push(inner);
          }
        } catch {
          // ignore
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return found;
  }

  // dirname of import.meta.url's file. Walk up from there + cwd as a
  // backup for environments where __dirname semantics differ.
  const startDirs = new Set<string>();
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    startDirs.add(here);
  } catch {
    // ignore
  }
  startDirs.add(process.cwd());

  for (const start of startDirs) {
    for (const anthropicDir of scanForAnthropicDirs(start)) {
      try {
        for (const entry of readdirSync(anthropicDir)) {
          if (!archMatcher.test(entry)) continue;
          const candidate = join(anthropicDir, entry, target);
          try {
            const st = statSync(candidate);
            if (st.isFile()) return candidate;
          } catch {
            // missing — try next
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

let cached: string | undefined | null = null;

export function resolveClaudeCodeBinary(): string | undefined {
  if (cached !== null) return cached;
  cached = tryRequireResolve() ?? tryFilesystemWalk();
  if (cached) {
    // Debug-level so cold-start logs don't get noisy in App Hosting once
    // resolution is stable. Promote back to log if a regression appears.
    console.debug("[claude-binary] resolved:", cached);
  } else {
    console.warn(
      "[claude-binary] could not resolve native CLI binary on",
      process.platform,
      process.arch,
    );
  }
  return cached;
}
