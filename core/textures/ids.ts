/* ═══════════════════════════════════════════════════════════════════════════
   Texture IDs — CONTRACT shared by core/textures (generators + registry),
   core/scene (MaterialDesc references) and every backend.

   Owner: lead. One id per distinct image the legacy app creates
   (js/textures.js generators as called from js/world.js, js/structures.js,
   js/main.js). Ids are stable across seeds/qualities; the ImageDesc.source
   (TextureSpec) carries seed/size/quality-dependent arguments.
   ═══════════════════════════════════════════════════════════════════════════ */

export const TEX = {
  /* hull — makeHullMaps(size, maskSize, rnd=SEED+7, ponds) */
  hullAlbedo: 'hull.albedo',
  hullMask: 'hull.mask',           // r = water depth, g = grass, b = pavement
  hullNormal: 'hull.normal',       // heightToNormal(hull canvas, NORMALS.hull, Q.normals) — absent when Q.normals = 0
  detail: 'detail',                // makeDetailTexture(SEED+11)
  waterRough: 'water.rough',       // makeWaterRoughness(mask, min(1024, Q.mask)) — path tracer only today
  waterNormal: 'water.normal',     // makeWaterNormal(mask, …, NORMALS.water)    — path tracer only today

  /* city — makeFacade(rnd=SEED+31*(v+1), v), v = 0..3 */
  facade: (v: number): string => `facade.${v}`,
  facadeEmissive: (v: number): string => `facade.${v}.emis`,
  facadeNormal: (v: number): string => `facade.${v}.normal`,
  roof: 'roof',                    // makeRoofTexture(SEED+77)
  roofNormal: 'roof.normal',
  carWindows: 'cars.windows',      // makeCarWindows()

  /* structures */
  panel: 'panel',                  // makePanelTexture(SEED+53)
  panelNormal: 'panel.normal',
  endcap: 'endcap',                // makeEndCapTexture(low ? 512 : 1024, SEED+99).map
  endcapEmissive: 'endcap.emis',
  endcapNormal: 'endcap.normal',

  /* greenery */
  leaf: 'leaf',                    // makeLeafTexture(SEED+61)
  leafNormal: 'leaf.normal',

  /* decals & sprites */
  blob: 'decal.blob',              // makeBlobTexture()
  footprint: 'decal.footprint',    // makeFootprintTexture()
  spriteNav: 'sprite.nav',         // makeSoftSprite(0.5)
  spriteCloud: 'sprite.cloud',     // makeSoftSprite(0)
  spriteMote: 'sprite.mote',       // makeSoftSprite(0.3)
  glow: 'sprite.glow',             // makeGlowTexture()
} as const;
