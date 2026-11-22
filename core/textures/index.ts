/* Procedural textures: ports of js/textures.js on the software Context2D
   (core/raster), the spec registry and the image-id contract. */

export { TEX } from './ids.ts';
export {
  generateImage, clearImageCache, imageCacheSize, specKey, specSize, imageDesc,
  standardImages, generatorOutputs, TEXTURE_GENERATORS
} from './registry.ts';
export type { ImageDescOptions, StandardImagesOptions } from './registry.ts';
export { makeHullMaps } from './hull.ts';
export type { Pond, HullMaps, HullMapsOptions } from './hull.ts';
export { makeDetailTexture, makeLeafTexture } from './nature.ts';
export { makeFacade, makeRoofTexture, makeCarWindows } from './city.ts';
export { makeEndCapTexture, makePanelTexture } from './structures.ts';
export { makeSoftSprite, makeBlobTexture, makeFootprintTexture, makeGlowTexture } from './sprites.ts';
export { makeWaterRoughness, makeWaterNormal } from './water.ts';
export { heightToNormal } from './normals.ts';
export { cityBlock, cityCenter, cellUsable, cellInfo } from './common.ts';
