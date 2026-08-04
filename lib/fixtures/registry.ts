// Virtual asset registry.
//
// Virtual assets are not stored in D1. They exist so the console can be opened
// and driven without saving anything, and so a historical event can be replayed
// deterministically.
//
// Adding a virtual asset is a data change here, not a control-flow change in
// every route.

import type { Asset, BoundingBox } from "../domain/types";
import {
  CAMP_FIRE_ASSET,
  CAMP_FIRE_BBOX,
  CAMP_FIRE_REFERENCE_INSTANT,
  createCampFireFixture,
} from "./camp-fire";
import { DEMO_ASSET, DEMO_BBOX, createDemoFixture, type DemoFixture } from "./demo";

export interface VirtualAsset {
  asset: Asset;
  bbox: BoundingBox;
  /**
   * Fixed evaluation instant for historical replays. When absent the fixture
   * is anchored to the caller's clock, which is what the live-shaped demo
   * asset wants.
   */
  referenceInstant?: string;
  createFixture: (now: Date) => DemoFixture;
}

/**
 * Order matters: the first entry is what the console selects on load.
 *
 * The Antelope Creek fixture is crosswind, so it opens on a basemap with a
 * radius ring and a dot — no corridor, no isochrones, no arrival. Nothing on
 * that first screen shows what the product does. The Camp Fire replay is the
 * validated case: smoke inbound, the corridor drawn, arrival in 4.2 hours, and
 * a measured comparison against the EPA monitor at the same coordinates.
 * A first screen should be the strongest true thing the product can show.
 */
export const VIRTUAL_ASSETS: readonly VirtualAsset[] = [
  {
    asset: CAMP_FIRE_ASSET,
    bbox: CAMP_FIRE_BBOX,
    referenceInstant: CAMP_FIRE_REFERENCE_INSTANT,
    createFixture: () => createCampFireFixture(),
  },
  {
    asset: DEMO_ASSET,
    bbox: DEMO_BBOX,
    createFixture: (now) => createDemoFixture(now),
  },
];

export function getVirtualAsset(assetId: string): VirtualAsset | null {
  return VIRTUAL_ASSETS.find((entry) => entry.asset.id === assetId) ?? null;
}

export function isVirtualAssetId(assetId: string): boolean {
  return getVirtualAsset(assetId) !== null;
}

/**
 * The instant a fixture snapshot should be evaluated at.
 *
 * Historical replays pin this so freshness, staleness and arrival maths are
 * computed against the event rather than against today.
 */
export function fixtureReferenceInstant(assetId: string, now: Date): Date {
  const entry = getVirtualAsset(assetId);
  if (entry?.referenceInstant === undefined) return now;
  const pinned = Date.parse(entry.referenceInstant);
  return Number.isFinite(pinned) ? new Date(pinned) : now;
}
