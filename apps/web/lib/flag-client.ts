import { readFile } from "node:fs/promises";
import path from "node:path";
import { OpenFeature, type Client } from "@openfeature/server-sdk";
import { RolloutLabLocalProvider } from "@rolloutlab/evaluator/openfeature";
import { readSnapshot, type SnapshotLoad } from "./flags";

/**
 * Server-side OpenFeature client for the storefront.
 *
 * The provider is registered once per process under its own domain. The
 * snapshot file is re-read on every call and handed to `updateSnapshot`,
 * which only emits a change event when a flag actually changed, so editing
 * the file takes effect on the next page load without a restart.
 */

export const OPENFEATURE_DOMAIN = "storefront";

/** `ROLLOUTLAB_FLAG_SNAPSHOT`, or `flags/development.json` in the web app. */
export function snapshotPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env.ROLLOUTLAB_FLAG_SNAPSHOT?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "flags", "development.json");
}

async function readRaw(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

let provider: RolloutLabLocalProvider | undefined;
let ready: Promise<void> | undefined;

export interface StorefrontFlags {
  client: Client;
  load: SnapshotLoad;
}

export async function loadStorefrontFlags(file: string = snapshotPath()): Promise<StorefrontFlags> {
  const load = readSnapshot(await readRaw(file));
  if (!provider) {
    provider = new RolloutLabLocalProvider(load.snapshot);
    ready = OpenFeature.setProviderAndWait(OPENFEATURE_DOMAIN, provider);
  } else {
    provider.updateSnapshot(load.snapshot);
  }
  await ready;
  return { client: OpenFeature.getClient(OPENFEATURE_DOMAIN), load };
}
